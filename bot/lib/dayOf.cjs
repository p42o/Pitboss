// dayOf.cjs — schedules the day-of "open the table" automation that fires once
// a poker night is locked in (approved). Two jobs:
//
//   1. A MORNING NUDGE (a plain message pinging the host) reminding Parker to
//      spin up the PokerNow table and drop its link in the Command Center. He
//      can do that any time during the day.
//   2. A reserved `table_live` job at game time (default = first-hand time,
//      i.e. 7:30 PM CT). It carries NO baked-in content — the scheduler reads
//      the link off the workflow (`tableLink`) live at fire time, so whatever
//      Parker pasted that day gets posted, and the join channel is revealed.
//
// Gated on settings.autoTableEnabled. Idempotent per workflow (never double-
// schedules). Returns a summary for logging. Mirrors the manual "Go Live"
// flow in the Command Center, just time-shifted and hands-free.

const admin = require('firebase-admin');
const engine = require('./scheduleEngine.cjs');

const { Timestamp, FieldValue } = admin.firestore;

function parseTimeSafe(str, fallback) {
  try { return engine.parseClockTime(str); } catch (_) { return fallback; }
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} wf      workflow doc data, MUST include `id`
 * @param {Date}   firstHandDate
 * @param {object} settings  settings/config doc data
 */
async function scheduleDayOfJobs(db, wf, firstHandDate, settings) {
  const out = { nudge: null, autoPost: null, skipped: [] };
  if (!settings || settings.autoTableEnabled !== true) { out.skipped.push('auto-table disabled'); return out; }
  if (!firstHandDate || isNaN(+firstHandDate)) { out.skipped.push('no first-hand date'); return out; }
  if (!wf || !wf.id) { out.skipped.push('no workflow id'); return out; }
  const now = new Date();

  // Idempotency — never double-schedule for a workflow (covers re-approval,
  // crashes between checks, manual + auto overlap).
  const existing = await db.collection('scheduled_jobs').where('workflowId', '==', wf.id).get();
  const haveTableLive = existing.docs.some((d) => d.data().type === 'table_live');
  const haveNudge = existing.docs.some((d) => d.data().type === 'message' && d.data().linkNudge === true);

  // --- 1. reserved table_live auto-post at game time (link read live) ---
  if (!haveTableLive) {
    const pt = parseTimeSafe(settings.tablePostTime, null);
    const postAt = pt ? engine.sameDayCtTimeUtc(firstHandDate, pt.hour, pt.min) : firstHandDate;
    if (postAt > now) {
      const channelId = wf.tableLiveChannelId || settings.tableLiveChannelId || wf.announceChannelId;
      if (channelId) {
        const ref = await db.collection('scheduled_jobs').add({
          type: 'table_live', autoPost: true,
          channelId, channelName: wf.announceChannelName || 'join-the-game',
          activeCategoryId: wf.activeCategoryId || settings.activeCategoryId || null,
          workflowId: wf.id, scheduledFor: Timestamp.fromDate(postAt), status: 'pending',
          createdAt: FieldValue.serverTimestamp(), sentAt: null, error: null,
        });
        out.autoPost = { id: ref.id, at: postAt };
      } else out.skipped.push('no channel for table_live');
    } else out.skipped.push('table post time already passed');
  }

  // --- 2. morning nudge to the host to drop the link ---
  if (!haveNudge) {
    const rt = parseTimeSafe(settings.linkReminderTime, { hour: 9, min: 0 });
    const nudgeAt = engine.sameDayCtTimeUtc(firstHandDate, rt.hour, rt.min);
    if (nudgeAt > now) {
      const ch = settings.approvalChannelId || settings.testChannelId || wf.announceChannelId;
      if (ch) {
        const mention = settings.approverUserId ? `<@${settings.approverUserId}> ` : '';
        const gt = wf.gameTime || settings.firstHandTime || '7:30 PM CT';
        const ptStr = settings.tablePostTime || gt;
        const ref = await db.collection('scheduled_jobs').add({
          type: 'message', linkNudge: true, channelId: ch, channelName: null, workflowId: wf.id,
          content: `${mention}🔗 Poker night is **tonight** (${gt})! Spin up the PokerNow table whenever you're ready, then drop the link in the Command Center → Autopilot. I'll auto-post it to the join channel at ${ptStr} — or hit "Post now" to drop it early.`,
          scheduledFor: Timestamp.fromDate(nudgeAt), status: 'pending',
          createdAt: FieldValue.serverTimestamp(), sentAt: null, error: null,
        });
        out.nudge = { id: ref.id, at: nudgeAt };
      } else out.skipped.push('no host channel for nudge');
    } else out.skipped.push('nudge time already passed');
  }

  return out;
}

module.exports = { scheduleDayOfJobs };
