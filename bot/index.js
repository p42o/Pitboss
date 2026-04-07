require('dotenv').config();
const { Client, GatewayIntentBits, ActivityType, Events } = require('discord.js');
const admin = require('firebase-admin');
const { startScheduler } = require('./scheduler');

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
  startHeartbeat(tag);
  await cleanupStalePendingCommands();
  await cleanupOldDocuments();
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

      // Count online members across all guilds
      let onlineCount = 0;
      for (const guild of client.guilds.cache.values()) {
        try {
          const members = await guild.members.fetch();
          onlineCount += members.filter(m =>
            m.presence?.status === 'online' ||
            m.presence?.status === 'idle' ||
            m.presence?.status === 'dnd'
          ).size;
        } catch (_) { /* guild may not be fetchable */ }
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
            const ch = await client.channels.fetch(cmd.payload.channelId).catch(() => null);
            if (ch) {
              await ch.send(cmd.payload.message || '🃏 Pitboss test message ♠️');
              await writeLog('sent', `Test message sent to #${ch.name}`, {});
            }
            await cmdDoc.ref.update({ status: 'completed' });

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

client.on('disconnect', async () => {
  console.warn('[Pitboss] Bot disconnected.');
  await writeLog('connection', 'Bot disconnected from Discord.', {});
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
    const orKey = settings.openrouterKey;
    const orModel = settings.openrouterModel || 'google/gemini-2.0-flash-lite-001';
    const personality = settings.pitbossPersonality || DEFAULT_PERSONALITY;

    if (!orKey) {
      await message.reply("I ain't got a voice right now. Boss needs to configure the OpenRouter key.");
      return;
    }

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

    await message.reply(reply);
    await writeLog('reply', `@${message.author.username} → "${reply.slice(0, 120)}"`, { user: message.author.username, channel: message.channel.name });
  } catch (e) {
    console.error('[Pitboss] Mention reply error:', e.message);
    await writeLog('error', `Mention reply failed: ${e.message}`, {});
    await message.reply("I got nothin'. Come back when the system ain't broke.").catch(() => {});
  }
});

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
