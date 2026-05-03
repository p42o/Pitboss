// voteWatcher.js — Watches vote_workflows for polls that have closed,
// determines the winning weekday, generates announcement text + image,
// uploads to Imgur, and posts an approval card in the configured #clanker
// channel with Approve / Edit / Decline buttons.

const admin = require('firebase-admin');
const {
  ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder
} = require('discord.js');
const { generateAnnouncementImage } = require('./imageGen');
const { uploadToImgur } = require('./imgur');

const POLL_INTERVAL_MS = 60 * 1000; // check every 60s

const WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/**
 * Parse a label like "Thurs (10/02) @ 7:30 PM CT 🍂" into { weekday: 'Thursday', month: 10, day: 2 }.
 * Returns null if not parseable.
 */
function parseOptionLabel(label) {
  if (!label) return null;
  const wkMap = { mon:'Monday', tue:'Tuesday', tues:'Tuesday', wed:'Wednesday', thu:'Thursday', thur:'Thursday', thurs:'Thursday', fri:'Friday', sat:'Saturday', sun:'Sunday' };
  const wkMatch = label.match(/^(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)/i);
  const dateMatch = label.match(/\((\d{1,2})\/(\d{1,2})\)/);
  if (!dateMatch) return null;
  return {
    weekday: wkMatch ? wkMap[wkMatch[1].toLowerCase()] : null,
    month: parseInt(dateMatch[1]),
    day: parseInt(dateMatch[2])
  };
}

/**
 * Compute first-hand UTC Date from year, month (1-12), day, and a "7:30 PM CT" string.
 */
function computeFirstHandUtc(year, month, day, timeStr) {
  // Parse "7:30 PM CT" or "19:30"
  const m = timeStr.match(/(\d{1,2}):?(\d{0,2})\s*(AM|PM)?/i);
  if (!m) return null;
  let hour = parseInt(m[1]);
  const min = parseInt(m[2] || '0');
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  // Build CT-naive datetime then translate to UTC
  const naive = new Date(Date.UTC(year, month - 1, day, hour, min));
  // Find offset between naive treated as CT and UTC
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(naive);
  const ctY = +parts.find(p => p.type === 'year').value;
  const ctMo = +parts.find(p => p.type === 'month').value;
  const ctD = +parts.find(p => p.type === 'day').value;
  const ctH = +parts.find(p => p.type === 'hour').value;
  const ctMi = +parts.find(p => p.type === 'minute').value;
  const diffMs = naive - new Date(Date.UTC(ctY, ctMo - 1, ctD, ctH, ctMi));
  return new Date(naive.getTime() + diffMs);
}

function buildImagePrompt(firstHandDate) {
  const monthName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long' }).format(firstHandDate);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', day: 'numeric' }).format(firstHandDate);
  return `An atmospheric speakeasy poker den ad for the Shadow Spade Lounge. Vintage 1920s mob aesthetic, gold and black, smoke, playing cards, chips. Incorporate the Shadow Spade Lounge logo prominently. Theme/season fitting ${monthName} ${day}. No text overlays. Cinematic lighting, dramatic shadows, ornate art-deco frame.`;
}

async function generateAnnouncementText(openrouterKey, openrouterModel, firstHandDate, gameTimeStr) {
  if (!openrouterKey) throw new Error('No OpenRouter key configured');
  const monthFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long' });
  const yearFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long' });
  const shortDateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric' });

  const monthName = monthFmt.format(firstHandDate);
  const year = yearFmt.format(firstHandDate);
  const weekday = weekdayFmt.format(firstHandDate);
  const shortDate = shortDateFmt.format(firstHandDate);

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
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://pitboss-92bba.web.app',
      'X-Title': 'Pitboss - Shadow Spade Lounge'
    },
    body: JSON.stringify({
      model: openrouterModel || 'google/gemini-2.0-flash-lite-001',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json();
  let txt = data.choices?.[0]?.message?.content?.trim() || '';
  txt = txt.replace(/^```(\w*)?\s*/i,'').replace(/\s*```$/,'').trim();
  return txt;
}

/**
 * Determine whether the poll has closed and pick the winner.
 * Returns { resolved: boolean, winnerLabel?: string, tied?: boolean }
 */
async function fetchPollResult(client, pollChannelId, pollMessageId) {
  try {
    const channel = await client.channels.fetch(pollChannelId);
    if (!channel) return { resolved: false };
    const msg = await channel.messages.fetch(pollMessageId);
    if (!msg) return { resolved: false };
    const poll = msg.poll;
    if (!poll) return { resolved: false };

    const finalized = poll.resultsFinalized === true || poll.expiresTimestamp && Date.now() >= poll.expiresTimestamp;
    if (!finalized) return { resolved: false };

    // Build votes map
    const answers = [...poll.answers.values()];
    let max = 0;
    let winners = [];
    for (const a of answers) {
      const count = a.voteCount ?? a.votes?.cache?.size ?? 0;
      if (count > max) { max = count; winners = [a]; }
      else if (count === max) winners.push(a);
    }
    if (max === 0) return { resolved: true, tied: true, winnerLabel: null };
    if (winners.length > 1) return { resolved: true, tied: true, winnerLabel: null };
    return { resolved: true, tied: false, winnerLabel: winners[0].text || winners[0].answer };
  } catch (e) {
    console.warn('[voteWatcher] fetchPollResult error:', e.message);
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

/**
 * Process a single workflow that's awaiting results / approval.
 */
async function processWorkflow(client, db, writeLog, wf) {
  const wfRef = db.collection('vote_workflows').doc(wf.id);

  // Status: awaiting_results — check if poll closed
  if (wf.status === 'awaiting_results') {
    if (!wf.pollMessageId || !wf.pollChannelId) return;
    const result = await fetchPollResult(client, wf.pollChannelId, wf.pollMessageId);
    if (!result.resolved) return;

    if (result.tied || !result.winnerLabel) {
      await wfRef.update({ status: 'declined', declineReason: 'Tie or zero votes', declinedAt: admin.firestore.FieldValue.serverTimestamp() });
      await writeLog('vote_closed', `Vote ${wf.id.slice(0,6)} closed with no clear winner. Workflow ended.`, { workflowId: wf.id });
      return;
    }

    const parsed = parseOptionLabel(result.winnerLabel);
    if (!parsed || !parsed.month || !parsed.day) {
      await wfRef.update({ status: 'declined', declineReason: 'Could not parse winner', declinedAt: admin.firestore.FieldValue.serverTimestamp() });
      await writeLog('vote_closed', `Vote ${wf.id.slice(0,6)}: could not parse winning label "${result.winnerLabel}".`, { workflowId: wf.id });
      return;
    }

    const year = wf.year || new Date().getFullYear();
    const gameTime = wf.gameTime || '7:30 PM CT';
    const firstHandUtc = computeFirstHandUtc(year, parsed.month, parsed.day, gameTime);

    await wfRef.update({
      status: 'generating',
      winningWeekday: parsed.weekday,
      winningLabel: result.winnerLabel,
      computedFirstHandUtc: admin.firestore.Timestamp.fromDate(firstHandUtc)
    });
    await writeLog('vote_closed', `Vote ${wf.id.slice(0,6)} closed. Winner: ${result.winnerLabel}.`, { workflowId: wf.id });

    // Generation
    await generateAndPostApproval(client, db, writeLog, { ...wf, status: 'generating', winningWeekday: parsed.weekday, computedFirstHandUtc: { toDate: () => firstHandUtc } });
    return;
  }

  if (wf.status === 'generating') {
    // Resume in case bot crashed mid-generation
    await generateAndPostApproval(client, db, writeLog, wf);
  }
}

async function generateAndPostApproval(client, db, writeLog, wf) {
  const wfRef = db.collection('vote_workflows').doc(wf.id);
  const settingsSnap = await db.collection('settings').doc('config').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};

  const firstHandDate = wf.computedFirstHandUtc?.toDate ? wf.computedFirstHandUtc.toDate() : new Date(wf.computedFirstHandUtc);
  const gameTime = wf.gameTime || settings.pokerNightDefaults?.firstHandTime || '7:30 PM CT';

  let announcementText = '';
  let imageUrl = null;

  // Generate text
  try {
    announcementText = await generateAnnouncementText(settings.openrouterKey, settings.openrouterModel, firstHandDate, gameTime);
  } catch (e) {
    await writeLog('warning', `Announcement text generation failed (${e.message}); using fallback.`, { workflowId: wf.id });
    const monthName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long' }).format(firstHandDate);
    const year = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(firstHandDate);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long' }).format(firstHandDate);
    const shortDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric' }).format(firstHandDate);
    announcementText = `🃏   ${monthName} ${year} Round Poker Night  ♠️\n\n🗓️ Date: ${weekday}, ${shortDate}\n⏰ Time: ${gameTime}\n🎮 Platform: PokerNow\n💰 Buy-in: $20 min\n🤑  Blinds: 10/20\n\n@everyone\n\n👇🏼  ✅  or ❌  below 👇🏼`;
  }

  // Generate image (graceful fallback if missing keys)
  if (settings.openaiKey && settings.brandLogoUrl) {
    try {
      const buf = await generateAnnouncementImage(settings.openaiKey, settings.brandLogoUrl, buildImagePrompt(firstHandDate));
      await writeLog('image_generated', `Announcement image generated for workflow ${wf.id.slice(0,6)}.`, { workflowId: wf.id });

      if (settings.imgurClientId) {
        try {
          imageUrl = await uploadToImgur(settings.imgurClientId, buf);
          await writeLog('imgur_uploaded', `Image uploaded to Imgur: ${imageUrl}`, { workflowId: wf.id });
        } catch (e) {
          await writeLog('warning', `Imgur upload failed (${e.message}); will attach as Discord file.`, { workflowId: wf.id });
        }
      } else {
        await writeLog('warning', `imgurClientId not set; attaching image as Discord file instead.`, { workflowId: wf.id });
      }
      // Stash buffer for fallback attachment
      wf._generatedImageBuffer = buf;
    } catch (e) {
      await writeLog('warning', `Image generation failed (${e.message}); proceeding text-only.`, { workflowId: wf.id });
    }
  } else {
    await writeLog('warning', `OpenAI key or brandLogoUrl missing — proceeding text-only.`, { workflowId: wf.id });
  }

  // Persist generated content
  await wfRef.update({
    status: 'approval_pending',
    generatedAnnouncementText: announcementText,
    generatedImageUrl: imageUrl || null,
    generatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Post approval card
  const approvalChannelId = wf.approvalChannelId || settings.approvalChannelId;
  if (!approvalChannelId) {
    await writeLog('error', `No approvalChannelId configured for workflow ${wf.id.slice(0,6)}; cannot post approval card.`, { workflowId: wf.id });
    return;
  }
  let approvalChannel;
  try {
    approvalChannel = await client.channels.fetch(approvalChannelId);
  } catch (e) {
    await writeLog('error', `Approval channel fetch failed: ${e.message}`, { workflowId: wf.id });
    return;
  }
  if (!approvalChannel || !approvalChannel.isTextBased()) {
    await writeLog('error', `Approval channel invalid for workflow ${wf.id.slice(0,6)}.`, { workflowId: wf.id });
    return;
  }

  const row = buildApprovalRow(wf.id);
  const header = `⏳ **POKER NIGHT — APPROVAL NEEDED**\n` +
                 `Winner: **${wf.winningLabel || wf.winningWeekday || 'unknown'}**\n` +
                 `First hand (CT): ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }).format(firstHandDate)}\n` +
                 `Workflow: \`${wf.id}\`\n` +
                 `\n— Generated announcement preview —\n${announcementText}`;

  const sendOpts = { content: header, components: [row] };
  if (imageUrl) {
    sendOpts.content = `${header}\n\n${imageUrl}`;
  } else if (wf._generatedImageBuffer) {
    sendOpts.files = [new AttachmentBuilder(wf._generatedImageBuffer, { name: 'announcement.png' })];
  }

  let approvalMsg;
  try {
    approvalMsg = await approvalChannel.send(sendOpts);
  } catch (e) {
    await writeLog('error', `Approval card send failed: ${e.message}`, { workflowId: wf.id });
    return;
  }

  await wfRef.update({
    approvalMessageId: approvalMsg.id,
    approvalChannelId
  });
  await writeLog('approval_pending', `Approval card posted in #${approvalChannel.name} for workflow ${wf.id.slice(0,6)}.`, { workflowId: wf.id });
}

/**
 * Start the watcher loop.
 */
function startVoteWatcher(client, db, writeLog) {
  console.log('[voteWatcher] Started, polling every 60s.');

  async function tick() {
    try {
      const snap = await db.collection('vote_workflows')
        .where('status', 'in', ['awaiting_results', 'generating'])
        .get();
      if (snap.empty) return;
      for (const docSnap of snap.docs) {
        const wf = { id: docSnap.id, ...docSnap.data() };
        await processWorkflow(client, db, writeLog, wf).catch(async (e) => {
          console.error('[voteWatcher] workflow error', wf.id, e);
          await writeLog('error', `voteWatcher error on ${wf.id.slice(0,6)}: ${e.message}`, { workflowId: wf.id });
        });
      }
    } catch (e) {
      console.error('[voteWatcher] tick error', e);
    }
  }

  // Run shortly after startup, then on interval
  setTimeout(tick, 5000);
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = {
  startVoteWatcher,
  parseOptionLabel,
  computeFirstHandUtc,
  buildImagePrompt
};
