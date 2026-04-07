// Shared status bar: live CT clock, bot heartbeat, members online, scheduled count
import { db } from './firebase-init.js';
import {
  doc, onSnapshot, collection, query, where
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

export function initNavStats() {
  // ── Live CT clock ──────────────────────────────────────────
  const timeEl = document.getElementById('stat-time-val');
  function updateClock() {
    if (!timeEl) return;
    timeEl.textContent = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
    }).format(new Date());
  }
  updateClock();
  setInterval(updateClock, 1000);

  // ── Bot heartbeat → status dot ─────────────────────────────
  const botValEl = document.getElementById('stat-bot-val');
  const botDotEl = document.getElementById('stat-bot-dot');

  function applyBotStatus(age, tag) {
    if (!botValEl || !botDotEl) return;
    // Thresholds match 60s heartbeat: online < 150s, idle < 360s
    if (age < 150) {
      botValEl.textContent = tag || 'Online';
      botValEl.style.color = '#4ade80';
      botDotEl.style.background = '#4ade80';
      botDotEl.style.boxShadow = '0 0 7px #4ade80';
    } else if (age < 360) {
      botValEl.textContent = 'Idle';
      botValEl.style.color = '#fbbf24';
      botDotEl.style.background = '#fbbf24';
      botDotEl.style.boxShadow = '0 0 7px #fbbf24';
    } else {
      botValEl.textContent = 'Offline';
      botValEl.style.color = '#f87171';
      botDotEl.style.background = '#f87171';
      botDotEl.style.boxShadow = '0 0 7px #f87171';
    }
  }

  let navLastHeartbeatTs = null;
  let navLastHeartbeatTag = null;

  function tickNavBotStatus() {
    if (!navLastHeartbeatTs) { applyBotStatus(99999, null); return; }
    applyBotStatus((Date.now() - navLastHeartbeatTs) / 1000, navLastHeartbeatTag);
  }

  onSnapshot(doc(db, 'bot_status', 'heartbeat'), (snap) => {
    if (!snap.exists()) { applyBotStatus(99999, null); return; }
    const ts = snap.data().lastSeen?.toDate();
    if (ts) {
      navLastHeartbeatTs = ts.getTime();
      navLastHeartbeatTag = snap.data().tag;
    }
    tickNavBotStatus();
  }, (_err) => { applyBotStatus(99999, null); });

  // Re-evaluate age locally every 30s — zero Firestore reads
  setInterval(tickNavBotStatus, 30000);

  // ── Members online ─────────────────────────────────────────
  const membersEl = document.getElementById('stat-members-val');
  onSnapshot(doc(db, 'bot_status', 'presence'), (snap) => {
    if (!membersEl) return;
    membersEl.textContent = snap.exists() ? (snap.data().onlineCount ?? '—') : '—';
  }, (_err) => { if (membersEl) membersEl.textContent = '—'; });

  // ── Scheduled jobs count ───────────────────────────────────
  const scheduledEl = document.getElementById('stat-scheduled-val');
  onSnapshot(
    query(collection(db, 'scheduled_jobs'), where('status', '==', 'pending')),
    (snap) => { if (scheduledEl) scheduledEl.textContent = snap.size; },
    (_err) => { if (scheduledEl) scheduledEl.textContent = '—'; }
  );
}
