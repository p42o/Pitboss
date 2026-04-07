const admin = require('firebase-admin');

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

    console.log(`[Scheduler] Job ${job.id} completed successfully.`);
  } catch (err) {
    console.error(`[Scheduler] Job ${job.id} failed:`, err.message);

    await docRef.update({
      status: 'failed',
      error: err.message
    });

    await writeLog('error', `Job ${job.id} (${job.type}) failed: ${err.message}`, {
      jobId: job.id,
      channelId: job.channelId
    });
  }
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
    duration: duration || 168 // hours; 168 = 7 days
  };

  await channel.send({ poll: pollPayload });
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
  if (!job.content) throw new Error('No content on table_live job');

  const channel = await client.channels.fetch(job.channelId);
  if (!channel) throw new Error(`Channel ${job.channelId} not found`);

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

  await channel.send({ content: job.content });
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { startScheduler };
