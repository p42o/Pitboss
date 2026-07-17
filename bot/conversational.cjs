'use strict';
/**
 * conversational.cjs — Pitboss action engine.
 *
 * Lets people @Pitboss in Discord and ask it to DO things, on top of the
 * existing witty chat. One OpenRouter call classifies the message into an
 * intent; recognized ACTIONS are executed against Firestore (the same docs the
 * scheduler/voteWatcher already consume) and answered in Pitboss voice. Anything
 * that isn't a clear action falls through (returns false) to the default reply.
 *
 * Actions handled:
 *   - schedule_reminder / schedule_message → write a `scheduled_jobs` doc the
 *       scheduler picks up (type:'message', source:'pitboss_chat').
 *   - next_game        → read latest live vote_workflow, report first-hand CT time.
 *   - list_scheduled   → summarize up to 5 pending scheduled_jobs.
 *   - chat / low-conf  → return false, index.js does the witty reply.
 *
 * AUTHORIZATION: write-actions (schedule_*) require the author to be
 * settings.approverUserId OR hold Manage Guild / Administrator in the guild.
 * Read-actions (next_game, list_scheduled) are open to anyone.
 *
 * Never throws: any internal error is caught, logged, and returns false so the
 * default chat path still runs.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  INTEGRATION — how index.js should call this (drop into MessageCreate, BEFORE
 *  the default OpenRouter witty-reply block, i.e. right after `settings`/`orKey`
 *  are loaded and the early `if (!orKey)` guard, around line 308):
 *
 *    // top of index.js, with the other requires:
 *    const { handleMention } = require('./conversational.cjs');
 *
 *    // inside Events.MessageCreate, after you have `settings` loaded
 *    // (and after the `if (!orKey) { ...; return; }` guard):
 *    const handledAction = await handleMention({
 *      message, client, db, settings, writeLog, engine
 *    });
 *    if (handledAction) return; // an action was taken — skip the witty reply
 *
 *    // ...existing default witty-reply code continues unchanged below...
 *
 *  `engine` is the already-required ./lib/scheduleEngine.cjs. `settings` is the
 *  settings/config doc data. No other wiring needed.
 * ──────────────────────────────────────────────────────────────────────────
 */

const admin = require('firebase-admin');

const TZ = 'America/Chicago';
const MAX_REPLY = 300;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Clamp a reply to Discord-safe length (Pitboss hard rule: <=300 chars). */
function cap(s) {
  s = String(s || '').trim();
  return s.length > MAX_REPLY ? s.slice(0, MAX_REPLY - 3) + '...' : s;
}

/** Format a Date as a short CT string, e.g. "Fri, Jun 6, 7:30 PM CT". */
function ctShort(d) {
  if (!d || isNaN(+d)) return 'unknown time';
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(d);
  return `${s} CT`;
}

/** The CT wall-clock {year, month(1-12), day, hour, min} for a given UTC instant or "now". */
function ctPartsNow(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => +parts.find((p) => p.type === t).value;
  let hour = get('hour'); if (hour === 24) hour = 0;
  return { year: get('year'), month: get('month'), day: get('day'), hour, min: get('minute') };
}

/**
 * Resolve a channelId from settings.channels by fuzzy name match.
 * Falls back to the message's own channel when nothing matches.
 * @returns {{id:string, name:string}}
 */
function resolveChannel(nameWanted, settings, message) {
  const fallback = { id: message.channel.id, name: message.channel.name || 'this-channel' };
  const channels = Array.isArray(settings.channels) ? settings.channels : [];
  if (!nameWanted || !channels.length) return fallback;

  const want = String(nameWanted).replace(/^#/, '').trim().toLowerCase();
  if (!want) return fallback;

  // exact, then startsWith, then includes.
  const norm = (c) => String(c.name || '').replace(/^#/, '').trim().toLowerCase();
  let hit = channels.find((c) => norm(c) === want)
    || channels.find((c) => norm(c).startsWith(want) || want.startsWith(norm(c)))
    || channels.find((c) => norm(c).includes(want) || want.includes(norm(c)));
  return hit ? { id: hit.id, name: hit.name } : fallback;
}

/**
 * Parse a `when` string into a future Date (interpreted in Central Time).
 * Supports:
 *   - ISO-8601 (with or without offset)
 *   - relative: "in 90 minutes", "in 2 hours", "in 3 days"
 *   - "tomorrow 7pm", "today 6:30pm", "friday 6:30pm CT", bare "7pm" (today/next)
 * Leans on engine.parseClockTime for the clock portion.
 * @returns {Date|null} null if unparseable.
 */
function parseWhen(whenStr, now, engine) {
  if (!whenStr) return null;
  const raw = String(whenStr).trim();
  const lower = raw.toLowerCase();

  // 1) ISO-8601 with an explicit offset/Z — trust it directly.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(lower) && /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return isNaN(+d) ? null : d;
  }

  // 2) Relative: "in N minutes/hours/days" (and a few aliases).
  const rel = lower.match(/in\s+(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|hours?|hrs?|h|days?|d|weeks?|w)\b/);
  if (rel) {
    const n = parseFloat(rel[1]);
    const unit = rel[2];
    let ms = 0;
    if (/^min/.test(unit)) ms = n * 60000;
    else if (/^h/.test(unit)) ms = n * 3600000;
    else if (/^d/.test(unit)) ms = n * 86400000;
    else if (/^w/.test(unit)) ms = n * 604800000;
    if (ms > 0) return new Date(now.getTime() + ms);
  }

  // 3) Day-word + clock time ("tomorrow 7pm", "friday 6:30pm CT", "today 18:00", bare "7pm").
  const ct = ctPartsNow(now);
  let targetY = ct.year, targetM = ct.month, targetD = ct.day; // default: today (CT)
  let dayResolved = false;

  if (/\btomorrow\b/.test(lower)) {
    const t = new Date(Date.UTC(ct.year, ct.month - 1, ct.day + 1));
    targetY = t.getUTCFullYear(); targetM = t.getUTCMonth() + 1; targetD = t.getUTCDate();
    dayResolved = true;
  } else if (/\btoday\b|\btonight\b/.test(lower)) {
    dayResolved = true;
  } else {
    // weekday name → next occurrence (today counts only if time is still ahead; handled below)
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
    if (wd >= 0) {
      const todayDow = new Date(Date.UTC(ct.year, ct.month - 1, ct.day)).getUTCDay();
      let delta = (wd - todayDow + 7) % 7;
      // if it's the same weekday, keep delta 0 and let the past-check below bump a week if needed
      const t = new Date(Date.UTC(ct.year, ct.month - 1, ct.day + delta));
      targetY = t.getUTCFullYear(); targetM = t.getUTCMonth() + 1; targetD = t.getUTCDate();
      dayResolved = true;
    }
  }

  // Clock portion — reuse the engine's tolerant parser.
  let hm;
  try {
    hm = engine && engine.parseClockTime ? engine.parseClockTime(raw) : null;
  } catch (_) {
    hm = null;
  }
  // Require a real time signal (digit + am/pm or a colon) so we don't false-match.
  const hasTimeSignal = /\d/.test(lower) && /(am|pm|:|\bnoon\b|\bmidnight\b)/.test(lower);
  if (/\bnoon\b/.test(lower)) hm = { hour: 12, min: 0 };
  if (/\bmidnight\b/.test(lower)) hm = { hour: 0, min: 0 };
  if (!hm || (!hasTimeSignal && !dayResolved)) return null;

  // Build the CT instant via the engine's DST-correct converter.
  if (!engine || !engine.ctWallClockToUtc) return null;
  let d = engine.ctWallClockToUtc(targetY, targetM, targetD, hm.hour, hm.min);

  // If the resulting instant is in the past and the user didn't pin an explicit
  // future calendar day, roll forward: a bare/today time → tomorrow; a weekday → +7d.
  if (d.getTime() <= now.getTime()) {
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
    const bump = wd >= 0 ? 7 : 1;
    const t = new Date(Date.UTC(targetY, targetM - 1, targetD + bump));
    d = engine.ctWallClockToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), hm.hour, hm.min);
  }

  return isNaN(+d) ? null : d;
}

/** True if the author may perform write-actions (approver OR Manage Guild/Admin). */
function isAuthorized(message, settings) {
  const approverId = settings.approverUserId;
  if (approverId && message.author.id === approverId) return true;
  const member = message.member;
  if (member && member.permissions && typeof member.permissions !== 'string' && member.permissions.has) {
    const { PermissionsBitField } = require('discord.js');
    return member.permissions.has(PermissionsBitField.Flags.Administrator)
      || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
  }
  return false;
}

/**
 * Classify the user's message into an intent via ONE OpenRouter call.
 * @returns {object|null} { action, channel?, when?, content?, confidence } or null on failure.
 */
async function classifyIntent({ userText, settings, now }) {
  const orKey = settings.openrouterKey;
  const orModel = settings.openrouterModel || 'google/gemini-2.0-flash-lite-001';
  if (!orKey) return null;

  const channelNames = (Array.isArray(settings.channels) ? settings.channels : [])
    .map((c) => '#' + String(c.name || '').replace(/^#/, ''))
    .filter(Boolean).join(', ') || '(none configured)';

  const nowCt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(now);

  const system = [
    'You are an intent classifier for a Discord poker-night bot. Read the user message and return ONE JSON object, nothing else.',
    'Schema: { "action": "schedule_reminder"|"schedule_message"|"next_game"|"list_scheduled"|"chat", "channel": string|null, "when": string|null, "content": string|null, "confidence": 0.0-1.0 }',
    'Rules:',
    '- schedule_reminder / schedule_message: user wants the bot to post or remind something at a time. "channel" = the target channel name (or null = current). "when" = an ISO-8601 timestamp OR a short relative phrase like "in 90 minutes" / "tomorrow 7pm" / "friday 6:30pm". "content" = the message text to send.',
    '- next_game: user asks when the next poker game / session is.',
    '- list_scheduled: user asks what is scheduled / queued / upcoming.',
    '- chat: anything else (banter, poker questions, insults, smalltalk). Use this when unsure.',
    `- Current time (Central): ${nowCt}.`,
    `- Available channels: ${channelNames}.`,
    'When resolving "when", prefer a concrete future time. Only set confidence high (>0.7) when the action is unambiguous. Output JSON only.',
  ].join('\n');

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pitboss-92bba.web.app',
        'X-Title': 'Pitboss - Shadow Spade Lounge',
      },
      body: JSON.stringify({
        model: orModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
        max_tokens: 200,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (e) {
    return null;
  }
  if (!res.ok) return null;

  let data;
  try { data = await res.json(); } catch (_) { return null; }
  let txt = data.choices?.[0]?.message?.content?.trim() || '';
  if (!txt) return null;

  // Strip code fences / extract the first {...} block, then parse.
  txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const brace = txt.indexOf('{');
  const lastBrace = txt.lastIndexOf('}');
  if (brace >= 0 && lastBrace > brace) txt = txt.slice(brace, lastBrace + 1);

  let parsed;
  try { parsed = JSON.parse(txt); } catch (_) { return null; }
  if (!parsed || typeof parsed.action !== 'string') return null;
  return parsed;
}

/** Generate a Pitboss-voiced confirmation/answer using the personality model. Falls back to `fallback`. */
async function voiceLine({ settings, instruction, fallback }) {
  const orKey = settings.openrouterKey;
  const orModel = settings.openrouterModel || 'google/gemini-2.0-flash-lite-001';
  const personality = settings.pitbossPersonality
    || "You're Pitboss — off-the-books poker den enforcer. Cold, clipped, profane when earned. Every reply 300 chars MAX. Never break character.";
  if (!orKey) return fallback;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pitboss-92bba.web.app',
        'X-Title': 'Pitboss - Shadow Spade Lounge',
      },
      body: JSON.stringify({
        model: orModel,
        messages: [
          { role: 'system', content: personality + ' Keep it under 280 characters. State the facts given; do not invent times or channels.' },
          { role: 'user', content: instruction },
        ],
        max_tokens: 130,
        temperature: 0.7,
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const line = data.choices?.[0]?.message?.content?.trim();
    return line ? cap(line) : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Main entry point. Returns true if an ACTION was handled (index.js should then
 * skip the default witty reply); false to fall through to the default chat.
 *
 * @param {object}   args
 * @param {import('discord.js').Message} args.message  the triggering message
 * @param {import('discord.js').Client}  args.client   the logged-in client
 * @param {FirebaseFirestore.Firestore}  args.db       firestore handle
 * @param {object} args.settings   settings/config doc data
 * @param {Function} args.writeLog (type, message, metadata) => Promise
 * @param {object} args.engine     ./lib/scheduleEngine.cjs
 * @returns {Promise<boolean>}
 */
async function handleMention({ message, client, db, settings, writeLog, engine }) {
  try {
    settings = settings || {};
    if (!settings.openrouterKey) return false; // no brain → let default path handle (it errors gracefully)

    const userText = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!userText) return false; // empty tag → witty reply path

    const now = new Date();
    const intent = await classifyIntent({ userText, settings, now });
    if (!intent) return false;

    const action = intent.action;
    const confidence = typeof intent.confidence === 'number' ? intent.confidence : 0.5;

    // chat or low-confidence → fall through to default witty reply.
    if (action === 'chat' || confidence < 0.55) return false;

    const log = (type, msg, meta) => { try { return writeLog(type, msg, meta || {}); } catch (_) { return Promise.resolve(); } };

    // ───────── READ ACTIONS (open to anyone) ─────────
    if (action === 'next_game') {
      await message.channel.sendTyping().catch(() => {});
      const game = await readNextGame(db);
      let fallback;
      if (!game) {
        fallback = "No game on the books. Nobody's put chips on the table yet.";
      } else {
        fallback = `Next hand: ${game.label || ctShort(game.firstHand)}${game.firstHand ? ` — ${ctShort(game.firstHand)}` : ''}.`;
      }
      const line = await voiceLine({
        settings,
        instruction: game
          ? `Tell the player when the next poker game is. First hand: ${ctShort(game.firstHand)}${game.label ? ` (${game.label})` : ''}. Status: ${game.status}.`
          : `Tell the player there is no poker game scheduled yet. Nobody has set one up.`,
        fallback,
      });
      await message.reply({ content: cap(line), allowedMentions: { parse: [], repliedUser: true } }).catch(() => {});
      await log('action', `next_game → ${message.author.username}`, { user: message.author.username });
      return true;
    }

    if (action === 'list_scheduled') {
      await message.channel.sendTyping().catch(() => {});
      const jobs = await readPendingJobs(db, 5);
      let fallback;
      if (!jobs.length) {
        fallback = "Nothin' queued. The board's clean.";
      } else {
        const lines = jobs.map((j) => `${j.type === 'reminder' ? 'reminder' : j.type} #${j.channelName} ${ctShort(j.when)}`);
        fallback = cap('On deck: ' + lines.join(' | '));
      }
      const line = await voiceLine({
        settings,
        instruction: jobs.length
          ? `List what's scheduled, terse. Items: ${jobs.map((j) => `${j.type} in #${j.channelName} at ${ctShort(j.when)}`).join('; ')}.`
          : `Tell the player nothing is scheduled. The queue is empty.`,
        fallback,
      });
      await message.reply({ content: cap(line), allowedMentions: { parse: [], repliedUser: true } }).catch(() => {});
      await log('action', `list_scheduled (${jobs.length}) → ${message.author.username}`, { count: jobs.length });
      return true;
    }

    // ───────── WRITE ACTIONS (authorized only) ─────────
    if (action === 'schedule_reminder' || action === 'schedule_message') {
      if (!isAuthorized(message, settings)) {
        const line = await voiceLine({
          settings,
          instruction: `Tell ${message.author.username} they ain't cleared to put jobs on the board. Only the boss or guild admins schedule things. Short and cold.`,
          fallback: "You ain't cleared to put jobs on the board, pal. That's boss-only.",
        });
        await message.reply({ content: cap(line), allowedMentions: { parse: [], repliedUser: true } }).catch(() => {});
        await log('warning', `Unauthorized schedule attempt by ${message.author.username}`, { user: message.author.id });
        return true;
      }

      await message.channel.sendTyping().catch(() => {});
      const when = parseWhen(intent.when, now, engine);
      if (!when) {
        await message.reply(cap("I need a real time. Give it to me straight — like 'in 2 hours', 'tomorrow 7pm', or 'friday 6:30pm'.")).catch(() => {});
        await log('action', `schedule parse-fail (no time) by ${message.author.username}`, { when: intent.when || null });
        return true;
      }
      if (when.getTime() <= now.getTime()) {
        await message.reply(cap("That time's already in the rearview. Pick a moment that ain't already gone.")).catch(() => {});
        await log('action', `schedule parse-fail (past) by ${message.author.username}`, { when: intent.when || null });
        return true;
      }

      const content = (intent.content && String(intent.content).trim())
        || (action === 'schedule_reminder' ? 'Reminder from the Pit.' : null);
      if (!content) {
        await message.reply(cap("Tell me what to say first. I don't post empty paper.")).catch(() => {});
        return true;
      }

      const ch = resolveChannel(intent.channel, settings, message);

      await db.collection('scheduled_jobs').add({
        type: 'message',
        source: 'pitboss_chat',
        channelId: ch.id,
        channelName: ch.name,
        content: cap(content) === content ? content : content.slice(0, 1900), // allow long channel posts; just guard absurd length
        scheduledFor: admin.firestore.Timestamp.fromDate(when),
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sentAt: null,
        error: null,
        requestedBy: message.author.id,
      });

      const fallback = `Done. ${action === 'schedule_reminder' ? 'Reminder' : 'Message'} drops in #${ch.name} ${ctShort(when)}.`;
      const line = await voiceLine({
        settings,
        instruction: `Confirm you scheduled a ${action === 'schedule_reminder' ? 'reminder' : 'message'} to post in #${ch.name} at ${ctShort(when)}. Be cool and brief. Do not change the channel or time.`,
        fallback,
      });
      await message.reply({ content: cap(line), allowedMentions: { parse: [], repliedUser: true } }).catch(() => {});
      await log('action', `${action} → #${ch.name} @ ${ctShort(when)} by ${message.author.username}`, {
        channel: ch.name, when: when.toISOString(), user: message.author.id,
      });
      return true;
    }

    // Unknown action label → fall through.
    return false;
  } catch (e) {
    try {
      console.error('[Pitboss] conversational handleMention error:', e && e.message);
      if (writeLog) await writeLog('error', `conversational handler failed: ${e && e.message}`, {});
    } catch (_) {}
    return false; // never throw — let the default chat path run
  }
}

/**
 * Latest live vote_workflow → next game.
 * Excludes declined/cancelled/complete. Picks the most recently created live one.
 * @returns {Promise<{firstHand:Date|null,label:string|null,status:string}|null>}
 */
async function readNextGame(db) {
  const DEAD = new Set(['declined', 'cancelled', 'canceled', 'complete', 'completed']);
  try {
    let snap;
    try {
      snap = await db.collection('vote_workflows').orderBy('createdAt', 'desc').limit(15).get();
    } catch (_) {
      snap = await db.collection('vote_workflows').limit(50).get(); // no index / no createdAt → unordered scan
    }
    if (snap.empty) return null;

    const toDate = (v) => (v && v.toDate ? v.toDate() : (v ? new Date(v) : null));
    const nowMs = Date.now();
    let bestFuture = null;   // soonest first-hand still in the future (preferred)
    let bestCreated = null;  // most-recently-created live one (fallback)
    for (const doc of snap.docs) {
      const wf = doc.data();
      if (DEAD.has(String(wf.status || '').toLowerCase())) continue;
      const fh = toDate(wf.firstHandAt) || toDate(wf.computedFirstHandUtc);
      const created = toDate(wf.createdAt) || new Date(0);
      const cand = {
        firstHand: fh,
        label: wf.winningLabel || null,
        status: wf.status || 'pending',
        _created: created.getTime(),
        _fh: fh ? fh.getTime() : null,
      };
      // Prefer a game whose first hand is in the future; among those, the soonest.
      if (cand._fh != null && cand._fh > nowMs) {
        if (!bestFuture || cand._fh < bestFuture._fh) bestFuture = cand;
      }
      if (!bestCreated || cand._created > bestCreated._created) bestCreated = cand;
    }
    const best = bestFuture || bestCreated;
    if (!best) return null;
    return { firstHand: best.firstHand, label: best.label, status: best.status };
  } catch (_) {
    return null;
  }
}

/**
 * Pending scheduled_jobs, soonest first, up to `limit`.
 * @returns {Promise<Array<{type:string,channelName:string,when:Date}>>}
 */
async function readPendingJobs(db, limit) {
  try {
    let snap;
    try {
      snap = await db.collection('scheduled_jobs')
        .where('status', '==', 'pending')
        .orderBy('scheduledFor', 'asc')
        .limit(limit || 5)
        .get();
    } catch (_) {
      // Missing composite index → fetch pending unordered and sort in memory.
      snap = await db.collection('scheduled_jobs').where('status', '==', 'pending').limit(50).get();
    }
    const toDate = (v) => (v && v.toDate ? v.toDate() : (v ? new Date(v) : null));
    const jobs = snap.docs.map((d) => {
      const j = d.data();
      return {
        type: j.type || 'message',
        channelName: (j.channelName || 'channel').replace(/^#/, ''),
        when: toDate(j.scheduledFor),
      };
    }).filter((j) => j.when && !isNaN(+j.when));
    jobs.sort((a, b) => a.when - b.when);
    return jobs.slice(0, limit || 5);
  } catch (_) {
    return [];
  }
}

module.exports = { handleMention };
