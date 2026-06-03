'use strict';

// ============================================================================
// serverStats.cjs — Live Discord server stats collector for the Command Center
// ============================================================================
//
// Gathers a rich snapshot of the primary guild and writes it to Firestore at
// bot_status/stats (merge). The admin Command Center renders this doc.
//
// Mirrors the presence-counting approach in index.js startHeartbeat():
// guild.members.fetch() then filter on m.presence?.status.
//
// ----------------------------------------------------------------------------
// EXACT WRITTEN DOC SHAPE — bot_status/stats (set with { merge: true })
// ----------------------------------------------------------------------------
// {
//   guildId:        string,            // guild snowflake id
//   guildName:      string,            // guild.name
//   memberCount:    number,            // total members (guild.memberCount fallback)
//   humans:         number,            // members where !user.bot
//   bots:           number,            // members where user.bot
//   online:         number,            // presence status === 'online'
//   idle:           number,            // presence status === 'idle'
//   dnd:            number,            // presence status === 'dnd'
//   offline:        number,            // no presence OR status === 'offline'
//   textChannels:   number,            // GuildText + announcement/forum text-ish channels
//   voiceChannels:  number,            // GuildVoice + StageVoice
//   categories:     number,            // GuildCategory channels
//   roles:          number,            // role count (excludes @everyone)
//   emojis:         number,            // custom emoji count
//   boostLevel:     number,            // guild.premiumTier (0-3)
//   boostCount:     number,            // guild.premiumSubscriptionCount
//   createdAt:      number,            // guild.createdTimestamp (ms epoch)
//   newestMembers:  Array<{ username: string, joinedAt: number|null }>, // up to 5, newest first
//   topRoles:       Array<{ name: string, memberCount: number }>,       // up to 6 by member count, excl @everyone
//   collectedBy:    string,            // bot tag (client.user.tag)
//   updatedAt:      Timestamp,         // serverTimestamp() — when this snapshot was written
//   error:          string|undefined   // present only if the whole collection failed catastrophically
// }
//
// Every individual field is wrapped in try/catch and OMITTED if unavailable;
// the collector never throws.
// ============================================================================

const admin = require('firebase-admin');

const COLLECT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolve the primary guild: settings/config serverId|guildId, else first guild.
 */
async function resolvePrimaryGuild(client, db) {
  let targetId = null;
  try {
    const cfg = await db.collection('settings').doc('config').get();
    if (cfg.exists) {
      const d = cfg.data() || {};
      targetId = d.serverId || d.guildId || null;
    }
  } catch (_) { /* settings unreadable — fall back to first guild */ }

  if (targetId) {
    const g = client.guilds.cache.get(targetId);
    if (g) return g;
    try {
      return await client.guilds.fetch(targetId);
    } catch (_) { /* configured id not joinable — fall back */ }
  }
  return client.guilds.cache.first() || null;
}

/**
 * collectServerStats(client, db)
 * Gathers a stats snapshot for the primary guild and writes bot_status/stats (merge).
 * Resilient: each field is independently guarded; never throws.
 * Returns the assembled stats object (without resolving serverTimestamp), or null.
 */
async function collectServerStats(client, db) {
  const guild = await resolvePrimaryGuild(client, db);

  // No guild at all — record a soft error and bail without throwing.
  if (!guild) {
    try {
      await db.collection('bot_status').doc('stats').set({
        error: 'no guild available',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (_) { /* swallow */ }
    return null;
  }

  const stats = {};

  // --- Identity --------------------------------------------------------------
  try { stats.guildId = guild.id; } catch (_) {}
  try { stats.guildName = guild.name; } catch (_) {}
  try { stats.createdAt = guild.createdTimestamp; } catch (_) {}
  try { stats.collectedBy = client.user?.tag || null; } catch (_) {}

  // --- Boost -----------------------------------------------------------------
  try {
    // premiumTier may be an enum number or string label depending on djs version.
    const tier = guild.premiumTier;
    stats.boostLevel = typeof tier === 'number'
      ? tier
      : (parseInt(String(tier).replace(/\D/g, ''), 10) || 0);
  } catch (_) {}
  try { stats.boostCount = guild.premiumSubscriptionCount ?? 0; } catch (_) {}

  // --- Members + presence (mirror startHeartbeat fetch+filter) ---------------
  let members = null;
  try {
    members = await guild.members.fetch();
  } catch (_) { members = null; }

  if (members && members.size) {
    let humans = 0, bots = 0, online = 0, idle = 0, dnd = 0, offline = 0;
    members.forEach(m => {
      try {
        if (m.user?.bot) bots++; else humans++;
      } catch (_) {}
      try {
        const s = m.presence?.status;
        if (s === 'online') online++;
        else if (s === 'idle') idle++;
        else if (s === 'dnd') dnd++;
        else offline++; // undefined presence or explicit 'offline'/'invisible'
      } catch (_) { offline++; }
    });
    stats.memberCount = members.size;
    stats.humans = humans;
    stats.bots = bots;
    stats.online = online;
    stats.idle = idle;
    stats.dnd = dnd;
    stats.offline = offline;

    // --- Newest members (up to 5, newest first) ------------------------------
    try {
      const sorted = [...members.values()]
        .filter(m => m.joinedTimestamp != null)
        .sort((a, b) => b.joinedTimestamp - a.joinedTimestamp)
        .slice(0, 5)
        .map(m => ({
          username: (m.user?.username) || m.displayName || 'unknown',
          joinedAt: m.joinedTimestamp ?? null
        }));
      stats.newestMembers = sorted;
    } catch (_) {}
  } else {
    // Couldn't fetch members — fall back to the cached total.
    try { stats.memberCount = guild.memberCount; } catch (_) {}
  }

  // --- Channels by type ------------------------------------------------------
  try {
    let textChannels = 0, voiceChannels = 0, categories = 0;
    const ch = (guild.channels && guild.channels.cache) || null;
    if (ch) {
      ch.forEach(c => {
        try {
          // discord.js ChannelType enum: 0 GuildText, 2 GuildVoice, 4 GuildCategory,
          // 5 GuildAnnouncement, 13 GuildStageVoice, 15 GuildForum, 16 GuildMedia.
          const t = c.type;
          if (t === 0 || t === 5 || t === 15 || t === 16) textChannels++;
          else if (t === 2 || t === 13) voiceChannels++;
          else if (t === 4) categories++;
        } catch (_) {}
      });
      stats.textChannels = textChannels;
      stats.voiceChannels = voiceChannels;
      stats.categories = categories;
    }
  } catch (_) {}

  // --- Roles -----------------------------------------------------------------
  try {
    const roleCache = (guild.roles && guild.roles.cache) || null;
    if (roleCache) {
      // Exclude @everyone (id === guild.id).
      const real = [...roleCache.values()].filter(r => r.id !== guild.id);
      stats.roles = real.length;

      // --- Top roles by member count (up to 6) -------------------------------
      try {
        stats.topRoles = real
          .map(r => ({ name: r.name, memberCount: (r.members ? r.members.size : 0) }))
          .sort((a, b) => b.memberCount - a.memberCount)
          .slice(0, 6);
      } catch (_) {}
    }
  } catch (_) {}

  // --- Emojis ----------------------------------------------------------------
  try {
    const emojiCache = (guild.emojis && guild.emojis.cache) || null;
    if (emojiCache) stats.emojis = emojiCache.size;
  } catch (_) {}

  // --- Write -----------------------------------------------------------------
  const payload = Object.assign({}, stats, {
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  try {
    await db.collection('bot_status').doc('stats').set(payload, { merge: true });
  } catch (_) {
    // Last-ditch: record the failure without blowing up the caller.
    try {
      await db.collection('bot_status').doc('stats').set({
        error: 'stats write failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (_) { /* swallow */ }
  }

  return stats;
}

/**
 * startServerStats(client, db, writeLog)
 * Runs collectServerStats immediately, then every 10 minutes.
 * Wraps each run in try/catch and reports failures via writeLog('error', ...).
 */
function startServerStats(client, db, writeLog) {
  const log = typeof writeLog === 'function'
    ? writeLog
    : async () => {};

  async function run() {
    try {
      await collectServerStats(client, db);
    } catch (e) {
      console.error('[Pitboss] Server stats error:', e && e.message);
      try {
        await log('error', `Server stats collection failed: ${e && e.message}`, {
          stack: (e && e.stack) || null
        });
      } catch (_) { /* logging itself failed — swallow */ }
    }
  }

  run();
  setInterval(run, COLLECT_INTERVAL_MS);
}

module.exports = { collectServerStats, startServerStats };
