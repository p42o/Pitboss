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

const POLL_INTERVAL_MS = 60 * 1000; // check every 60s
const { Timestamp, FieldValue } = admin.firestore;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Statuses the watcher acts on. Includes the legacy 'awaiting_results' alias.
const WATCHED = ['vote_open', 'awaiting_results', 'tie_pending', 'generating'];

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
 * Read the closed poll and return per-answer vote counts keyed both by Discord
 * answer id and by answer text (the robust mapping back to our options[]).
 */
async function fetchPollCounts(client, wf) {
  try {
    const channel = await client.channels.fetch(wf.pollChannelId).catch(() => null);
    if (!channel) return { resolved: false };
    const msg = await channel.messages.fetch(wf.pollMessageId).catch(() => null);
    if (!msg || !msg.poll) return { resolved: false };
    const poll = msg.poll;
    const finalized = poll.resultsFinalized === true || (poll.expiresTimestamp && Date.now() >= poll.expiresTimestamp);
    if (!finalized) return { resolved: false };
    const answers = [...poll.answers.values()];
    const byId = {}; const byText = {};
    for (const a of answers) {
      const count = a.voteCount ?? a.votes?.cache?.size ?? 0;
      byId[String(a.id)] = count;
      byText[String(a.text || a.answer || '').trim()] = count;
    }
    return { resolved: true, byId, byText, answerCount: answers.length };
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

  // --- vote closed? ---
  if (wf.status === 'vote_open' || wf.status === 'awaiting_results') {
    if (!wf.pollMessageId || !wf.pollChannelId) return;
    const counts = await fetchPollCounts(client, wf);
    if (!counts.resolved) return;

    // v2 structured path
    if (Array.isArray(wf.options) && wf.options.length) {
      const engOptions = wf.options.map((o) => ({
        ...o,
        startAtUtc: tsToDate(o.startAtUtc, o.isoDate),
        voteCount: counts.byId[String(o.discordAnswerId)] ?? counts.byText[String(o.label || '').trim()] ?? 0,
      }));
      // Sanity: counts should map to our options; if Discord returned a different
      // answer set, surface it rather than silently mispicking.
      if (counts.answerCount && counts.answerCount !== wf.options.length) {
        await surfaceFailure(ctx, { workflowId: wf.id, scope: 'poll', level: 'warning', message: `Poll answer count (${counts.answerCount}) != option count (${wf.options.length}); mapped by id/text.` });
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

async function handleTie(ctx, wf, optionsForWrite, engOptions, res) {
  const { db } = ctx;
  const wfRef = db.collection('vote_workflows').doc(wf.id);
  const tiedEng = engOptions.filter((o) => res.tiedOptionIds.includes(o.id));
  const voteCloseAt = tsToDate(wf.voteCloseAt, wf.voteCloseAt) || new Date();
  const tieDeadlineAt = engine.computeTieDeadline({ voteCloseAt, tiedOptions: tiedEng, graceHours: wf.tieGraceHours || 12, bufferHours: wf.bufferHours || 48 });

  await wfRef.update({
    status: 'tie_pending', options: optionsForWrite,
    tiedOptionIds: res.tiedOptionIds, tieResolvedBy: null,
    tieDeadlineAt: Timestamp.fromDate(tieDeadlineAt),
    tieIsEmpty: !!res.isEmpty,
  });

  // idempotent safety-net job
  await db.collection('scheduled_jobs').doc(`tiesafety_${wf.id}`).set({
    type: 'tie_safety_net', workflowId: wf.id,
    scheduledFor: Timestamp.fromDate(tieDeadlineAt),
    status: 'pending', createdAt: FieldValue.serverTimestamp(), sentAt: null, error: null,
  });

  const noun = res.isEmpty ? 'No votes came in' : `It's a tie (${res.maxVotes} each)`;
  await postCard(ctx, wf, {
    header: `🟰 **POKER NIGHT — TIE BREAK NEEDED**\n${noun}. Tap the winning date below.\n` +
            `If nobody picks by ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }).format(tieDeadlineAt)} CT, I'll auto-pick the earliest.\n` +
            `Workflow: \`${wf.id}\``,
    components: buildTiePickComponents(wf.id, tiedEng),
    fieldKey: 'tieCardMessageId',
  });
  await ctx.writeLog('vote_closed', `Vote ${wf.id.slice(0, 6)} ${res.isEmpty ? 'got no votes' : 'tied'}; posted tie-break card (${res.tiedOptionIds.length} options).`, { workflowId: wf.id });
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

  const header = `⏳ **POKER NIGHT — APPROVAL NEEDED**\n` +
    `Winner: **${wf.winningLabel || wf.winningWeekday || 'unknown'}**\n` +
    `First hand (CT): ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }).format(firstHandDate)}\n` +
    `Workflow: \`${wf.id}\`\n\n— Generated announcement preview —\n${announcementText}`;

  await postCard(ctx, wf, { header, components: [buildApprovalRow(wf.id)], imageUrl, imageBuffer, fieldKey: 'approvalMessageId', statusLog: 'approval_pending' });
}

/** Shared card poster (approval / tie). Resolves the approval channel + persists the message id. */
async function postCard(ctx, wf, { header, components, imageUrl, imageBuffer, fieldKey, statusLog }) {
  const { client, db } = ctx;
  const settings = ctx.settings || (await db.collection('settings').doc('config').get()).data() || {};
  const approvalChannelId = wf.approvalChannelId || settings.approvalChannelId;
  if (!approvalChannelId) {
    return surfaceFailure(ctx, { workflowId: wf.id, scope: 'approval', level: 'error', message: 'No approvalChannelId configured; cannot post card.' });
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
