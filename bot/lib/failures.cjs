'use strict';
/**
 * surfaceFailure — the single no-silent-failure choke point (design fix #6).
 *
 * Every dropped reminder, failed job, or unrecoverable workflow error routes
 * here so NOTHING fails silently. It:
 *   1. appends to the workflow's `failures[]` (arrayUnion with Timestamp.now()
 *      — serverTimestamp() CANNOT be nested inside arrayUnion),
 *   2. writes a `logs` entry,
 *   3. for level 'error', DMs the approver (falls back to the approval channel).
 *
 * @param {{db, client, writeLog, settings}} ctx
 * @param {{workflowId?, scope, level?, message, meta?}} f  level: 'error'|'warning'
 */
const admin = require('firebase-admin');

async function surfaceFailure(ctx, f) {
  const { db, client, writeLog, settings = {} } = ctx;
  const level = f.level || 'error';
  const meta = f.meta || {};

  // 1. failures[] on the workflow (Timestamp.now — never serverTimestamp in arrayUnion)
  if (f.workflowId) {
    try {
      await db.collection('vote_workflows').doc(f.workflowId).update({
        failures: admin.firestore.FieldValue.arrayUnion({
          scope: f.scope, level, message: f.message, at: admin.firestore.Timestamp.now(), meta,
        }),
        ...(level === 'error' ? { hasUnresolvedFailure: true } : {}),
      });
    } catch (e) {
      console.error('[surfaceFailure] failures[] write error:', e.message);
    }
  }

  // 2. log
  try { await writeLog(level === 'error' ? 'error' : 'warning', f.message, { scope: f.scope, workflowId: f.workflowId, ...meta }); } catch (_) {}

  // 3. ping Parker on errors (DM, fallback to approval channel)
  if (level === 'error' && client) {
    const text = `🚨 **Pitboss${f.workflowId ? ` · wf ${f.workflowId.slice(0, 6)}` : ''}** — ${f.message}`;
    const approverId = settings.approverUserId;
    if (approverId) {
      try { const u = await client.users.fetch(approverId); await u.send(text); return; } catch (_) { /* DMs closed → fall through */ }
    }
    const chId = settings.approvalChannelId;
    if (chId) {
      try { const ch = await client.channels.fetch(chId); if (ch && ch.isTextBased()) await ch.send(text); } catch (_) {}
    }
  }
}

module.exports = { surfaceFailure };
