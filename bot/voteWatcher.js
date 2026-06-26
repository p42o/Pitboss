// voteWatcher.js — Watches vote_workflows for polls that have closed, resolves
// the winner from STRUCTURED option metadata (no more label re-parsing),
// handles ties (multi-select availability → most votes → host pick → safety
// net), generates the announcement + image, and posts the approval card.

const admin = require('firebase-admin');
const {
  ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder
} = require('discord.js');
const { generateAnnouncementImage } = require('./imageGen');
const { uploadToImgur } = require('./imgur');
const engine = require('./lib/scheduleEngine.cjs');
const { surfaceFailure } = require('./lib/failures.cjs');
const { scheduleDayOfJobs } = require('./lib/dayOf.cjs');

const POLL_INTERVAL_MS = 60 * 1000; // check every 60s
const { Timestamp, FieldValue } = admin.firestore;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Statuses the watcher acts on. Includes the legacy 'awaiting_results' alias and
// 'tie_runoff' (a tie that's mid-runoff-setup before its poll posts).
const WATCHED = ['vote_open', 'awaiting_results', 'tie_pending', 'tie_runoff', 'generating'];

const tsToDate = (ts, isoFallback) => (ts && ts.toDate ? ts.toDate() : new Date(isoFallback));

// ---- legacy v1 helpers (kept for any pre-2.0 workflow still in flight) -------
function parseOptionLabel(label) {
  if (!label) return null;
  const wkMap = { mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const wkMatch = label.match(/^(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)/i);
  const dateMatch = label.match(/\((\d{1,2})\/(\d{1,2})\)/);
  if (!dateMatch) return null;
  return { weekday: wkMatch ? wkMap[wkMatch[1].toLowerCase()] : null, month: parseInt(dateMatch[1]), day: parseInt(dateMatch[2]) };
}
function computeFirstHandUtc(year, month, day, timeStr) {
  try { const { hour, min } = engine.parseClockTime(timeStr); return engine.ctWallClockToUtc(year, month, day, hour, min); }
  catch (_) { return null; }
}

function buildImagePrompt(firstHandDate) {
  const monthName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long' }).format(firstHandDate);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', day: 'numeric' }).format(firstHandDate);
  return `An atmospheric speakeasy poker den ad for the Shadow Spade Lounge. Vintage 1920s mob aesthetic, gold and black, smoke, playing cards, chips. Incorporate the Shadow Spade Lounge logo prominently. Theme/season fitting ${monthName} ${day}. No text overlays. Cinematic lighting, dramatic shadows, ornate art-deco frame.`;
}

async function generateAnnouncementText(openrouterKey, openrouterModel, firstHandDate, gameTimeStr) {
  if (!openrouterKey) throw new Error('No OpenRouter key configured');
  const f = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', ...opts }).format(firstHandDate);
  const monthName = f({ month: 'long' }), year = f({ year: 'numeric' }), weekday = f({ weekday: 'long' });
  const shortDate = f({ month: 'numeric', day: 'numeric', year: 'numeric' });

  const prompt = `Write a Discord poker night announcement for the Shadow Spade Lounge.

Format EXACTLY (use the literal placeholders' resolved values):

[month-emoji]   ${monthName} ${year} Round Poker Night  [month-emoji-2]

🗓️ Date: ${weekday}, ${shortDate}
⏰ Time: ${gameTimeStr}
🎮 Platform: PokerNow (link drops in #join-the-game ~7 PM)
💰 Buy-in: $20 minimum via Venmo/CashApp
🤑  Blinds: 10/20
📩 Deposit Memo: [a single short whimsical month-themed word, lowercase]

@everyone

👇🏼  ✅  or ❌  below if you think you'll stop by! 👇🏼

Use month-thematic emojis (e.g. 🎃 October, 🎄 December, 🌸 April). Output the announcement text only — no markdown fences, no commentary.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json',
      'HTTP-Referer': 'https://pitboss-92bba.web.app', 'X-Title': 'Pitboss - Shadow Spade Lounge',
    },
    body: JSON.stringify({ model: openrouterModel || 'google/gemini-2.0-flash-lite-001', messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json();
  let txt = data.choices?.[0]?.message?.content?.trim() || '';
  return txt.replace(/^```(\w*)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/**
 * Normalize poll-answer / option text for robust matching.
 * Strips emoji, collapses whitespace, lowercases, drops punctuation that
 * Discord renders inconsistently. Returns a comparable key.
 */
function normalizeAnswerText(s) {
  return String(s == null ? '' : s)
    // strip variation selectors + most emoji / pictographs
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s/:]/g, '') // keep word chars, space, slash, colon (dates/times)
    .trim()
    .toLowerCase();
}

/** Compare two normalized strings tolerant of Discord's ~55-char answer-text truncation. */
function normalizedTextMatch(optText, answerText) {
  const a = normalizeAnswerText(optText);
  const b = normalizeAnswerText(answerText);
  if (!a || !b) return false;
  if (a === b) return true;
  // Discord truncates answer text to ~55 chars; compare on the shorter prefix.
  const n = Math.min(a.length, b.length, 50);
  if (n < 6) return false; // too short to trust a prefix match
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * Read the closed poll and return per-answer vote counts keyed by Discord answer
 * id AND by normalized answer text. Force-refetches the message so voteCount is
 * authoritative (a cached message carries stale/zero counts around close), and
 * falls back to fetchVoters().size when voteCount is null/0 on a finalized poll.
 *
 * Returns: { resolved, byId:{id:count}, byNorm:[{norm,count,id}], byText (legacy),
 *            answerCount, finalized }
 */
async function fetchPollCounts(client, wf) {
  try {
    const channel = await client.channels.fetch(wf.pollChannelId).catch(() => null);
    if (!channel || typeof channel.messages?.fetch !== 'function') return { resolved: false };

    // FORCE refetch — cached message carries stale/zero voteCounts around close.
    let msg = await channel.messages
      .fetch({ message: wf.pollMessageId, force: true })
      .catch(() => null);
    // Fallback to a plain fetch if the forced variant is unsupported/errored.
    if (!msg) msg = await channel.messages.fetch(wf.pollMessageId).catch(() => null);
    if (!msg || !msg.poll) return { resolved: false };

    const poll = msg.poll;
    const finalized =
      poll.resultsFinalized === true ||
      (poll.expiresTimestamp && Date.now() >= poll.expiresTimestamp);
    // Only resolve a finalized poll — pre-close counts are not authoritative.
    if (!finalized) return { resolved: false, finalized: false };

    const answers = [...poll.answers.values()];
    const byId = {};
    const byNorm = [];
    const byText = {}; // legacy v1 back-compat (processLegacyV1 keys on exact trimmed text)

    for (const a of answers) {
      let count = (typeof a.voteCount === 'number') ? a.voteCount : null;

      // Fallback: voteCount null/0 on a finalized poll → count actual voters.
      if (count == null || count === 0) {
        try {
          if (typeof a.fetchVoters === 'function') {
            const voters = await a.fetchVoters();
            const size = voters?.size ?? (Array.isArray(voters) ? voters.length : 0);
            if (size > (count || 0)) count = size;
          }
        } catch (ve) {
          console.warn('[voteWatcher] fetchVoters fallback failed for answer', a.id, ve.message);
        }
      }
      count = count || 0;

      byId[String(a.id)] = count;
      // text/answer differ across djs minor versions; emoji lives on a.emoji
      byNorm.push({ norm: normalizeAnswerText(a.text ?? a.answer ?? ''), count, id: String(a.id) });
      byText[String(a.text ?? a.answer ?? '').trim()] = count;
    }

    return { resolved: true, finalized: true, byId, byNorm, byText, answerCount: answers.length };
  } catch (e) {
    console.warn('[voteWatcher] fetchPollCounts error:', e.message);
    return { resolved: false };
  }
}

function buildApprovalRow(workflowId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pn-approve:${workflowId}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pn-edit:${workflowId}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pn-decline:${workflowId}`).setLabel('Decline').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

/** Tie-pick buttons (pn-pick:<wf>:<optId>), chunked 5 per row, max 5 rows. */
function buildTiePickComponents(workflowId, tiedOptions) {
  const rows = [];
  const short = (o) => (o.label || '').replace(/ @.*/, '').replace(/^\w+ /, '').replace(/[()]/g, '') || o.id;
  for (let i = 0; i < tiedOptions.length && rows.length < 5; i += 5) {
    const row = new ActionRowBuilder();
    for (const o of tiedOptions.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder().setCustomId(`pn-pick:${workflowId}:${o.id}`).setLabel(short(o)).setEmoji(o.emoji || '🃏').setStyle(ButtonStyle.Secondary));
    }
    rows.push(row);
  }
  return rows;
}

async function processWorkflow(ctx, wf) {
  const { client, db } = ctx;
  const wfRef = db.collection('vote_workflows').doc(wf.id);

  // --- resume mid-generation after a crash ---
  if (wf.status === 'generating') return generateAndPostApproval(ctx, wf);

  // --- tie_pending: nothing to do; host tap or the tie_safety_net job resolves it ---
  if (wf.status === 'tie_pending') return;

  // --- tie_runoff: the runoff poll job hasn't posted yet. The scheduler picks up
  // the runoff_<id> 'poll' job within ~30s and flips status to 'vote_open' (where
  // the normal close path resolves it). Nothing to do here — avoids double-spawn. ---
  if (wf.status === 'tie_runoff') return;

  // --- vote closed? ---
  if (wf.status === 'vote_open' || wf.status === 'awaiting_results') {
    if (!wf.pollMessageId || !wf.pollChannelId) return;
    const counts = await fetchPollCounts(client, wf);
    if (!counts.resolved) return;

    // v2 structured path
    if (Array.isArray(wf.options) && wf.options.length) {
      const countForOption = (o) => {
        // 1) authoritative: Discord answer id
        if (o.discordAnswerId != null && counts.byId[String(o.discordAnswerId)] != null) {
          return counts.byId[String(o.discordAnswerId)];
        }
        // 2) robust normalized-text match (strips emoji/case/ws, tolerates 55-char truncation)
        const hit = (counts.byNorm || []).find((b) => normalizedTextMatch(o.label, b.norm));
        return hit ? hit.count : 0;
      };
      const engOptions = wf.options.map((o) => ({
        ...o,
        startAtUtc: tsToDate(o.startAtUtc, o.isoDate),
        voteCount: countForOption(o),
      }));
      // Sanity: counts should map to our options; if Discord returned a different
      // answer set, surface it rather than silently mispicking.
      if (counts.answerCount && counts.answerCount !== wf.options.length) {
        await surfaceFailure(ctx, { workflowId: wf.id, scope: 'poll', level: 'warning', message: `Poll answer count (${counts.answerCount}) != option count (${wf.options.length}); mapped by id/normalized-text.` });
      }
      const optionsForWrite = wf.options.map((o, i) => ({ ...o, voteCount: engOptions[i].voteCount }));
      const res = engine.resolveWinningOption(engOptions);

      if (res.isTie) return handleTie(ctx, wf, optionsForWrite, engOptions, res);

      const winner = engOptions.find((o) => o.id === res.winnerOptionId);
      await wfRef.update({
        status: 'generating', options: optionsForWrite,
        winnerOptionId: winner.id, firstHandAt: Timestamp.fromDate(winner.startAtUtc),
        // legacy display mirrors so existing card/AI code keeps working
        winningLabel: winner.label, winningWeekday: winner.weekday,
        computedFirstHandUtc: Timestamp.fromDate(winner.startAtUtc),
        tieResolvedBy: 'votes',
      });
      await ctx.writeLog('vote_closed', `Vote ${wf.id.slice(0, 6)} closed. Winner: ${winner.label} (${res.maxVotes} votes).`, { workflowId: wf.id });
      return generateAndPostApproval(ctx, { ...wf, status: 'generating', winningLabel: winner.label, winningWeekday: winner.weekday, computedFirstHandUtc: { toDate: () => winner.startAtUtc } });
    }

    // ---- legacy v1 fallback (label parsing) ----
    return processLegacyV1(ctx, wf, counts);
  }
}

/**
 * Tie handler.
 *   Round 1 tie/empty  -> post a fresh 24h Discord runoff poll of ONLY the tied
 *                         options (PRIMARY mechanism), AND keep host-pick buttons
 *                         as an optional manual shortcut.
 *   Round 2 tie/empty  -> no more runoffs: auto-pick earliestOf the tied options.
 */
async function handleTie(ctx, wf, optionsForWrite, engOptions, res) {
  const { db } = ctx;
  const wfRef = db.collection('vote_workflows').doc(wf.id);
  const tiedEng = engOptions.filter((o) => res.tiedOptionIds.includes(o.id));
  const voteCloseAt = tsToDate(wf.voteCloseAt, wf.voteCloseAt) || new Date();

  // If we are ALREADY in a runoff (round >= 2), do NOT spawn another — auto-pick earliest.
  if ((wf.round || 1) >= 2 || wf.status === 'tie_runoff') {
    const winner = engine.earliestOf(tiedEng);
    await wfRef.update({
      status: 'generating', options: optionsForWrite,
      winnerOptionId: winner.id, firstHandAt: Timestamp.fromDate(winner.startAtUtc),
      winningLabel: winner.label, winningWeekday: winner.weekday,
      computedFirstHandUtc: Timestamp.fromDate(winner.startAtUtc),
      tieResolvedBy: 'runoff_auto_earliest', tieResolvedAt: FieldValue.serverTimestamp(),
    });
    await ctx.writeLog('vote_closed', `Runoff for ${wf.id.slice(0, 6)} ${res.isEmpty ? 'got no votes' : 'tied again'}; auto-picked earliest: ${winner.label}.`, { workflowId: wf.id });
    return generateAndPostApproval(ctx, {
      ...wf, status: 'generating', winningLabel: winner.label, winningWeekday: winner.weekday,
      computedFirstHandUtc: { toDate: () => winner.startAtUtc },
    });
  }

  // ----- Round 1: spawn a 24h runoff poll of the tied options -----
  const { pollData, options: runoffOptions, runoffOptionIds } =
    engine.buildRunoffPoll(tiedEng, { durationHours: 24, titlePrefix: '🟰 TIE BREAKER — 24h runoff' });

  const runoffEndsAt = new Date(Date.now() + 24 * 3600 * 1000); // provisional; sendPoll overwrites from real poll

  // (a) flip the workflow into runoff state. The runoff options become the ACTIVE
  // option set so the existing close path resolves the winner from runoff counts.
  await wfRef.update({
    status: 'tie_runoff',
    round: 2,
    options: runoffOptions,                 // active set = tied options only
    parentOptions: optionsForWrite,         // keep round-1 results for the record
    parentVoteCloseAt: Timestamp.fromDate(voteCloseAt),
    runoffOptionIds,
    tiedOptionIds: res.tiedOptionIds,
    tieIsEmpty: !!res.isEmpty,
    runoffEndsAt: Timestamp.fromDate(runoffEndsAt),
    tieResolvedBy: null,
    pollMessageId: null,                    // sendPoll sets the new poll's id + real close
    runoffStartedAt: FieldValue.serverTimestamp(),
  });

  // (b) enqueue the runoff poll. sendPoll posts it AND advances the workflow back
  // to vote_open (writing new pollMessageId / pollChannelId / discordAnswerId /
  // voteCloseAt) via its existing job.workflowId branch.
  await db.collection('scheduled_jobs').doc(`runoff_${wf.id}`).set({
    type: 'poll',
    channelId: wf.pollChannelId,
    channelName: wf.pollChannelName || wf.reminderChannelName || null,
    pollData,
    workflowId: wf.id,
    scheduledFor: Timestamp.now(),          // fire on next scheduler tick (~30s)
    status: 'pending', createdAt: FieldValue.serverTimestamp(), sentAt: null, error: null,
  }, { merge: false });

  // (c) FINAL safety net: if the runoff also ties/empties at ITS close and the
  // watcher is offline, this timer auto-picks earliest. handleTieSafetyNet is
  // runoff-aware (scheduler.js guard broadened to tie_pending/tie_runoff/vote_open).
  // Fire ~30m AFTER the runoff is due to close — NOT clamped by the game buffer
  // (which would land before the runoff even ends and consume the net early).
  const tieDeadlineAt = new Date(runoffEndsAt.getTime() + 30 * 60 * 1000);
  await db.collection('scheduled_jobs').doc(`tiesafety_${wf.id}`).set({
    type: 'tie_safety_net', workflowId: wf.id,
    scheduledFor: Timestamp.fromDate(tieDeadlineAt),
    status: 'pending', createdAt: FieldValue.serverTimestamp(), sentAt: null, error: null,
  });

  // (d) OPTIONAL manual shortcut: host can still tap a date to skip the 24h wait.
  const noun = res.isEmpty ? 'No votes came in' : `It's a tie (${res.maxVotes} each)`;
  await postCard(ctx, wf, {
    header: `🟰 **POKER NIGHT — TIE → 24h RUNOFF**\n${noun}. I just posted a fresh **24-hour runoff poll** in <#${wf.pollChannelId}> with only the tied dates.\n` +
            `Let it ride, or tap a date below to call it now.\n` +
            `Workflow: \`${wf.id}\``,
    components: buildTiePickComponents(wf.id, tiedEng),
    fieldKey: 'tieCardMessageId',
  });

  await ctx.writeLog('vote_closed', `Vote ${wf.id.slice(0, 6)} ${res.isEmpty ? 'got no votes' : 'tied'}; launched 24h runoff (${runoffOptionIds.length} options).`, { workflowId: wf.id });
}

async function processLegacyV1(ctx, wf, counts) {
  const { db } = ctx;
  const wfRef = db.collection('vote_workflows').doc(wf.id);
  // pick max from text map
  const entries = Object.entries(counts.byText);
  let max = -1, winners = [];
  for (const [text, c] of entries) { if (c > max) { max = c; winners = [text]; } else if (c === max) winners.push(text); }
  if (max <= 0 || winners.length !== 1) {
    await wfRef.update({ status: 'declined', declineReason: 'Tie or zero votes (legacy)', declinedAt: FieldValue.serverTimestamp() });
    await surfaceFailure(ctx, { workflowId: wf.id, scope: 'vote', level: 'warning', message: 'Legacy poll closed with no clear winner; workflow ended.' });
    return;
  }
  const parsed = parseOptionLabel(winners[0]);
  if (!parsed || !parsed.month || !parsed.day) {
    await wfRef.update({ status: 'declined', declineReason: 'Could not parse winner', declinedAt: FieldValue.serverTimestamp() });
    await surfaceFailure(ctx, { workflowId: wf.id, scope: 'vote', level: 'error', message: `Legacy winner unparseable: "${winners[0]}".` });
    return;
  }
  const year = wf.year || new Date().getFullYear();
  const firstHandUtc = computeFirstHandUtc(year, parsed.month, parsed.day, wf.gameTime || '7:30 PM CT');
  await wfRef.update({ status: 'generating', winningWeekday: parsed.weekday, winningLabel: winners[0], computedFirstHandUtc: Timestamp.fromDate(firstHandUtc) });
  await ctx.writeLog('vote_closed', `Legacy vote ${wf.id.slice(0, 6)} closed. Winner: ${winners[0]}.`, { workflowId: wf.id });
  return generateAndPostApproval(ctx, { ...wf, status: 'generating', winningWeekday: parsed.weekday, computedFirstHandUtc: { toDate: () => firstHandUtc } });
}

async function generateAndPostApproval(ctx, wf) {
  const { db } = ctx;
  const wfRef = db.collection('vote_workflows').doc(wf.id);
  const settingsSnap = await db.collection('settings').doc('config').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  ctx.settings = settings;

  const firstHandDate = wf.firstHandAt?.toDate ? wf.firstHandAt.toDate()
    : (wf.computedFirstHandUtc?.toDate ? wf.computedFirstHandUtc.toDate() : new Date(wf.computedFirstHandUtc));
  const gameTime = wf.gameTime || settings.pokerNightDefaults?.firstHandTime || '7:30 PM CT';

  let announcementText = '';
  let imageUrl = null;
  let imageBuffer = null;

  try {
    announcementText = await generateAnnouncementText(settings.openrouterKey, settings.openrouterModel, firstHandDate, gameTime);
  } catch (e) {
    await surfaceFailure(ctx, { workflowId: wf.id, scope: 'ai_text', level: 'warning', message: `Announcement text gen failed (${e.message}); using fallback template.` });
    const f = (o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', ...o }).format(firstHandDate);
    announcementText = `🃏   ${f({ month: 'long' })} ${f({ year: 'numeric' })} Round Poker Night  ♠️\n\n🗓️ Date: ${f({ weekday: 'long' })}, ${f({ month: 'numeric', day: 'numeric', year: 'numeric' })}\n⏰ Time: ${gameTime}\n🎮 Platform: PokerNow\n💰 Buy-in: $20 min\n🤑  Blinds: 10/20\n\n@everyone\n\n👇🏼  ✅  or ❌  below 👇🏼`;
  }

  if (settings.openaiKey && settings.brandLogoUrl) {
    try {
      imageBuffer = await generateAnnouncementImage(settings.openaiKey, settings.brandLogoUrl, buildImagePrompt(firstHandDate));
      await ctx.writeLog('image_generated', `Announcement image generated for ${wf.id.slice(0, 6)}.`, { workflowId: wf.id });
      if (settings.imgurClientId) {
        try { imageUrl = await uploadToImgur(settings.imgurClientId, imageBuffer); await ctx.writeLog('imgur_uploaded', `Image uploaded: ${imageUrl}`, { workflowId: wf.id }); }
        catch (e) { await surfaceFailure(ctx, { workflowId: wf.id, scope: 'imgur', level: 'warning', message: `Imgur upload failed (${e.message}); attaching as file.` }); }
      }
    } catch (e) {
      await surfaceFailure(ctx, { workflowId: wf.id, scope: 'ai_image', level: 'warning', message: `Image gen failed (${e.message}); proceeding text-only.` });
    }
  }

  await wfRef.update({
    status: 'approval_pending',
    generatedAnnouncementText: announcementText,
    generatedImageUrl: imageUrl || null,
    generatedAt: FieldValue.serverTimestamp(),
  });

  // ---- hands-free path: auto-approve (per-workflow flag, falling back to the
  // global setting). On any validation failure we fall through to the normal
  // approval card so a human can sort it out. ----
  const autoApprove = wf.autoApprove === true || (wf.autoApprove == null && settings.autoApprove === true);
  if (autoApprove) {
    const done = await tryAutoApprove(ctx, { ...wf, generatedAnnouncementText: announcementText, generatedImageUrl: imageUrl }, firstHandDate)
      .catch(async (e) => { await surfaceFailure(ctx, { workflowId: wf.id, scope: 'auto_approve', level: 'warning', message: `Auto-approve failed (${e.message}); posting the approval card instead.` }); return false; });
    if (done) {
      const header = `✅ **POKER NIGHT — AUTO-APPROVED (hands-free)**\n` +
        `Winner: **${wf.winningLabel || 'unknown'}** — first hand (CT): ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }).format(firstHandDate)}\n` +
        `Announcement is posting now; reminders are scheduled. Edit or cancel any of it from the Command Center.\n\n${announcementText}`;
      await postCard(ctx, wf, { header, components: [], imageUrl, imageBuffer, fieldKey: 'approvalMessageId', statusLog: 'approved' });
      return;
    }
  }

  const header = `⏳ **POKER NIGHT — APPROVAL NEEDED**\n` +
    `Winner: **${wf.winningLabel || wf.winningWeekday || 'unknown'}**\n` +
    `First hand (CT): ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }).format(firstHandDate)}\n` +
    `Workflow: \`${wf.id}\`\n\n— Generated announcement preview —\n${announcementText}`;

  await postCard(ctx, wf, { header, components: [buildApprovalRow(wf.id)], imageUrl, imageBuffer, fieldKey: 'approvalMessageId', statusLog: 'approval_pending' });
}

// Same copy the pn-approve button uses (index.js) — kept in sync.
function reminderTextForOffset(offsetMinutes, gameTime, tableOpenTime) {
  const fh = gameTime || '7:30 PM CT';
  const fhShort = fh.replace(' CT', '');
  const to = (tableOpenTime || '7:00 PM CT').replace(' CT', '');
  if (offsetMinutes >= 1440) return `🃏 Poker night is tomorrow at ${fh}! Hope to see everyone at the tables. 🂡`;
  if (offsetMinutes >= 180) return `🎰 Heads up — Poker Night is in a few hours. First hand at ${fh}. Get your chips ready. ♠️`;
  if (offsetMinutes >= 45) return `♣️ Poker Night is in about an hour — table opens at ${to}, first hand at ${fhShort}.`;
  return `🂡 ${offsetMinutes} minutes out! Table opens at ${to} — first hand at ${fhShort}. @everyone don't be late! ♣️`;
}

/**
 * Hands-free approval. Mirrors the pn-approve button invariants exactly:
 * first hand must be in the future AND after the vote closed; never
 * double-enqueues. Returns true when the workflow was approved + jobs queued.
 */
async function tryAutoApprove(ctx, wf, firstHandDate) {
  const { db } = ctx;
  const wfRef = db.collection('vote_workflows').doc(wf.id);
  const now = new Date();
  if (!firstHandDate || isNaN(+firstHandDate)) return false;
  const voteCloseDate = wf.voteCloseAt && wf.voteCloseAt.toDate ? wf.voteCloseAt.toDate() : null;
  if (firstHandDate <= now || (voteCloseDate && firstHandDate <= voteCloseDate)) return false;
  if (!wf.announceChannelId) return false;

  const existing = await db.collection('scheduled_jobs').where('workflowId', '==', wf.id).get();
  if (existing.docs.some((d) => ['announcement', 'reminder'].includes(d.data().type))) {
    await wfRef.update({ status: 'approved', approvedAt: FieldValue.serverTimestamp(), approvedBy: 'autopilot', approvedSource: 'auto' });
    return true;
  }

  await db.collection('scheduled_jobs').add({
    type: 'announcement', channelId: wf.announceChannelId, channelName: wf.announceChannelName || 'announcements',
    content: wf.generatedAnnouncementText, imageUrl: wf.generatedImageUrl || null,
    scheduledFor: Timestamp.now(), status: 'pending',
    createdAt: FieldValue.serverTimestamp(), workflowId: wf.id, sentAt: null, error: null,
  });
  const offsets = wf.reminderOffsets || engine.DEFAULT_REMINDER_OFFSETS;
  const plan = engine.planReminders({ firstHandAt: firstHandDate, now, offsetsMinutes: offsets });
  const remCh = wf.reminderChannelId || wf.announceChannelId;
  const remName = wf.reminderChannelName || wf.announceChannelName || 'announcements';
  for (const s of plan.scheduled) {
    await db.collection('scheduled_jobs').add({
      type: 'reminder', channelId: remCh, channelName: remName,
      content: reminderTextForOffset(s.offsetMinutes, wf.gameTime, wf.tableOpenTime), offsetMinutes: s.offsetMinutes,
      scheduledFor: Timestamp.fromDate(s.fireAt), status: 'pending',
      createdAt: FieldValue.serverTimestamp(), workflowId: wf.id, sentAt: null, error: null,
    });
  }
  const reminderResults = [
    ...plan.scheduled.map((s) => ({ offsetMinutes: s.offsetMinutes, status: 'scheduled', fireAt: Timestamp.fromDate(s.fireAt) })),
    ...plan.skipped.map((s) => ({ offsetMinutes: s.offsetMinutes, status: 'skipped', reason: s.reason })),
  ];
  await wfRef.update({
    status: 'approved', approvedAt: FieldValue.serverTimestamp(), approvedBy: 'autopilot', approvedSource: 'auto',
    reminderResults, hasSkippedReminders: plan.skipped.length > 0,
  });
  if (plan.skipped.length) {
    await surfaceFailure(ctx, { workflowId: wf.id, scope: 'reminders', level: 'warning', message: `${plan.skipped.length} reminder(s) skipped (too close to game time): ${plan.skipped.map((s) => s.offsetMinutes + 'm').join(', ')}.` });
  }

  // Day-of table automation: morning link nudge + reserved 7:30 PM auto-post.
  let dayOfNote = '';
  try {
    const settings = ctx.settings || (await db.collection('settings').doc('config').get()).data() || {};
    const r = await scheduleDayOfJobs(db, wf, firstHandDate, settings);
    if (r.autoPost || r.nudge) dayOfNote = ` + table auto-open (${[r.nudge && 'morning nudge', r.autoPost && 'auto-post'].filter(Boolean).join(' + ')})`;
  } catch (e) {
    await surfaceFailure(ctx, { workflowId: wf.id, scope: 'table_auto', level: 'warning', message: `Couldn't schedule the day-of table automation: ${e.message}. Go Live manually from the Command Center.` });
  }

  await ctx.writeLog('approved', `Workflow ${wf.id.slice(0, 6)} AUTO-approved — announcement + ${plan.scheduled.length} reminder(s) queued${dayOfNote}.`, { workflowId: wf.id });
  return true;
}

/** Shared card poster (approval / tie). Resolves the approval channel + persists the message id. */
async function postCard(ctx, wf, { header, components, imageUrl, imageBuffer, fieldKey, statusLog }) {
  const { client, db } = ctx;
  const settings = ctx.settings || (await db.collection('settings').doc('config').get()).data() || {};
  // Fall back so the approval/tie card still lands somewhere if no approval channel is
  // set: test channel (admin-ish) → announce channel. (You can also approve from the
  // Command Center's Autopilot card, which needs no channel at all.)
  const approvalChannelId = wf.approvalChannelId || settings.approvalChannelId || settings.testChannelId || wf.announceChannelId;
  if (!approvalChannelId) {
    return surfaceFailure(ctx, { workflowId: wf.id, scope: 'approval', level: 'error', message: 'No approval/test/announce channel configured; cannot post card. Approve from the Command Center instead.' });
  }
  let channel;
  try { channel = await client.channels.fetch(approvalChannelId); } catch (e) {
    return surfaceFailure(ctx, { workflowId: wf.id, scope: 'approval', level: 'error', message: `Approval channel fetch failed: ${e.message}` });
  }
  if (!channel || !channel.isTextBased()) {
    return surfaceFailure(ctx, { workflowId: wf.id, scope: 'approval', level: 'error', message: 'Approval channel invalid.' });
  }
  const sendOpts = { content: header, components };
  if (imageUrl) sendOpts.content = `${header}\n\n${imageUrl}`;
  else if (imageBuffer) sendOpts.files = [new AttachmentBuilder(imageBuffer, { name: 'announcement.png' })];

  let msg;
  try { msg = await channel.send(sendOpts); } catch (e) {
    return surfaceFailure(ctx, { workflowId: wf.id, scope: 'approval', level: 'error', message: `Card send failed: ${e.message}` });
  }
  await db.collection('vote_workflows').doc(wf.id).update({ [fieldKey]: msg.id, approvalChannelId });
  if (statusLog) await ctx.writeLog(statusLog, `Card posted in #${channel.name} for ${wf.id.slice(0, 6)}.`, { workflowId: wf.id });
}

function startVoteWatcher(client, db, writeLog) {
  console.log('[voteWatcher] Started, polling every 60s.');
  const ctx = { client, db, writeLog };

  async function tick() {
    try {
      const snap = await db.collection('vote_workflows').where('status', 'in', WATCHED).get();
      if (snap.empty) return;
      for (const docSnap of snap.docs) {
        const wf = { id: docSnap.id, ...docSnap.data() };
        await processWorkflow(ctx, wf).catch(async (e) => {
          console.error('[voteWatcher] workflow error', wf.id, e);
          await surfaceFailure(ctx, { workflowId: wf.id, scope: 'watcher', level: 'error', message: `voteWatcher error: ${e.message}` });
        });
      }
    } catch (e) {
      console.error('[voteWatcher] tick error', e);
    }
  }

  setTimeout(tick, 5000);
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startVoteWatcher, parseOptionLabel, computeFirstHandUtc, buildImagePrompt };
