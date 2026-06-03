'use strict';
/**
 * scheduleEngine — Pitboss 2.0 shared scheduling engine.
 *
 * PURE date logic for the monthly poker-night vote. No Firestore, no Discord,
 * no Date.now() inside the functions (callers pass `now`/`triggerAt`) so every
 * function is deterministic and unit-testable.
 *
 * ⚠️ MIRROR FILE: this is kept byte-for-byte identical (except the export
 * footer) to SSL/admin/lib/scheduleEngine.js. Edit BOTH. The parity fixture in
 * scheduleEngine.test.cjs guards against drift.
 *
 * Canonical field-name law (see design blueprint):
 *   option = { id:"opt_YYYY_MM_DD", isoDate, startAtUtc:Date, label, emoji,
 *              weekday, holidayNote, voteCount }
 *
 * The CT->UTC algorithm is preserved verbatim from the original
 * voteWatcher.js computeFirstHandUtc (DST-correct via Intl offset diff).
 */

const TZ = 'America/Chicago';
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DEFAULT_REMINDER_OFFSETS = [1440, 240, 30]; // minutes before first hand: 24h, 4h, 30m

const pad2 = (n) => String(n).padStart(2, '0');

/** Parse "7:30 PM CT" / "19:30" / "7 PM" -> { hour:0-23, min:0-59 }. Throws on garbage. */
function parseClockTime(timeStr) {
  const m = String(timeStr || '').match(/(\d{1,2}):?(\d{0,2})\s*(AM|PM)?/i);
  if (!m) throw new Error(`Unparseable time: "${timeStr}"`);
  let hour = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || min < 0 || min > 59) throw new Error(`Out-of-range time: "${timeStr}"`);
  return { hour, min };
}

/**
 * Convert a Central-Time wall clock (y, m[1-12], d, hour[0-23], min) to the true
 * UTC instant, DST-correct. Preserved from the original computeFirstHandUtc.
 */
function ctWallClockToUtc(year, month, day, hour, min) {
  const naive = new Date(Date.UTC(year, month - 1, day, hour, min));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(naive);
  const get = (t) => +parts.find((p) => p.type === t).value;
  // Intl renders hour 24 as "24" at midnight in some ICU builds; normalize.
  let ctH = get('hour'); if (ctH === 24) ctH = 0;
  const diffMs = naive - new Date(Date.UTC(get('year'), get('month') - 1, get('day'), ctH, get('minute')));
  return new Date(naive.getTime() + diffMs);
}

/** The CT UTC-offset string ("-05:00" CDT / "-06:00" CST) in effect at a UTC instant. */
function ctOffsetString(utcInstant) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(utcInstant).find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-5"
  const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return '+00:00';
  return `${m[1]}${pad2(parseInt(m[2], 10))}:${m[3] || '00'}`;
}

/** Offset-aware ISO string for a CT wall clock, e.g. "2026-06-04T19:30:00-05:00". */
function ctIsoString(year, month, day, hour, min) {
  const utc = ctWallClockToUtc(year, month, day, hour, min);
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:00${ctOffsetString(utc)}`;
}

/** {year, month} of the calendar month after the given one (handles Dec->Jan rollover). */
function nextMonthOf(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/**
 * All dates in (year, month) that fall on `weekday` (0=Sun..6=Sat, default 4=Thu).
 * Returns [{ year, month, day }] in ascending order.
 */
function getCandidateDates(year, month, opts = {}) {
  const weekday = opts.weekday == null ? 4 : opts.weekday;
  const out = [];
  const daysInMonth = new Date(year, month, 0).getDate(); // local-time day count is calendar-correct
  for (let day = 1; day <= daysInMonth; day++) {
    // Use UTC day-of-week to avoid the runner's local tz shifting the weekday.
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday) out.push({ year, month, day });
  }
  return out;
}

const SEASONAL_EMOJI = ['🃏', '♠️', '♣️', '♦️', '♥️', '🎰', '🂡', '🍀'];

/** "Thurs (06/04) @ 7:30 PM CT" — preserves the legacy label format. */
function buildOptionLabel(month, day, weekdayName, gameTime) {
  const abbr = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tues', Wednesday: 'Wed', Thursday: 'Thurs', Friday: 'Fri', Saturday: 'Sat' }[weekdayName] || weekdayName;
  return `${abbr} (${pad2(month)}/${pad2(day)}) @ ${gameTime}`;
}

/**
 * Build structured poll options (the source of truth for dates — bot never
 * re-parses labels). Each option carries its own first-hand instant.
 */
function buildPollOptions(year, month, opts = {}) {
  const gameTime = opts.gameTime || '7:30 PM CT';
  const weekday = opts.weekday == null ? 4 : opts.weekday;
  const emojis = opts.emojis || [];
  const { hour, min } = parseClockTime(gameTime);
  return getCandidateDates(year, month, { weekday }).map((c, i) => {
    const startAtUtc = ctWallClockToUtc(c.year, c.month, c.day, hour, min);
    const weekdayName = WEEKDAY_NAMES[new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay()];
    return {
      id: `opt_${c.year}_${pad2(c.month)}_${pad2(c.day)}`,
      isoDate: ctIsoString(c.year, c.month, c.day, hour, min),
      startAtUtc,
      label: buildOptionLabel(c.month, c.day, weekdayName, gameTime),
      emoji: emojis[i] || SEASONAL_EMOJI[i % SEASONAL_EMOJI.length],
      weekday: weekdayName,
      holidayNote: '',
      voteCount: 0,
    };
  });
}

/** The option with the earliest startAtUtc. */
function earliestOf(options) {
  if (!options || !options.length) return null;
  return options.reduce((a, b) => (a.startAtUtc.getTime() <= b.startAtUtc.getTime() ? a : b));
}

/**
 * Plan the vote window with the buffer invariant:
 *   voteCloseAt <= earliestCandidateAt - bufferHours
 * If the default window would collide, SHORTEN it (down to minWindowHours).
 * If even the minimum window can't fit, return { valid:false, suggestDropEarliest:true }.
 *
 * @returns {voteOpenAt, voteCloseAt, pollDurationHours, windowSuggested,
 *           windowSuggestionReason, earliestCandidateAt, valid, error?}
 */
function planVoteWindow(params) {
  const { triggerAt, options } = params;
  const windowDays = params.windowDays == null ? 7 : params.windowDays;
  const bufferHours = params.bufferHours == null ? 48 : params.bufferHours;
  const minWindowHours = params.minWindowHours == null ? 24 : params.minWindowHours;

  const earliest = earliestOf(options);
  if (!earliest) return { valid: false, error: 'No candidate dates.' };

  const voteOpenAt = new Date(triggerAt.getTime());
  const earliestCandidateAt = earliest.startAtUtc;
  const latestAllowedClose = new Date(earliestCandidateAt.getTime() - bufferHours * 3600000);
  const desiredClose = new Date(voteOpenAt.getTime() + windowDays * 24 * 3600000);

  const base = { voteOpenAt, earliestCandidateAt, bufferHours };

  if (desiredClose.getTime() <= latestAllowedClose.getTime()) {
    return {
      ...base, valid: true, voteCloseAt: desiredClose,
      pollDurationHours: Math.round((desiredClose - voteOpenAt) / 3600000),
      windowSuggested: false, windowSuggestionReason: null,
    };
  }

  // Collision — try to shorten so it closes exactly bufferHours before earliest.
  const shortenedHours = Math.floor((latestAllowedClose - voteOpenAt) / 3600000);
  if (shortenedHours < minWindowHours) {
    return {
      ...base, valid: false, suggestDropEarliest: true,
      error: `Earliest candidate (${earliest.label}) is too soon: a ${minWindowHours}h minimum vote + ${bufferHours}h buffer doesn't fit before it.`,
      attemptedDurationHours: shortenedHours,
    };
  }
  return {
    ...base, valid: true, voteCloseAt: latestAllowedClose,
    pollDurationHours: shortenedHours,
    windowSuggested: true,
    windowSuggestionReason: `A ${windowDays}-day vote would close after the ${bufferHours}h safety buffer before ${earliest.label}; shortened to ${shortenedHours}h.`,
  };
}

/**
 * When the earliest candidate can't fit, drop it (and any others too soon) and
 * replan. Returns { droppedOptionIds, options, plan }.
 */
function replanDroppingEarliest(params) {
  let remaining = [...params.options].sort((a, b) => a.startAtUtc - b.startAtUtc);
  const dropped = [];
  while (remaining.length) {
    const plan = planVoteWindow({ ...params, options: remaining });
    if (plan.valid) return { droppedOptionIds: dropped, options: remaining, plan };
    dropped.push(remaining[0].id);
    remaining = remaining.slice(1);
  }
  return { droppedOptionIds: dropped, options: [], plan: { valid: false, error: 'No candidate date can satisfy the buffer.' } };
}

/**
 * Plan reminder fire-times before first hand. NEVER silently drops: every offset
 * is classified scheduled|skipped with a reason (fixes the silent-drop bug).
 * @returns {scheduled:[{offsetMinutes, fireAt}], skipped:[{offsetMinutes, fireAt, reason}], warnings:[]}
 */
function planReminders(params) {
  const { firstHandAt, now } = params;
  const offsets = params.offsetsMinutes || DEFAULT_REMINDER_OFFSETS;
  const scheduled = [];
  const skipped = [];
  const warnings = [];
  if (firstHandAt.getTime() <= now.getTime()) {
    warnings.push('First hand is in the past — no reminders can fire.');
  }
  for (const off of offsets) {
    const fireAt = new Date(firstHandAt.getTime() - off * 60000);
    if (fireAt.getTime() > now.getTime()) scheduled.push({ offsetMinutes: off, fireAt });
    else skipped.push({ offsetMinutes: off, fireAt, reason: `fire time (${off}m before first hand) already passed` });
  }
  if (skipped.length) warnings.push(`${skipped.length} of ${offsets.length} reminder(s) skipped — too close to game time.`);
  return { scheduled, skipped, warnings };
}

/**
 * Resolve a winner from options carrying voteCount.
 * @returns {winnerOptionId|null, tiedOptionIds:[], maxVotes, isTie, isEmpty}
 *   - clear winner: winnerOptionId set, tiedOptionIds=[], isTie=false
 *   - true tie (>=2 share the max, max>0): winnerOptionId=null, tiedOptionIds=[...], isTie=true
 *   - empty poll (max==0): winnerOptionId=null, tiedOptionIds=ALL, isTie=true, isEmpty=true
 */
function resolveWinningOption(options) {
  if (!options || !options.length) return { winnerOptionId: null, tiedOptionIds: [], maxVotes: 0, isTie: false, isEmpty: true };
  const maxVotes = Math.max(...options.map((o) => o.voteCount || 0));
  const top = options.filter((o) => (o.voteCount || 0) === maxVotes);
  if (maxVotes === 0) return { winnerOptionId: null, tiedOptionIds: options.map((o) => o.id), maxVotes: 0, isTie: true, isEmpty: true };
  if (top.length === 1) return { winnerOptionId: top[0].id, tiedOptionIds: [], maxVotes, isTie: false, isEmpty: false };
  return { winnerOptionId: null, tiedOptionIds: top.map((o) => o.id), maxVotes, isTie: true, isEmpty: false };
}

/**
 * Compute the tie safety-net deadline. Clamped so it ALWAYS fires with lead time:
 * deadline = min(voteCloseAt + graceHours, earliestTiedStart - bufferHours).
 */
function computeTieDeadline(params) {
  const { voteCloseAt, tiedOptions } = params;
  const graceHours = params.graceHours == null ? 12 : params.graceHours;
  const bufferHours = params.bufferHours == null ? 48 : params.bufferHours;
  const earliestTied = earliestOf(tiedOptions);
  const graceDeadline = new Date(voteCloseAt.getTime() + graceHours * 3600000);
  const hardDeadline = new Date(earliestTied.startAtUtc.getTime() - bufferHours * 3600000);
  return new Date(Math.min(graceDeadline.getTime(), hardDeadline.getTime()));
}

/**
 * Build the runoff poll payload + the active option set for a 24h tie-breaker.
 * Used when a vote ties: the bot re-posts a fresh poll containing ONLY the tied
 * options, single-select, running `durationHours` (default 24h) to force a break.
 * @param {Array} tiedOptions  options (with startAtUtc:Date) that tied.
 * @param {Object} opts        { durationHours=24, titlePrefix }
 * @returns { pollData, options, runoffOptionIds }
 */
function buildRunoffPoll(tiedOptions, opts = {}) {
  const durationHours = opts.durationHours == null ? 24 : opts.durationHours;
  const titlePrefix = opts.titlePrefix || 'TIE BREAKER — 24h runoff';
  const options = tiedOptions
    .slice()
    .sort((a, b) => a.startAtUtc.getTime() - b.startAtUtc.getTime())
    .map((o) => ({ ...o, voteCount: 0 }));
  const pollData = {
    title: titlePrefix,
    options: options.map((o) => ({ text: o.label, emoji: o.emoji || '🃏' })),
    multiSelect: false,            // single-select forces a sharper break
    duration: durationHours,
  };
  return { pollData, options, runoffOptionIds: options.map((o) => o.id) };
}

const api = {
  TZ, WEEKDAY_NAMES, MONTH_NAMES, DEFAULT_REMINDER_OFFSETS,
  parseClockTime, ctWallClockToUtc, ctOffsetString, ctIsoString,
  nextMonthOf, getCandidateDates, buildOptionLabel, buildPollOptions,
  earliestOf, planVoteWindow, replanDroppingEarliest, planReminders,
  resolveWinningOption, computeTieDeadline, buildRunoffPoll,
};

module.exports = api;
