const admin = require('firebase-admin');
const { surfaceFailure } = require('./lib/failures.cjs');
const engine = require('./lib/scheduleEngine.cjs');

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

/**
 * Start the Firestore job watcher.
 * Polls every 30 seconds for pending jobs where scheduledFor <= now.
 */
function startScheduler(client, db, writeLog) {
  console.log('[Scheduler] Started. Polling every 30 seconds.');
  writeLog('connection', 'Scheduler started — polling every 30 seconds.', {});

  async function processDueJobs() {
    const now = admin.firestore.Timestamp.now();

    let snapshot;
    try {
      snapshot = await db.collection('scheduled_jobs')
        .where('status', '==', 'pending')
        .where('scheduledFor', '<=', now)
        .get();
    } catch (err) {
      console.error('[Scheduler] Firestore query error:', err.message);
      await writeLog('error', `Scheduler query error: ${err.message}`, {});
      return;
    }

    if (snapshot.empty) return;

    console.log(`[Scheduler] Found ${snapshot.size} due job(s).`);
    await writeLog('scheduled', `Processing ${snapshot.size} due job(s).`, {});

    for (const docSnap of snapshot.docs) {
      const job = { id: docSnap.id, ...docSnap.data() };
      await processJob(client, db, writeLog, job, docSnap.ref);
    }
  }

  // Run immediately, then on interval
  processDueJobs();
  setInterval(processDueJobs, POLL_INTERVAL_MS);
}

/**
 * Process a single scheduled job.
 */
async function processJob(client, db, writeLog, job, docRef) {
  console.log(`[Scheduler] Processing job ${job.id} (type: ${job.type})`);

  // Mark as in-progress to avoid double-processing
  try {
    await docRef.update({ status: 'processing' });
  } catch (e) {
    console.error(`[Scheduler] Could not lock job ${job.id}:`, e.message);
    return;
  }

  try {
    // Internal (non-channel) job: the tie safety-net timer.
    if (job.type === 'tie_safety_net') {
      await handleTieSafetyNet(client, db, writeLog, job);
      await docRef.update({ status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log(`[Scheduler] Job ${job.id} (tie_safety_net) completed.`);
      return;
    }

    if (job.type === 'message' || job.type === 'reminder') {
      await sendMessage(client, job);
    } else if (job.type === 'poll') {
      await sendPoll(client, job, writeLog);
    } else if (job.type === 'announcement') {
      await sendAnnouncement(client, job, writeLog);
    } else if (job.type === 'table_live') {
      await sendTableLive(client, job, writeLog);
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }

    await docRef.update({
      status: 'sent',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const channelLabel = job.channelName ? `#${job.channelName}` : job.channelId;
    await writeLog('sent', `${capitalize(job.type)} sent to ${channelLabel}`, {
      jobId: job.id,
      channelId: job.channelId,
      type: job.type
    });

    // Mark this reminder's result on its workflow (no silent loss).
    if (job.workflowId && job.type === 'reminder') {
      try {
        await db.collection('vote_workflows').doc(job.workflowId).update({
          reminderResults: admin.firestore.FieldValue.arrayUnion({
            jobId: job.id, offsetMinutes: job.offsetMinutes ?? null, status: 'sent', at: admin.firestore.Timestamp.now(),
          }),
        });
      } catch (_) {}
    }

    console.log(`[Scheduler] Job ${job.id} completed successfully.`);
  } catch (err) {
    console.error(`[Scheduler] Job ${job.id} failed:`, err.message);

    await docRef.update({ status: 'failed', error: err.message });

    // No silent failures — surface to Parker + the workflow's failures[].
    let settings = {};
    try { settings = (await db.collection('settings').doc('config').get()).data() || {}; } catch (_) {}
    await surfaceFailure({ db, client, writeLog, settings }, {
      workflowId: job.workflowId, scope: `job_${job.type}`, level: 'error',
      message: `Job ${job.id} (${job.type}) failed: ${err.message}`, meta: { jobId: job.id, channelId: job.channelId || null },
    });
  }
}

/**
 * tie_safety_net — if a tie is still unresolved at the deadline, auto-pick the
 * earliest tied date (preserves maximum lead time) and hand off to generation.
 */
async function handleTieSafetyNet(client, db, writeLog, job) {
  const wfRef = db.collection('vote_workflows').doc(job.workflowId);
  const snap = await wfRef.get();
  if (!snap.exists) return;
  const wf = snap.data();
  // Runoff-aware: the net must catch a tie that's pending, mid-runoff-setup, or in an
  // open runoff poll that never resolved (bot offline through it). Skip only when it's
  // already resolved, or while a runoff poll is still open and not yet expired.
  if (!['tie_pending', 'tie_runoff', 'vote_open'].includes(wf.status)) return; // already resolved
  if (wf.status === 'vote_open' && wf.runoffEndsAt?.toDate && Date.now() < wf.runoffEndsAt.toDate().getTime()) return;

  const tied = (wf.options || [])
    .filter((o) => (wf.tiedOptionIds || []).includes(o.id))
    .map((o) => ({ ...o, startAtUtc: o.startAtUtc && o.startAtUtc.toDate ? o.startAtUtc.toDate() : new Date(o.isoDate) }));
  if (!tied.length) return;

  const winner = engine.earliestOf(tied);
  await wfRef.update({
    status: 'generating',
    winnerOptionId: winner.id,
    firstHandAt: admin.firestore.Timestamp.fromDate(winner.startAtUtc),
    winningLabel: winner.label, winningWeekday: winner.weekday,
    computedFirstHandUtc: admin.firestore.Timestamp.fromDate(winner.startAtUtc),
    tieResolvedBy: 'auto_earliest', tieResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  let settings = {};
  try { settings = (await db.collection('settings').doc('config').get()).data() || {}; } catch (_) {}
  await surfaceFailure({ db, client, writeLog, settings }, {
    workflowId: job.workflowId, scope: 'tie', level: 'warning',
    message: `No host pick in time — auto-selected the earliest tied date: ${winner.label}.`,
  });
}

/**
 * Send a text message to a Discord channel.
 */
async function sendMessage(client, job) {
  if (!job.channelId) throw new Error('No channelId on job');
  if (!job.content) throw new Error('No content on job');

  const channel = await client.channels.fetch(job.channelId);
  if (!channel) throw new Error(`Channel ${job.channelId} not found`);
  if (!channel.isTextBased()) throw new Error(`Channel ${job.channelId} is not a text channel`);

  await channel.send({ content: job.content });
}

/**
 * Send a native Discord poll to a channel.
 * Uses discord.js v14 PollBuilder / MessageCreateOptions with poll field.
 */
async function sendPoll(client, job, writeLog) {
  if (!job.channelId) throw new Error('No channelId on job');
  if (!job.pollData) throw new Error('No pollData on job');

  const channel = await client.channels.fetch(job.channelId);
  if (!channel) throw new Error(`Channel ${job.channelId} not found`);
  if (!channel.isTextBased()) throw new Error(`Channel ${job.channelId} is not a text channel`);

  const { title, options, multiSelect, duration } = job.pollData;

  // Build poll answers array
  // Discord requires: { text: string, emoji?: string }
  const answers = (options || []).map(opt => ({
    text: opt.text || opt.label || '',
    emoji: opt.emoji || undefined
  }));

  if (answers.length === 0) throw new Error('Poll has no options');
  if (answers.length > 10) {
    console.warn('[Scheduler] Poll has more than 10 options; Discord allows max 10. Truncating.');
    await writeLog('warning', `Poll truncated to 10 options (had ${answers.length}).`, {});
    answers.splice(10);
  }

  // discord.js v14.14+ supports native polls via MessageCreateOptions.poll
  const pollPayload = {
    question: { text: title || 'Poker Night Vote' },
    answers,
    allowMultiselect: multiSelect !== false,
    duration: Math.min(duration || 168, 768) // hours; Discord caps polls at 768h (32d)
  };

  const sent = await channel.send({ poll: pollPayload });

  // If this poll is part of a vote workflow, advance the workflow.
  if (job.workflowId) {
    try {
      const db = admin.firestore();
      const wfRef = db.collection('vote_workflows').doc(job.workflowId);
      const wfSnap = await wfRef.get();
      const wfData = wfSnap.exists ? wfSnap.data() : {};

      const update = {
        status: 'vote_open',
        pollMessageId: sent.id,
        pollChannelId: job.channelId,
        pollSentAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Map Discord's answer ids back onto our structured options BY TEXT
      // (Discord does not guarantee send-order == answer id order).
      const sentAnswers = [...(sent.poll && sent.poll.answers && sent.poll.answers.values ? sent.poll.answers.values() : [])];
      const idByText = {};
      for (const a of sentAnswers) idByText[String(a.text || a.answer || '').trim()] = String(a.id);
      if (Array.isArray(wfData.options) && wfData.options.length) {
        update.options = wfData.options.map((o) => ({
          ...o,
          discordAnswerId: idByText[String(o.label || '').trim()] || o.discordAnswerId || null,
        }));
      }

      // Authoritative close time straight from the sent poll.
      const expires = sent.poll && sent.poll.expiresTimestamp;
      const closeTs = expires
        ? admin.firestore.Timestamp.fromMillis(expires)
        : admin.firestore.Timestamp.fromDate(new Date(Date.now() + (duration || 168) * 3600 * 1000));
      update.voteCloseAt = closeTs;
      update.pollClosesAt = closeTs; // legacy mirror

      await wfRef.update(update);
      await writeLog('vote_open', `Vote opened for workflow ${job.workflowId.slice(0,6)}; closes ${closeTs.toDate().toISOString()}.`, { workflowId: job.workflowId });
    } catch (wfErr) {
      console.warn('[Scheduler] Workflow advance failed:', wfErr.message);
      await writeLog('warning', `Failed to advance vote workflow: ${wfErr.message}`, { workflowId: job.workflowId });
    }
  }
}

/**
 * Send an announcement to a Discord channel.
 * Optionally posts an image first, then the announcement, then reacts with ✅ and ❌.
 */
async function sendAnnouncement(client, job, writeLog) {
  if (!job.channelId) throw new Error('No channelId on announcement job');
  if (!job.content) throw new Error('No content on announcement job');

  const channel = await client.channels.fetch(job.channelId);
  if (!channel) throw new Error(`Channel ${job.channelId} not found`);
  if (!channel.isTextBased()) throw new Error(`Channel ${job.channelId} is not a text channel`);

  // Post image first if provided
  if (job.imageUrl) {
    try {
      await channel.send({ content: job.imageUrl });
      await new Promise(r => setTimeout(r, 1500));
    } catch (imgErr) {
      console.warn('[Scheduler] Image post failed, continuing:', imgErr.message);
      await writeLog('warning', `Announcement image post failed: ${imgErr.message}`, {});
    }
  }

  // Post announcement
  const msg = await channel.send({ content: job.content });

  // React with ✅ and ❌
  try {
    await msg.react('✅');
    await msg.react('❌');
  } catch (reactErr) {
    console.warn('[Scheduler] Reaction failed:', reactErr.message);
    await writeLog('warning', `Announcement reaction failed: ${reactErr.message}`, {});
  }
}

/**
 * Handle a "table is live" job — move the join-the-game channel to the active
 * category (making it visible) then post the table link in it.
 */
async function sendTableLive(client, job, writeLog) {
  if (!job.channelId) throw new Error('No channelId on table_live job');

  const channel = await client.channels.fetch(job.channelId);
  if (!channel) throw new Error(`Channel ${job.channelId} not found`);

  // Resolve the message. A manual "Go Live now" bakes the link into job.content;
  // an auto-post job carries no content and instead reads the link the host
  // dropped on the workflow during the day, live at fire time. If the host
  // never set a link, surface a failure (and DON'T post a broken message).
  let content = job.content;
  if (!content && job.workflowId) {
    const db = admin.firestore();
    const snap = await db.collection('vote_workflows').doc(job.workflowId).get();
    const link = snap.exists ? (snap.data().tableLink || '') : '';
    if (!link) throw new Error('Table auto-post fired but no PokerNow link was set in the Command Center. Open the table and post the link manually.');
    content = `🎲 **The table is LIVE!** Join here: ${link}`;
  }
  if (!content) throw new Error('No content on table_live job');

  // Move channel to active category (The Pit) — syncs category permissions
  if (job.activeCategoryId) {
    try {
      await channel.setParent(job.activeCategoryId, { lockPermissions: true });
      console.log(`[Scheduler] Moved #${channel.name} to active category.`);
    } catch (moveErr) {
      console.warn('[Scheduler] Channel category move failed:', moveErr.message);
      await writeLog('warning', `Table channel move failed: ${moveErr.message}`, {});
      // Still post the message even if move fails
    }
  }

  await channel.send({ content });

  // Advance the workflow so the Command Center reflects "live" (the manual
  // path already does this client-side; the auto path needs it server-side).
  if (job.workflowId) {
    try {
      await admin.firestore().collection('vote_workflows').doc(job.workflowId).update({
        status: 'table_live', wentLiveAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}
  }
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { startScheduler };
