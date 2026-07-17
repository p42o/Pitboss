// autopilot.cjs — hands-free monthly vote opener.
// When settings/config.autoVoteEnabled is true, the bot opens NEXT month's
// availability poll by itself once "now" is within autoVoteOpenDaysBefore days
// of the current month's end — exactly mirroring what the Command Center's
// "Start the vote" button writes (same workflow + poll-job shape), so the rest
// of the pipeline (voteWatcher → announcement → reminders) needs nothing new.
//
// Idempotency: the workflow doc id is deterministic (auto_<year>_<month>), and
// we also skip if ANY live workflow already targets that month (e.g. Parker
// started it manually). Failures surface once per target month, not every tick.

const admin = require('firebase-admin');
const engine = require('./lib/scheduleEngine.cjs');
const { surfaceFailure } = require('./lib/failures.cjs');

const { Timestamp, FieldValue } = admin.firestore;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 min is plenty for a monthly event

function targetMonth(now = new Date()) {
  // next calendar month (the one we'd be voting on) — rolls at CT midnight,
  // not UTC, so the boundary matches what players actually experience.
  const ct = engine.ctDateParts(now);
  return engine.nextMonthOf(ct.year, ct.month);
}

function voteOpenAt(target, daysBefore) {
  // first instant of the target month (UTC noon to dodge TZ edges) minus N days
  const firstOfTarget = new Date(Date.UTC(target.year, target.month - 1, 1, 12, 0, 0));
  return new Date(firstOfTarget.getTime() - daysBefore * 86400e3);
}

async function alreadyFailedThisMonth(db, key) {
  try {
    const snap = await db.collection('settings').doc('autopilotState').get();
    return snap.exists && snap.data().lastFailKey === key;
  } catch (_) { return false; }
}
async function markFailed(db, key) {
  try { await db.collection('settings').doc('autopilotState').set({ lastFailKey: key, at: FieldValue.serverTimestamp() }, { merge: true }); } catch (_) {}
}

async function tick(ctx) {
  const { db } = ctx;
  const settingsSnap = await db.collection('settings').doc('config').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  ctx.settings = settings;
  if (settings.autoVoteEnabled !== true) return;

  const now = new Date();
  const days = Math.max(2, Math.min(21, parseInt(settings.autoVoteOpenDaysBefore, 10) || 7));
  const tm = targetMonth(now);
  if (now < voteOpenAt(tm, days)) return; // not time yet

  const monthKey = `${tm.year}-${String(tm.month).padStart(2, '0')}`;
  const wfId = `auto_${tm.year}_${tm.month}`;

  // deterministic-id guard (covers crashes between checks)
  const autoDoc = await db.collection('vote_workflows').doc(wfId).get();
  if (autoDoc.exists) return;

  // manual-start guard: any live workflow already targeting this month?
  const dupes = await db.collection('vote_workflows')
    .where('year', '==', tm.year).where('month', '==', tm.month).get();
  if (dupes.docs.some((d) => !['declined', 'cancelled'].includes(d.data().status))) return;

  // need a poll channel to post into
  if (!settings.pollChannelId) {
    if (!(await alreadyFailedThisMonth(db, monthKey))) {
      await markFailed(db, monthKey);
      await surfaceFailure(ctx, { scope: 'autopilot', level: 'error', message: `Auto-vote is ON but no default Poll channel is set — set it in Command Center → Settings → Default Channels. (${monthKey})` });
    }
    return;
  }

  const gameTime = settings.firstHandTime || (settings.pokerNightDefaults && settings.pokerNightDefaults.firstHandTime) || '7:30 PM CT';
  const weekday = settings.candidateWeekday == null ? 4 : +settings.candidateWeekday;
  const bufferHours = settings.bufferHours == null ? 48 : +settings.bufferHours;
  const windowDays = +settings.voteWindowDays || 7;
  const reminderOffsets = (Array.isArray(settings.reminderOffsetsMinutes) && settings.reminderOffsetsMinutes.length)
    ? settings.reminderOffsetsMinutes : engine.DEFAULT_REMINDER_OFFSETS;

  let options;
  try { options = engine.buildPollOptions(tm.year, tm.month, { gameTime, weekday }); }
  catch (e) { options = []; }
  if (!options.length) {
    if (!(await alreadyFailedThisMonth(db, monthKey))) {
      await markFailed(db, monthKey);
      await surfaceFailure(ctx, { scope: 'autopilot', level: 'error', message: `Auto-vote: no candidate ${engine.WEEKDAY_NAMES[weekday]}s found for ${monthKey}.` });
    }
    return;
  }

  let plan = engine.planVoteWindow({ triggerAt: now, options, windowDays, bufferHours });
  if (!plan.valid) {
    const rp = engine.replanDroppingEarliest({ triggerAt: now, options, windowDays, bufferHours });
    if (rp.plan.valid) { plan = rp.plan; options = rp.options; }
  }
  if (!plan.valid) {
    if (!(await alreadyFailedThisMonth(db, monthKey))) {
      await markFailed(db, monthKey);
      await surfaceFailure(ctx, { scope: 'autopilot', level: 'error', message: `Auto-vote: couldn't plan a valid vote window for ${monthKey} (${plan.error || 'no window'}). Start it manually from the Command Center.` });
    }
    return;
  }

  // Deterministic poll-job id, known up front so it can be written in the
  // SAME batch as the workflow doc — a crash between the two writes used to
  // strand the vote forever (the doc.exists guard above would see the
  // workflow and never retry the poll job).
  const pollJobId = `autopoll_${wfId}`;

  const wf = {
    schemaVersion: 2, status: 'scheduled', month: tm.month, year: tm.year, timezone: engine.TZ,
    gameTime, tableOpenTime: settings.tableOpenTime || '7:00 PM CT', bufferHours,
    options: options.map((o) => ({ id: o.id, isoDate: o.isoDate, startAtUtc: Timestamp.fromDate(o.startAtUtc), label: o.label, emoji: o.emoji, weekday: o.weekday, holidayNote: '', voteCount: 0 })),
    earliestCandidateAt: Timestamp.fromDate(plan.earliestCandidateAt),
    voteOpenAt: Timestamp.fromDate(plan.voteOpenAt), voteCloseAt: Timestamp.fromDate(plan.voteCloseAt),
    pollDurationHours: plan.pollDurationHours, windowSuggested: !!plan.windowSuggested, windowSuggestionReason: plan.windowSuggestionReason || null,
    reminderOffsets,
    autoApprove: settings.autoApprove === true,
    pollChannelId: settings.pollChannelId, pollChannelName: settings.pollChannelName || null,
    announceChannelId: settings.announceChannelId || settings.pollChannelId, announceChannelName: settings.announceChannelName || settings.pollChannelName || null,
    reminderChannelId: settings.reminderChannelId || settings.announceChannelId || settings.pollChannelId, reminderChannelName: settings.reminderChannelName || null,
    approvalChannelId: settings.approvalChannelId || null,
    tableLiveChannelId: settings.tableLiveChannelId || null, activeCategoryId: settings.activeCategoryId || null,
    createdAt: FieldValue.serverTimestamp(), createdBy: 'autopilot',
    pollJobId,
  };

  const title = `🃏 ${engine.MONTH_NAMES[tm.month - 1]} ${tm.year} Poker Night — check every date you can make 🃏`;
  const pollJob = {
    type: 'poll', channelId: settings.pollChannelId, channelName: settings.pollChannelName || null, content: title,
    pollData: { title, options: options.map((o) => ({ text: o.label, emoji: o.emoji })), multiSelect: true, duration: Math.min(plan.pollDurationHours, 768) },
    workflowId: wfId, scheduledFor: Timestamp.now(), status: 'pending', createdAt: FieldValue.serverTimestamp(), sentAt: null, error: null,
  };

  const batch = db.batch();
  batch.set(db.collection('vote_workflows').doc(wfId), wf, { merge: false });
  batch.set(db.collection('scheduled_jobs').doc(pollJobId), pollJob, { merge: false });
  await batch.commit();

  await ctx.writeLog('vote_open', `Autopilot opened the ${engine.MONTH_NAMES[tm.month - 1]} ${tm.year} vote (poll → #${settings.pollChannelName || settings.pollChannelId}).`, { workflowId: wfId });
}

function startAutopilot(client, db, writeLog) {
  console.log('[Autopilot] Started — checking every 30 min for the monthly auto-vote.');
  const ctx = { client, db, writeLog };
  const safeTick = () => tick(ctx).catch((e) => console.error('[Autopilot] tick error:', e.message));
  setTimeout(safeTick, 20 * 1000); // settle after boot
  setInterval(safeTick, CHECK_INTERVAL_MS);
}

module.exports = { startAutopilot, targetMonth, voteOpenAt };
