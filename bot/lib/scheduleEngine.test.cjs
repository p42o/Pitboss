'use strict';
/**
 * Unit + fixture tests for scheduleEngine. Run: `node --test bot/lib/`.
 * Hand-computed expected values; doubles as the parity fixture guarding the
 * SSL/admin/lib/scheduleEngine.js mirror (same inputs must yield same outputs).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./scheduleEngine.cjs');

const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi); // 1-based month helper

test('nextMonthOf rolls Dec->Jan', () => {
  assert.deepEqual(E.nextMonthOf(2026, 12), { year: 2027, month: 1 });
  assert.deepEqual(E.nextMonthOf(2026, 5), { year: 2026, month: 6 });
});

test('parseClockTime handles AM/PM and 24h', () => {
  assert.deepEqual(E.parseClockTime('7:30 PM CT'), { hour: 19, min: 30 });
  assert.deepEqual(E.parseClockTime('19:30'), { hour: 19, min: 30 });
  assert.deepEqual(E.parseClockTime('12:00 AM'), { hour: 0, min: 0 });
  assert.deepEqual(E.parseClockTime('12 PM'), { hour: 12, min: 0 });
  assert.throws(() => E.parseClockTime('banana'));
});

test('getCandidateDates finds the 4 Thursdays of June 2026', () => {
  const c = E.getCandidateDates(2026, 6); // default weekday=4 (Thu)
  assert.deepEqual(c.map((x) => x.day), [4, 11, 18, 25]);
});

test('getCandidateDates handles a 5-Thursday month (July 2026)', () => {
  assert.deepEqual(E.getCandidateDates(2026, 7).map((x) => x.day), [2, 9, 16, 23, 30]);
});

test('ctWallClockToUtc is DST-correct (CDT in June = -5)', () => {
  // Jun 4 2026 19:30 CDT -> Jun 5 00:30 UTC
  assert.equal(E.ctWallClockToUtc(2026, 6, 4, 19, 30).getTime(), U(2026, 6, 5, 0, 30));
});

test('ctWallClockToUtc is DST-correct (CST in Nov = -6)', () => {
  // DST ends Nov 1 2026; Nov 5 19:30 CST -> Nov 6 01:30 UTC
  assert.equal(E.ctWallClockToUtc(2026, 11, 5, 19, 30).getTime(), U(2026, 11, 6, 1, 30));
});

test('ctWallClockToUtc straddles the March DST start', () => {
  // DST starts Mar 8 2026. Mar 5 (CST -6) -> Mar 6 01:30 UTC; Mar 12 (CDT -5) -> Mar 13 00:30 UTC
  assert.equal(E.ctWallClockToUtc(2026, 3, 5, 19, 30).getTime(), U(2026, 3, 6, 1, 30));
  assert.equal(E.ctWallClockToUtc(2026, 3, 12, 19, 30).getTime(), U(2026, 3, 13, 0, 30));
});

test('ctIsoString carries the correct offset per season', () => {
  assert.equal(E.ctIsoString(2026, 6, 4, 19, 30), '2026-06-04T19:30:00-05:00');
  assert.equal(E.ctIsoString(2026, 11, 5, 19, 30), '2026-11-05T19:30:00-06:00');
});

test('buildPollOptions emits structured, dated options', () => {
  const opts = E.buildPollOptions(2026, 6, { gameTime: '7:30 PM CT' });
  assert.equal(opts.length, 4);
  assert.equal(opts[0].id, 'opt_2026_06_04');
  assert.equal(opts[0].label, 'Thurs (06/04) @ 7:30 PM CT');
  assert.equal(opts[0].weekday, 'Thursday');
  assert.equal(opts[0].voteCount, 0);
  assert.equal(opts[0].startAtUtc.getTime(), U(2026, 6, 5, 0, 30));
  assert.ok(opts.every((o) => o.emoji));
});

test('planVoteWindow: full 7-day window when no collision', () => {
  const options = E.buildPollOptions(2026, 7); // earliest Jul 2 19:30 CDT
  const plan = E.planVoteWindow({ triggerAt: new Date(U(2026, 6, 1)), options });
  assert.equal(plan.valid, true);
  assert.equal(plan.windowSuggested, false);
  assert.equal(plan.pollDurationHours, 168);
  assert.ok(plan.voteCloseAt.getTime() <= plan.earliestCandidateAt.getTime() - 48 * 3600000);
});

test("planVoteWindow: Parker's collision auto-shortens the window", () => {
  // Trigger ~May 27 8pm CT; candidates are June Thursdays (earliest Jun 4).
  const options = E.buildPollOptions(2026, 6);
  const triggerAt = new Date(U(2026, 5, 28, 1, 0)); // 2026-05-28T01:00Z
  const plan = E.planVoteWindow({ triggerAt, options, windowDays: 7, bufferHours: 48 });
  assert.equal(plan.valid, true);
  assert.equal(plan.windowSuggested, true);                       // it detected the collision
  assert.ok(/shortened/.test(plan.windowSuggestionReason));
  // INVARIANT: closes at least 48h before the first candidate (the bug fix).
  assert.ok(plan.voteCloseAt.getTime() <= plan.earliestCandidateAt.getTime() - 48 * 3600000);
  assert.ok(plan.pollDurationHours >= 24);
});

test('planVoteWindow: impossible window flags drop-earliest, replan succeeds', () => {
  const options = E.buildPollOptions(2026, 6);            // Jun 4 earliest
  const triggerAt = new Date(U(2026, 6, 3, 12, 0));       // only ~1.5 days before Jun 4
  const plan = E.planVoteWindow({ triggerAt, options, bufferHours: 48, minWindowHours: 24 });
  assert.equal(plan.valid, false);
  assert.equal(plan.suggestDropEarliest, true);
  const replan = E.replanDroppingEarliest({ triggerAt, options, bufferHours: 48, minWindowHours: 24 });
  assert.ok(replan.droppedOptionIds.includes('opt_2026_06_04'));
  assert.equal(replan.plan.valid, true);
});

test('planReminders: all fire when far out', () => {
  const firstHandAt = new Date(U(2026, 6, 5, 0, 30));
  const now = new Date(U(2026, 5, 28));
  const r = E.planReminders({ firstHandAt, now });
  assert.equal(r.scheduled.length, 3);
  assert.equal(r.skipped.length, 0);
});

test('planReminders: skips past offsets without silent loss', () => {
  const firstHandAt = new Date(U(2026, 6, 5, 0, 30));
  const now = new Date(firstHandAt.getTime() - 60 * 60000); // 60m before first hand
  const r = E.planReminders({ firstHandAt, now }); // offsets 1440,240,30
  assert.deepEqual(r.scheduled.map((s) => s.offsetMinutes), [30]);
  assert.deepEqual(r.skipped.map((s) => s.offsetMinutes), [1440, 240]);
  assert.ok(r.warnings.length >= 1);
});

test('planReminders: first hand in the past warns, schedules nothing', () => {
  const firstHandAt = new Date(U(2026, 6, 5, 0, 30));
  const now = new Date(firstHandAt.getTime() + 60000);
  const r = E.planReminders({ firstHandAt, now });
  assert.equal(r.scheduled.length, 0);
  assert.ok(r.warnings.some((w) => /past/.test(w)));
});

test('resolveWinningOption: clear winner / tie / empty', () => {
  const mk = (id, v) => ({ id, voteCount: v, startAtUtc: new Date() });
  assert.equal(E.resolveWinningOption([mk('a', 3), mk('b', 1)]).winnerOptionId, 'a');
  const tie = E.resolveWinningOption([mk('a', 2), mk('b', 2), mk('c', 1)]);
  assert.equal(tie.isTie, true);
  assert.deepEqual(tie.tiedOptionIds, ['a', 'b']);
  const empty = E.resolveWinningOption([mk('a', 0), mk('b', 0)]);
  assert.equal(empty.isEmpty, true);
  assert.deepEqual(empty.tiedOptionIds, ['a', 'b']);
});

test('computeTieDeadline clamps so it always leads the earliest tied date', () => {
  const tiedOptions = E.buildPollOptions(2026, 6).slice(0, 2); // Jun 4 & Jun 11
  const voteCloseAt = new Date(U(2026, 6, 1));
  const d = E.computeTieDeadline({ voteCloseAt, tiedOptions, graceHours: 12, bufferHours: 48 });
  const earliest = E.earliestOf(tiedOptions).startAtUtc.getTime();
  assert.ok(d.getTime() <= earliest - 48 * 3600000);
  assert.ok(d.getTime() <= voteCloseAt.getTime() + 12 * 3600000);
});
