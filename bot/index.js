require('dotenv').config();
const { Client, GatewayIntentBits, ActivityType, Events, PermissionsBitField } = require('discord.js');
const admin = require('firebase-admin');
const { startScheduler } = require('./scheduler');
const { startVoteWatcher } = require('./voteWatcher');
const { startServerStats } = require('./serverStats.cjs');
const { startAutopilot } = require('./autopilot.cjs');
const { handleMention } = require('./conversational.cjs');
const engine = require('./lib/scheduleEngine.cjs');
const { surfaceFailure } = require('./lib/failures.cjs');
const { scheduleDayOfJobs } = require('./lib/dayOf.cjs');

// ==================== FIREBASE INIT ====================
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountPath) {
  console.error('[Pitboss] ERROR: FIREBASE_SERVICE_ACCOUNT env var not set. Exiting.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (e) {
  console.error('[Pitboss] ERROR: Could not load Firebase service account JSON:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

// ==================== LOGGING ====================
async function writeLog(type, message, metadata = {}) {
  try {
    await db.collection('logs').add({
      type,
      message,
      metadata,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error('[Pitboss] Log write error:', e.message);
  }
}

// ==================== DISCORD CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const startTime = Date.now();

client.once('ready', async () => {
  const tag = client.user.tag;
  console.log(`[Pitboss] Bot online as ${tag}`);
  client.user.setActivity('the tables', { type: ActivityType.Watching });

  await writeLog('connection', `Bot online as ${tag}`, { tag });
  startScheduler(client, db, writeLog);
  startVoteWatcher(client, db, writeLog);
  startHeartbeat(tag);
  startServerStats(client, db, writeLog);
  startAutopilot(client, db, writeLog);
  await cleanupStalePendingCommands();
  await cleanupOldDocuments();
  // Re-run cleanup daily so logs/commands don't grow unbounded across long pm2 runs.
  setInterval(() => { cleanupOldDocuments().catch(() => {}); }, 24 * 60 * 60 * 1000);
  startCommandWatcher();
});

// ==================== HEARTBEAT ====================
function startHeartbeat(tag) {
  async function beat() {
    try {
      await db.collection('bot_status').doc('heartbeat').set({
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        tag,
        guilds: client.guilds.cache.size
      });

      // Count online members across all guilds from cache (presence/members are
      // already cached via GuildPresences/GuildMembers intents) — no per-minute
      // full member fetch.
      let onlineCount = 0;
      for (const guild of client.guilds.cache.values()) {
        onlineCount += guild.members.cache.filter(m =>
          m.presence?.status === 'online' ||
          m.presence?.status === 'idle' ||
          m.presence?.status === 'dnd'
        ).size;
      }
      await db.collection('bot_status').doc('presence').set({
        onlineCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.error('[Pitboss] Heartbeat error:', e.message);
    }
  }
  beat();
  setInterval(beat, 60000); // 60s interval — halves Firestore write costs vs 30s
}

// ==================== STARTUP CLEANUP ====================
async function cleanupStalePendingCommands() {
  try {
    const snap = await db.collection('bot_commands')
      .where('status', '==', 'pending')
      .get();
    if (snap.empty) return;

    const cutoff = Date.now() - 60000; // commands older than 60s are stale
    const stale = snap.docs.filter(d => {
      const created = d.data().createdAt?.toDate?.();
      return !created || created.getTime() < cutoff;
    });

    if (stale.length === 0) return;

    const batch = db.batch();
    stale.forEach(d => batch.update(d.ref, { status: 'stale' }));
    await batch.commit();
    console.log(`[Pitboss] Marked ${stale.length} stale pending command(s).`);
    await writeLog('warning', `Cleared ${stale.length} stale pending command(s) on startup.`, {});
  } catch (e) {
    console.error('[Pitboss] Failed to cleanup stale commands:', e.message);
  }
}

// Delete bot_commands older than 24h and logs older than 7 days to keep Firestore lean
async function cleanupOldDocuments() {
  try {
    const oneDayAgo = new Date(Date.now() - 86400000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

    const [oldCmds, oldLogs] = await Promise.all([
      db.collection('bot_commands').where('createdAt', '<', oneDayAgo).get(),
      db.collection('logs').where('timestamp', '<', sevenDaysAgo).get()
    ]);

    const toDelete = [...oldCmds.docs, ...oldLogs.docs];
    if (toDelete.length === 0) return;

    // Firestore batch limit is 500
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = db.batch();
      toDelete.slice(i, i + 500).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    console.log(`[Pitboss] Cleaned up ${oldCmds.size} old commands and ${oldLogs.size} old logs.`);
  } catch (e) {
    console.error('[Pitboss] Cleanup error:', e.message);
  }
}

// ==================== COMMAND WATCHER ====================
function startCommandWatcher() {
  let unsubscribe = null;

  function subscribe() {
    if (unsubscribe) {
      try { unsubscribe(); } catch (_) {}
    }
    unsubscribe = db.collection('bot_commands')
      .where('status', '==', 'pending')
      .onSnapshot(async (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const cmdDoc = change.doc;
          const cmd = cmdDoc.data();
          console.log(`[Pitboss] Command received: ${cmd.type}`);

        try {
          if (cmd.type === 'ping') {
            const uptimeSecs = Math.floor((Date.now() - startTime) / 1000);
            const h = Math.floor(uptimeSecs / 3600);
            const m = Math.floor((uptimeSecs % 3600) / 60);
            const s = uptimeSecs % 60;
            const uptime = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
            await cmdDoc.ref.update({
              status: 'done',
              result: { tag: client.user.tag, guilds: client.guilds.cache.size, uptime }
            });

          } else if (cmd.type === 'test_send') {
            try {
              const ch = await client.channels.fetch(cmd.payload.channelId);
              if (!ch || typeof ch.send !== 'function') {
                throw new Error(`Channel ${cmd.payload.channelId} not found or not sendable.`);
              }
              await ch.send(cmd.payload.message || '🃏 Pitboss test message ♠️');
              await writeLog('sent', `Test message sent to #${ch.name}`, {});
              await cmdDoc.ref.update({ status: 'completed' });
            } catch (sendErr) {
              await cmdDoc.ref.update({ status: 'failed', error: sendErr.message });
              await writeLog('error', `Test message failed: ${sendErr.message}`, {});
            }

          } else if (cmd.type === 'status_check') {
            const uptimeSecs = Math.floor((Date.now() - startTime) / 1000);
            const h = Math.floor(uptimeSecs / 3600);
            const m = Math.floor((uptimeSecs % 3600) / 60);
            const s = uptimeSecs % 60;
            const uptime = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
            await cmdDoc.ref.update({
              status: 'completed',
              result: {
                tag: client.user.tag,
                guilds: client.guilds.cache.size,
                uptime
              }
            });

          } else if (cmd.type === 'fetch_channels') {
            const guildId = cmd.payload?.serverId;
            if (!guildId) {
              await cmdDoc.ref.update({ status: 'failed', error: 'No serverId provided.' });
            } else {
              const guild = await client.guilds.fetch(guildId).catch(() => null);
              if (!guild) {
                await cmdDoc.ref.update({ status: 'completed', error: `Bot is not in server ${guildId} or ID is wrong.` });
              } else {
                const channels = await guild.channels.fetch();
                const textChannels = channels
                  .filter(c => c && (c.type === 0 || c.type === 5)) // GUILD_TEXT=0, GUILD_ANNOUNCEMENT=5
                  .map(c => ({ id: c.id, name: c.name }))
                  .sort((a, b) => a.name.localeCompare(b.name));
                await cmdDoc.ref.update({ status: 'completed', result: { channels: textChannels } });
                await writeLog('success', `Fetched ${textChannels.length} channels from "${guild.name}".`, {});
              }
            }

          } else if (cmd.type === 'fetch_categories') {
            const guildId = cmd.payload?.serverId;
            if (!guildId) {
              await cmdDoc.ref.update({ status: 'failed', error: 'No serverId provided.' });
            } else {
              const guild = await client.guilds.fetch(guildId).catch(() => null);
              if (!guild) {
                await cmdDoc.ref.update({ status: 'completed', error: `Bot is not in server ${guildId} or ID is wrong.` });
              } else {
                const channels = await guild.channels.fetch();
                const categories = channels
                  .filter(c => c && c.type === 4) // GUILD_CATEGORY = 4
                  .map(c => ({ id: c.id, name: c.name }))
                  .sort((a, b) => a.name.localeCompare(b.name));
                await cmdDoc.ref.update({ status: 'completed', result: { categories } });
                await writeLog('success', `Fetched ${categories.length} categories from "${guild.name}".`, {});
              }
            }

          } else if (cmd.type === 'restart') {
            await cmdDoc.ref.update({ status: 'completed' });
            await writeLog('warning', 'Bot restarting via dashboard command.', {});
            setTimeout(() => process.exit(0), 500);

          } else {
            await cmdDoc.ref.update({ status: 'unknown_command' });
          }
        } catch (e) {
          console.error(`[Pitboss] Command error (${cmd.type}):`, e.message);
          await cmdDoc.ref.update({ status: 'failed', error: e.message });
        }
      }
    },
    (err) => {
      console.error('[Pitboss] Command watcher disconnected, reconnecting in 5s:', err.message);
      writeLog('error', `Command watcher disconnected: ${err.message}. Reconnecting...`, {}).catch(() => {});
      setTimeout(subscribe, 5000);
    }
  );
  }

  subscribe();
}

client.on('shardDisconnect', async (event, shardId) => {
  console.warn(`[Pitboss] Shard ${shardId} disconnected.`);
  await writeLog('connection', `Bot disconnected from Discord (shard ${shardId}).`, {});
});

client.on('shardResume', async (shardId, replayedEvents) => {
  console.log(`[Pitboss] Shard ${shardId} resumed (${replayedEvents} events replayed).`);
  await writeLog('connection', `Bot reconnected to Discord (shard ${shardId}).`, {});
});

client.on('error', async (err) => {
  console.error('[Pitboss] Discord client error:', err.message);
  await writeLog('error', `Discord client error: ${err.message}`, {});
});

// ==================== MENTION REPLY ====================
const DEFAULT_PERSONALITY = `You're Pitboss — off-the-books poker den enforcer. Talk like a mob boss: cold, clipped, no fluff. You're a poker expert — answer any hand, odds, or scenario correctly. Roast without mercy, swear freely, get vulgar when earned. Hard rule: every reply is 300 chars MAX. Never break character.`;

const mentionCooldowns = new Map(); // userId -> last reply timestamp

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  // Cooldown: 10 seconds per user
  const now = Date.now();
  const last = mentionCooldowns.get(message.author.id) || 0;
  if (now - last < 10000) return;
  mentionCooldowns.set(message.author.id, now);

  try {
    const settingsSnap = await db.collection('settings').doc('config').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const orKey = process.env.OPENROUTER_KEY || settings.openrouterKey;
    const orModel = settings.openrouterModel || 'google/gemini-2.0-flash-lite-001';
    const personality = settings.pitbossPersonality || DEFAULT_PERSONALITY;

    if (!orKey) {
      await message.reply("I ain't got a voice right now. Boss needs to configure the OpenRouter key.");
      return;
    }

    // Action engine: schedule reminder/message, "next game", "what's scheduled".
    // Returns true if it took an action — then skip the default witty reply.
    const handledAction = await handleMention({ message, client, db, settings, writeLog, engine });
    if (handledAction) return;

    const userText = message.content.replace(/<@!?\d+>/g, '').trim();
    const prompt = userText || 'Someone tagged you without saying anything.';

    await message.channel.sendTyping();

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pitboss-92bba.web.app',
        'X-Title': 'Pitboss - Shadow Spade Lounge'
      },
      body: JSON.stringify({
        model: orModel,
        messages: [
          { role: 'system', content: personality },
          { role: 'user', content: `${message.author.username} says: ${prompt}` }
        ],
        max_tokens: 150
      })
    });

    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
    const data = await res.json();
    let reply = data.choices?.[0]?.message?.content?.trim() || "...";

    // Hard cap at 300 chars for Discord safety
    if (reply.length > 300) reply = reply.slice(0, 297) + '...';

    await message.reply({ content: reply, allowedMentions: { parse: [], repliedUser: true } });
    await writeLog('reply', `@${message.author.username} → "${reply.slice(0, 120)}"`, { user: message.author.username, channel: message.channel.name });
  } catch (e) {
    console.error('[Pitboss] Mention reply error:', e.message);
    await writeLog('error', `Mention reply failed: ${e.message}`, {});
    await message.reply("I got nothin'. Come back when the system ain't broke.").catch(() => {});
  }
});

// ==================== APPROVAL BUTTON HANDLER ====================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const id = interaction.customId || '';
  if (!id.startsWith('pn-')) return;

  const parts = id.split(':');
  const action = parts[0];
  const workflowId = parts[1];
  const optionId = parts[2]; // present for pn-pick:<wf>:<optionId>
  if (!workflowId) return;

  // Permission check: bot owner (approverUserId) OR admin perms in this guild OR
  // anyone — fall through to allowing anyone in clanker if no approverUserId set.
  try {
    const settingsSnap = await db.collection('settings').doc('config').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const approverId = settings.approverUserId;

    let allowed = false;
    if (approverId) {
      allowed = interaction.user.id === approverId;
    } else {
      // Allow if member has Manage Guild / Administrator
      const member = interaction.member;
      if (member && typeof member.permissions !== 'string' && member.permissions?.has) {
        allowed = member.permissions.has(PermissionsBitField.Flags.Administrator) ||
                  member.permissions.has(PermissionsBitField.Flags.ManageGuild);
      }
    }
    if (!allowed) {
      await interaction.reply({ content: 'You ain\'t cleared to approve this.', ephemeral: true });
      return;
    }

    const wfRef = db.collection('vote_workflows').doc(workflowId);
    const wfSnap = await wfRef.get();
    if (!wfSnap.exists) {
      await interaction.reply({ content: 'Workflow not found.', ephemeral: true });
      return;
    }
    const wf = wfSnap.data();

    const ctFull = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }).format(d);

    if (action === 'pn-pick') {
      // Tie-break: host chose the winning date — manual shortcut that overrides the
      // 24h runoff. Valid while the tie is pending, mid-runoff-setup, or the runoff
      // poll is open (round >= 2).
      if (!optionId) { await interaction.reply({ content: 'No option specified.', ephemeral: true }); return; }
      const inTie = wf.status === 'tie_pending' || wf.status === 'tie_runoff' ||
        (wf.status === 'vote_open' && (wf.round || 1) >= 2);
      if (!inTie) { await interaction.reply({ content: `Already resolved (${wf.status}).`, ephemeral: true }); return; }
      const opt = (wf.options || []).find((o) => o.id === optionId);
      if (!opt) { await interaction.reply({ content: 'That option is no longer available.', ephemeral: true }); return; }
      // Cancel the safety net + any not-yet-posted runoff poll so nothing fires after the host call.
      await db.collection('scheduled_jobs').doc(`tiesafety_${workflowId}`).delete().catch(() => {});
      await db.collection('scheduled_jobs').doc(`runoff_${workflowId}`).get()
        .then((s) => (s.exists && s.data().status === 'pending')
          ? s.ref.update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() })
          : null)
        .catch(() => {});
      const fh = opt.startAtUtc?.toDate ? opt.startAtUtc.toDate() : new Date(opt.isoDate);
      await wfRef.update({
        status: 'generating', winnerOptionId: opt.id,
        firstHandAt: admin.firestore.Timestamp.fromDate(fh),
        winningLabel: opt.label, winningWeekday: opt.weekday,
        computedFirstHandUtc: admin.firestore.Timestamp.fromDate(fh),
        tieResolvedBy: 'host', tieResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await interaction.update({ content: `🟰 Tie broken — **${opt.label}** selected. Generating the announcement…`, components: [] });
      await writeLog('approved', `Tie resolved by ${interaction.user.tag} → ${opt.label} for ${workflowId.slice(0, 6)}.`, { workflowId });

    } else if (action === 'pn-approve') {
      // Idempotency: never double-approve / double-enqueue.
      if (['approved', 'table_live', 'complete'].includes(wf.status)) {
        await interaction.reply({ content: 'Already approved — nothing more to do.', ephemeral: true });
        return;
      }
      const firstHandDate = wf.firstHandAt?.toDate ? wf.firstHandAt.toDate()
        : (wf.computedFirstHandUtc?.toDate ? wf.computedFirstHandUtc.toDate() : new Date(wf.computedFirstHandUtc));
      if (!firstHandDate || isNaN(+firstHandDate)) {
        await interaction.reply({ content: 'Workflow missing first-hand date.', ephemeral: true });
        return;
      }
      const nowD = new Date();
      const voteCloseDate = wf.voteCloseAt?.toDate ? wf.voteCloseAt.toDate() : null;
      // INVARIANT (the bug fix): first hand must be in the future AND after the vote closed.
      if (firstHandDate <= nowD || (voteCloseDate && firstHandDate <= voteCloseDate)) {
        await wfRef.update({ status: 'edit_mode', editRequestedAt: admin.firestore.FieldValue.serverTimestamp(), editRequestedBy: interaction.user.id });
        await interaction.update({ content: `⛔ Can't approve — first hand (${ctFull(firstHandDate)}) is in the past or before the vote closed. Sent to edit mode.`, components: [] });
        const settings = (await db.collection('settings').doc('config').get()).data() || {};
        await surfaceFailure({ db, client, writeLog, settings }, { workflowId, scope: 'approve', level: 'error', message: 'Approval blocked: first hand is not after both now and the vote close.' });
        return;
      }

      // Double-enqueue guard (single-field index only — no composite needed).
      const existing = await db.collection('scheduled_jobs').where('workflowId', '==', workflowId).get();
      const already = existing.docs.some((d) => ['announcement', 'reminder'].includes(d.data().type));
      if (already) {
        await wfRef.update({ status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp(), approvedBy: interaction.user.id, approvedSource: 'discord_button' });
        await interaction.update({ content: '✅ Jobs were already enqueued — marked approved.', components: [] });
        return;
      }

      // Announcement: send immediately.
      await db.collection('scheduled_jobs').add({
        type: 'announcement', channelId: wf.announceChannelId, channelName: wf.announceChannelName || 'announcements',
        content: wf.generatedAnnouncementText, imageUrl: wf.generatedImageUrl || null,
        scheduledFor: admin.firestore.Timestamp.now(), status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(), workflowId, sentAt: null, error: null,
      });

      // Reminders via the engine — every offset is scheduled OR surfaced, never dropped.
      const offsets = wf.reminderOffsets || engine.DEFAULT_REMINDER_OFFSETS;
      const plan = engine.planReminders({ firstHandAt: firstHandDate, now: nowD, offsetsMinutes: offsets });
      const reminderChannelId = wf.reminderChannelId || wf.announceChannelId;
      const reminderChannelName = wf.reminderChannelName || wf.announceChannelName || 'announcements';
      for (const s of plan.scheduled) {
        await db.collection('scheduled_jobs').add({
          type: 'reminder', channelId: reminderChannelId, channelName: reminderChannelName,
          content: reminderTextForOffset(s.offsetMinutes, wf.gameTime, wf.tableOpenTime), offsetMinutes: s.offsetMinutes,
          scheduledFor: admin.firestore.Timestamp.fromDate(s.fireAt), status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp(), workflowId, sentAt: null, error: null,
        });
      }
      const reminderResults = [
        ...plan.scheduled.map((s) => ({ offsetMinutes: s.offsetMinutes, status: 'scheduled', fireAt: admin.firestore.Timestamp.fromDate(s.fireAt) })),
        ...plan.skipped.map((s) => ({ offsetMinutes: s.offsetMinutes, status: 'skipped', reason: s.reason })),
      ];
      await wfRef.update({
        status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: interaction.user.id, approvedSource: 'discord_button',
        reminderResults, hasSkippedReminders: plan.skipped.length > 0,
      });
      if (plan.skipped.length) {
        const settings = (await db.collection('settings').doc('config').get()).data() || {};
        await surfaceFailure({ db, client, writeLog, settings }, { workflowId, scope: 'reminders', level: 'warning', message: `${plan.skipped.length} reminder(s) skipped (too close to game time): ${plan.skipped.map((s) => s.offsetMinutes + 'm').join(', ')}.` });
      }
      const skipNote = plan.skipped.length ? ` (${plan.skipped.length} skipped — too close)` : '';

      // Day-of table automation: morning link nudge + reserved game-time auto-post.
      let dayOfNote = '';
      try {
        const settings = (await db.collection('settings').doc('config').get()).data() || {};
        const r = await scheduleDayOfJobs(db, { ...wf, id: workflowId }, firstHandDate, settings);
        if (r.autoPost) dayOfNote = `\n🔗 I'll auto-post the PokerNow link${r.nudge ? ' (and nudge you that morning)' : ''} — just drop it in the Command Center.`;
      } catch (e) {
        await surfaceFailure({ db, client, writeLog, settings: {} }, { workflowId, scope: 'table_auto', level: 'warning', message: `Couldn't schedule the day-of table automation: ${e.message}. Go Live manually from the Command Center.` });
      }

      await interaction.update({ content: `✅ **APPROVED** — announcement sending now; ${plan.scheduled.length} reminder(s) scheduled${skipNote}.${dayOfNote}`, components: [] });
      await writeLog('approved', `Workflow ${workflowId.slice(0, 6)} approved by ${interaction.user.tag}.`, { workflowId });

    } else if (action === 'pn-decline') {
      await wfRef.update({
        status: 'declined',
        declinedAt: admin.firestore.FieldValue.serverTimestamp(),
        declinedBy: interaction.user.id,
        declinedSource: 'discord_button'
      });
      await interaction.update({
        content: `❌ **DECLINED** — workflow ${workflowId.slice(0,6)} cancelled.`,
        components: []
      });
      await writeLog('declined', `Workflow ${workflowId.slice(0,6)} declined by ${interaction.user.tag}.`, { workflowId });

    } else if (action === 'pn-edit') {
      await wfRef.update({
        status: 'edit_mode',
        editRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
        editRequestedBy: interaction.user.id
      });
      await interaction.update({
        content: `✏️ **EDIT MODE** — open the dashboard to edit and resubmit. Workflow \`${workflowId}\`.`,
        components: []
      });
      await writeLog('warning', `Workflow ${workflowId.slice(0,6)} sent to edit mode by ${interaction.user.tag}.`, { workflowId });
    }
  } catch (e) {
    console.error('[Pitboss] Approval interaction error:', e);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: `Error: ${e.message}`, ephemeral: true });
      } else {
        await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
      }
    } catch (_) {}
    await writeLog('error', `Approval interaction failed: ${e.message}`, {});
  }
});

// Pick reminder copy by how far out the offset is (works with any offset set).
function reminderTextForOffset(offsetMinutes, gameTime, tableOpenTime) {
  const fh = gameTime || '7:30 PM CT';
  const fhShort = fh.replace(' CT', '');
  const to = (tableOpenTime || '7:00 PM CT').replace(' CT', '');
  if (offsetMinutes >= 1440) return `🃏 Poker night is tomorrow at ${fh}! Hope to see everyone at the tables. 🂡`;
  if (offsetMinutes >= 180) return `🎰 Heads up — Poker Night is in a few hours. First hand at ${fh}. Get your chips ready. ♠️`;
  if (offsetMinutes >= 45) return `♣️ Poker Night is in about an hour — table opens at ${to}, first hand at ${fhShort}.`;
  return `🂡 ${offsetMinutes} minutes out! Table opens at ${to} — first hand at ${fhShort}. @everyone don't be late! ♣️`;
}

// ==================== START ====================
async function resolveToken() {
  // 1. Try environment variable first
  if (process.env.DISCORD_TOKEN) {
    console.log('[Pitboss] Using DISCORD_TOKEN from environment.');
    return process.env.DISCORD_TOKEN;
  }
  // 2. Fall back to Firestore settings/config.discordToken
  try {
    console.log('[Pitboss] No DISCORD_TOKEN env var — checking Firestore settings...');
    const snap = await db.collection('settings').doc('config').get();
    const fsToken = snap.exists ? snap.data().discordToken : null;
    if (fsToken) {
      console.log('[Pitboss] Using discordToken from Firestore settings.');
      return fsToken;
    }
  } catch (e) {
    console.error('[Pitboss] Error reading token from Firestore:', e.message);
  }
  return null;
}

resolveToken().then(async (token) => {
  if (!token) {
    console.error('[Pitboss] ERROR: No Discord token found in env or Firestore. Exiting.');
    await writeLog('error', 'No Discord token found in env or Firestore. Bot cannot start.', {});
    process.exit(1);
  }
  client.login(token).catch(async (err) => {
    console.error('[Pitboss] Login failed:', err.message);
    await writeLog('error', `Bot login failed: ${err.message}`, {});
    process.exit(1);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[Pitboss] Shutting down...');
  await writeLog('connection', 'Bot shutting down (SIGINT).', {});
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[Pitboss] Shutting down (SIGTERM)...');
  await writeLog('connection', 'Bot shutting down (SIGTERM).', {});
  client.destroy();
  process.exit(0);
});
