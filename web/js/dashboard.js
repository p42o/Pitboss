import { requireAuth, logout } from './auth.js';
import { db } from './firebase-init.js';
import {
  collection, doc, getDoc, addDoc, deleteDoc, onSnapshot,
  query, where, orderBy, limit, Timestamp, serverTimestamp, updateDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { initParticles } from './particles.js';
import { initNavStats } from './nav-stats.js';

// ==================== AUTH GUARD ====================
const user = await requireAuth('index.html');
document.getElementById('logout-btn').addEventListener('click', logout);

// ==================== BACKGROUND + NAV STATS ====================
initParticles('smoke-canvas');
initNavStats();

// ==================== HELPERS ====================
function ctDateStr(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

function ctTimeShort(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

function localDatetimeToUTC(localStr) {
  const [datePart, timePart] = localStr.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const testDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = formatter.formatToParts(testDate);
  const ctYear = +parts.find(p => p.type === 'year').value;
  const ctMonth = +parts.find(p => p.type === 'month').value;
  const ctDay = +parts.find(p => p.type === 'day').value;
  const ctHour = +parts.find(p => p.type === 'hour').value;
  const ctMinute = +parts.find(p => p.type === 'minute').value;
  const diffMs = testDate - new Date(Date.UTC(ctYear, ctMonth - 1, ctDay, ctHour, ctMinute));
  return new Date(testDate.getTime() + diffMs);
}

function dateToLocalDatetimeStr(d) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value.padStart(2,'0');
  const min = parts.find(p => p.type === 'minute').value;
  return `${y}-${m}-${day}T${hour === '24' ? '00' : hour}:${min}`;
}

function renderDiscordMarkdown(text) {
  if (!text) return '';
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  html = html.replace(/__(.+?)__/g, '<u>$1</u>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

async function writeLog(type, message, metadata = {}) {
  try {
    await addDoc(collection(db, 'logs'), { type, message, metadata, timestamp: serverTimestamp() });
  } catch (e) { console.error('Log write failed', e); }
}

// ==================== SETTINGS LOAD ====================
let settings = {
  channels: [], testChannelId: '', testChannelName: '',
  openrouterKey: '', openrouterModel: 'google/gemini-2.0-flash-lite-001',
  pokerNightDefaults: {},
  lastChannels: {}
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_EMOJIS = {
  1: ['❄️','⛄'], 2: ['❤️','🌹'], 3: ['🍀','☘️'],
  4: ['🌸','🌷'], 5: ['🌻','🌺'], 6: ['☀️','🌊'],
  7: ['🎆','🦅'], 8: ['🌅','🏖️'], 9: ['🍂','🏈'],
  10: ['🎃','👻'], 11: ['🦃','🍁'], 12: ['🎄','⛄']
};
const MEMO_WORDS = {
  1: ['snowflake','frostbite','blizzard','glacier','arctic','icicle'],
  2: ['valentine','sweetheart','cupid','cardinal','candlelight','rosewood'],
  3: ['shamrock','clover','rainbow','pinwheel','springroll','leprechaun'],
  4: ['raindrop','blossom','tulip','pasture','puddle','bluejay'],
  5: ['maypole','lemonade','wildflower','derby','gardenia','honeybee'],
  6: ['solstice','firefly','barbecue','marina','sandbar','sundial'],
  7: ['fireworks','sparkler','sundeck','bonfire','patriot','starspangle'],
  8: ['harvest','carousel','driftwood','sunflower','starlight','cornsilk'],
  9: ['tailgate','compass','equinox','harvest','pigskin','crabapple'],
  10: ['hayride','cider','lantern','cobweb','cornfield','pumpkinpatch'],
  11: ['pilgrim','acorn','gobbler','cider','cornucopia','cranberry'],
  12: ['chimney','mistletoe','snowcap','garland','figpudding','sugarplum']
};

function findChannelByName(name) {
  if (!settings.channels || !name) return null;
  const lc = String(name).toLowerCase();
  return settings.channels.find(c => (c.name || '').toLowerCase() === lc) || null;
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'config'));
    if (snap.exists()) settings = { ...settings, ...snap.data() };
  } catch (e) { console.error('Settings load error', e); }
  populateChannelDropdowns();
}

function populateChannelDropdowns() {
  const dropdowns = document.querySelectorAll('.channel-dropdown');
  dropdowns.forEach(sel => {
    const dropdownId = sel.id;
    const defaultName = sel.dataset.default;
    // Priority: previously persisted choice > default channel name > current value
    const lastChannels = settings.lastChannels || {};
    const persisted = lastChannels[dropdownId];
    const current = sel.value;

    sel.innerHTML = '<option value="">-- Select Channel --</option>';
    if (!settings.channels || settings.channels.length === 0) {
      sel.innerHTML = '<option value="">No channels configured</option>';
      return;
    }
    settings.channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `#${ch.name}`;
      sel.appendChild(opt);
    });

    let toSelect = '';
    if (persisted && settings.channels.find(c => c.id === persisted)) {
      toSelect = persisted;
    } else if (current && settings.channels.find(c => c.id === current)) {
      toSelect = current;
    } else if (defaultName) {
      const match = findChannelByName(defaultName);
      if (match) toSelect = match.id;
    }
    if (toSelect) sel.value = toSelect;

    // Persist on change
    sel.addEventListener('change', async () => {
      try {
        const cur = settings.lastChannels || {};
        cur[dropdownId] = sel.value;
        settings.lastChannels = cur;
        await setDoc(doc(db, 'settings', 'config'), { lastChannels: cur }, { merge: true });
      } catch (e) { console.error('Persist last channel error', e); }
    }, { once: false });
  });
}

await loadSettings();

// ==================== EMOJI PICKER ====================
const EMOJI_DATA = {
  'Smileys': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🙂','🤗','🤩','🤔','😏','😒','😔','😢','😭','🥵','🥶','😱','🤪','😈','👿','👍','👎','👌','✌️','🤞','🤟','🤘','👏','🙌','🙏'],
  'Activities': ['⚽','🏀','🏈','⚾','🎾','🎱','🃏','🀄','🎴','🎰','🎲','🎯','🎮'],
  'Food': ['🍔','🍕','🌭','🍿','🍩','🍪','🥃','🍷','🍸','🍹','🍺','🍻','☕'],
  'Symbols': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💯','🔔','✅','❎','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','♠️','♥️','♦️','♣️','🃏'],
};

function buildEmojiPicker(targetTextarea) {
  const wrap = document.createElement('div');
  wrap.className = 'emoji-picker-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-outline btn-sm';
  btn.textContent = '😀 Emoji';
  wrap.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'emoji-panel';
  const tabs = document.createElement('div');
  tabs.className = 'emoji-tabs';
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';

  function renderGrid(emojis) {
    grid.innerHTML = '';
    emojis.forEach(e => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.addEventListener('click', () => {
        const start = targetTextarea.selectionStart;
        const end = targetTextarea.selectionEnd;
        const val = targetTextarea.value;
        targetTextarea.value = val.slice(0, start) + e + val.slice(end);
        targetTextarea.selectionStart = targetTextarea.selectionEnd = start + e.length;
        targetTextarea.focus();
        targetTextarea.dispatchEvent(new Event('input'));
      });
      grid.appendChild(b);
    });
  }
  const catIcons = { 'Smileys':'😀', 'Activities':'⚽', 'Food':'🍔', 'Symbols':'♠️' };
  Object.entries(EMOJI_DATA).forEach(([cat, emojis], idx) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'emoji-tab' + (idx === 0 ? ' active' : '');
    tab.textContent = catIcons[cat] || cat[0];
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderGrid(emojis);
    });
    tabs.appendChild(tab);
  });
  renderGrid(EMOJI_DATA['Smileys']);
  panel.appendChild(tabs);
  panel.appendChild(grid);
  wrap.appendChild(panel);
  btn.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.toggle('show'); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) panel.classList.remove('show'); });
  return wrap;
}

function buildToolbar(textarea) {
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const tools = [
    { label: 'B', tag: '**', style: 'font-weight:700' },
    { label: 'I', tag: '*', style: 'font-style:italic' },
    { label: 'U', tag: '__', style: 'text-decoration:underline' },
    { label: 'S', tag: '~~', style: 'text-decoration:line-through' },
    { label: '`', tag: '`', style: 'font-family:monospace' },
  ];
  tools.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn';
    btn.innerHTML = `<span style="${t.style || ''}">${t.label}</span>`;
    btn.addEventListener('click', () => {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = textarea.value.slice(start, end);
      const newText = `${t.tag}${selected || 'text'}${t.tag}`;
      textarea.value = textarea.value.slice(0, start) + newText + textarea.value.slice(end);
      textarea.focus();
      textarea.dispatchEvent(new Event('input'));
    });
    toolbar.appendChild(btn);
  });
  return toolbar;
}

// ==================== QUEUE RENDERING ====================
const TYPE_LABELS = {
  message: { label: 'BROADCAST', color: 'var(--blue-text)', bg: 'rgba(30,58,95,0.3)' },
  poll: { label: 'POLL', color: 'var(--purple-text)', bg: 'rgba(58,30,95,0.3)' },
  reminder: { label: 'REMINDER', color: 'var(--amber-text)', bg: 'rgba(95,58,30,0.3)' },
  announcement: { label: 'ANNOUNCE', color: 'var(--gold)', bg: 'rgba(212,178,84,0.15)' },
  table_live: { label: 'TABLE LIVE', color: 'var(--green-text)', bg: 'rgba(45,122,79,0.2)' }
};

function formatScheduledTime(ts) {
  if (!ts) return 'Unknown time';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return ctDateStr(d);
}

function renderQueueCard(job, container) {
  const type = job.type || 'message';
  const meta = TYPE_LABELS[type] || TYPE_LABELS.message;
  const card = document.createElement('div');
  card.className = 'queue-card unified-queue-card';
  card.style.borderLeftColor = meta.color;
  card.dataset.id = job.id;

  const badge = document.createElement('span');
  badge.className = 'queue-type-badge';
  badge.textContent = meta.label;
  badge.style.cssText = `background:${meta.bg};color:${meta.color};`;

  const timeEl = document.createElement('div');
  timeEl.className = 'queue-card-time';
  timeEl.textContent = formatScheduledTime(job.scheduledFor);

  const channelEl = document.createElement('div');
  channelEl.className = 'queue-card-channel';
  channelEl.textContent = job.channelName ? `#${job.channelName}` : `Channel ${job.channelId || ''}`;

  const preview = document.createElement('div');
  preview.className = 'queue-card-preview';
  let previewText = '';
  if (job.type === 'poll' && job.pollData) previewText = job.pollData.title || 'Poll';
  else previewText = (job.content || '').replace(/\n/g, ' ').slice(0, 100);
  preview.textContent = previewText;

  const delBtn = document.createElement('button');
  delBtn.className = 'queue-card-delete';
  delBtn.title = 'Cancel job';
  delBtn.innerHTML = '🗑';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm('Cancel this scheduled job?')) {
      await deleteDoc(doc(db, 'scheduled_jobs', job.id));
      await writeLog('warning', `Scheduled job cancelled`, { jobId: job.id });
    }
  });

  card.appendChild(badge);
  card.appendChild(timeEl);
  card.appendChild(channelEl);
  card.appendChild(preview);
  card.appendChild(delBtn);
  container.appendChild(card);
}

function subscribeToUnifiedQueue() {
  const container = document.getElementById('unified-queue');
  const countBadge = document.getElementById('queue-count-badge');
  const q = query(
    collection(db, 'scheduled_jobs'),
    where('status', '==', 'pending'),
    orderBy('scheduledFor', 'asc')
  );
  return onSnapshot(q, (snap) => {
    container.innerHTML = '';
    if (snap.empty) {
      container.innerHTML = '<div class="queue-empty">No items scheduled — queue is clear.</div>';
      if (countBadge) countBadge.style.display = 'none';
      return;
    }
    if (countBadge) {
      countBadge.textContent = `${snap.size} item${snap.size !== 1 ? 's' : ''}`;
      countBadge.style.display = 'inline-flex';
    }
    snap.forEach(d => renderQueueCard({ id: d.id, ...d.data() }, container));
  });
}

// ==================== ACTIVITY LOG (bottom panel) ====================
const LOG_EMOJI = {
  sent: '📤', scheduled: '📅', error: '🔴', warning: '🟡', success: '✅',
  connection: '🔌', reply: '💬', vote_open: '🗳️', vote_closed: '🏁',
  image_generated: '🎨', imgur_uploaded: '📸', approval_pending: '⏳',
  approved: '👍', declined: '👎'
};

function subscribeToActivityLog() {
  const list = document.getElementById('activity-log-list');
  const badge = document.getElementById('activity-count-badge');
  const q = query(collection(db, 'logs'), orderBy('timestamp', 'desc'), limit(100));
  return onSnapshot(q, (snap) => {
    list.innerHTML = '';
    if (snap.empty) {
      list.innerHTML = '<div class="queue-empty">No activity yet.</div>';
      if (badge) badge.textContent = '0 entries';
      return;
    }
    if (badge) badge.textContent = `${snap.size} entr${snap.size !== 1 ? 'ies' : 'y'}`;
    snap.forEach(d => {
      const log = d.data();
      const row = document.createElement('div');
      row.className = `activity-log-row lt-${log.type || 'connection'}`;
      const emoji = document.createElement('div');
      emoji.className = 'activity-log-emoji';
      emoji.textContent = LOG_EMOJI[log.type] || 'ℹ️';
      const msg = document.createElement('div');
      msg.className = 'activity-log-msg';
      msg.textContent = log.message || '';
      const time = document.createElement('div');
      time.className = 'activity-log-time';
      const ts = log.timestamp?.toDate?.();
      time.textContent = ts ? ctDateStr(ts) : '...';
      row.appendChild(emoji);
      row.appendChild(msg);
      row.appendChild(time);
      list.appendChild(row);
    });
  });
}

// ==================== BROADCAST PANEL ====================
(function initBroadcast() {
  const textarea = document.getElementById('msg-textarea');
  const previewContent = document.getElementById('msg-preview-content');
  const channelSel = document.getElementById('msg-channel');
  const schedPicker = document.getElementById('msg-schedule-picker');
  const schedDatetime = document.getElementById('msg-schedule-datetime');
  const toolbarWrap = document.getElementById('msg-toolbar-wrap');
  const emojiWrap = document.getElementById('msg-emoji-wrap');

  toolbarWrap.appendChild(buildToolbar(textarea));
  emojiWrap.appendChild(buildEmojiPicker(textarea));

  textarea.addEventListener('input', () => {
    previewContent.innerHTML = renderDiscordMarkdown(textarea.value);
  });

  async function sendMessage(channelId, channelName, content, clear = true) {
    if (!content.trim()) { alert('Message cannot be empty.'); return; }
    if (!channelId) { alert('Please select a channel.'); return; }
    await addDoc(collection(db, 'scheduled_jobs'), {
      type: 'message', channelId, channelName: channelName || channelId, content,
      scheduledFor: Timestamp.now(), status: 'pending',
      createdAt: serverTimestamp(), sentAt: null, error: null
    });
    await writeLog('sent', `Message queued for #${channelName}`, { channelId });
    if (clear) { textarea.value = ''; previewContent.innerHTML = ''; }
  }

  async function scheduleMessage(channelId, channelName, content, dtLocal) {
    if (!content.trim()) { alert('Message cannot be empty.'); return; }
    if (!channelId) { alert('Please select a channel.'); return; }
    if (!dtLocal) { alert('Please select a date and time.'); return; }
    const scheduledDate = localDatetimeToUTC(dtLocal);
    if (scheduledDate <= new Date()) { alert('Scheduled time must be in the future.'); return; }
    await addDoc(collection(db, 'scheduled_jobs'), {
      type: 'message', channelId, channelName: channelName || channelId, content,
      scheduledFor: Timestamp.fromDate(scheduledDate), status: 'pending',
      createdAt: serverTimestamp(), sentAt: null, error: null
    });
    await writeLog('scheduled', `Message scheduled for ${ctDateStr(scheduledDate)} in #${channelName}`, { channelId });
    textarea.value = ''; previewContent.innerHTML = '';
    schedPicker.classList.remove('show');
    alert(`Message scheduled for ${ctDateStr(scheduledDate)} CT`);
  }

  document.getElementById('msg-btn-test').addEventListener('click', async () => {
    if (!settings.testChannelId) { alert('No test channel configured.'); return; }
    await sendMessage(settings.testChannelId, settings.testChannelName, textarea.value, false);
  });
  document.getElementById('msg-btn-send').addEventListener('click', async () => {
    const opt = channelSel.options[channelSel.selectedIndex];
    await sendMessage(channelSel.value, opt ? opt.textContent.replace('#','') : '', textarea.value);
  });
  document.getElementById('msg-btn-schedule').addEventListener('click', () => {
    schedPicker.classList.toggle('show');
  });
  document.getElementById('msg-btn-confirm-schedule').addEventListener('click', async () => {
    const opt = channelSel.options[channelSel.selectedIndex];
    await scheduleMessage(channelSel.value, opt ? opt.textContent.replace('#','') : '', textarea.value, schedDatetime.value);
  });
})();

// ==================== POKER NIGHT WORKFLOW ====================
(function initPokerNight() {
  const monthSel = document.getElementById('pn-month');
  const yearSel = document.getElementById('pn-year');
  const voteDt = document.getElementById('pn-vote-datetime');
  const voteChannel = document.getElementById('pn-vote-channel');
  const previewWrap = document.getElementById('pn-poll-preview-wrap');
  const genBtn = document.getElementById('pn-gen-poll-btn');
  const schedBtn = document.getElementById('pn-schedule-vote-btn');
  const stepperEls = document.querySelectorAll('.pn-step');
  const statusPill = document.getElementById('pn-status-pill');
  const editWrap = document.getElementById('pn-edit-mode-wrap');
  const editText = document.getElementById('pn-edit-text');
  const editImage = document.getElementById('pn-edit-image');
  const editImagePreview = document.getElementById('pn-edit-image-preview');
  const editFirstHand = document.getElementById('pn-edit-firsthand');
  const editChannel = document.getElementById('pn-edit-channel');
  const editRemChannel = document.getElementById('pn-edit-rem-channel');
  const resubmitBtn = document.getElementById('pn-resubmit-btn');
  const cancelEditBtn = document.getElementById('pn-cancel-edit-btn');
  const wfList = document.getElementById('pn-workflows-list');

  // Default month/year
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  monthSel.value = String(nextMonth.getMonth() + 1).padStart(2, '0');
  const curYear = now.getFullYear();
  yearSel.innerHTML = '';
  [curYear, curYear + 1].forEach(y => {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === nextMonth.getFullYear()) opt.selected = true;
    yearSel.appendChild(opt);
  });

  // Default vote datetime: today at 6PM CT
  (function setDefault() {
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    voteDt.value = dateToLocalDatetimeStr(d);
  })();

  function getThursdaysInMonth(year, month) {
    const thursdays = [];
    const d = new Date(year, month - 1, 1);
    while (d.getMonth() === month - 1) {
      if (d.getDay() === 4) thursdays.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return thursdays;
  }

  let pollData = null;

  function setStep(stepName) {
    const order = ['vote','watch','generate','approve','schedule'];
    const idx = order.indexOf(stepName);
    stepperEls.forEach((el, i) => {
      el.classList.remove('active','done');
      if (i < idx) el.classList.add('done');
      else if (i === idx) el.classList.add('active');
    });
  }

  async function generatePoll() {
    const month = parseInt(monthSel.value);
    const year = parseInt(yearSel.value);
    const thursdays = getThursdaysInMonth(year, month);
    if (!settings.openrouterKey) { alert('OpenRouter API key not configured.'); return; }

    previewWrap.innerHTML = '<div class="poll-generating"><div class="spinner"></div>Generating vote with AI...</div>';
    previewWrap.classList.add('show');

    const thursdayList = thursdays.map(d => {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${mm}/${dd}`;
    }).join(', ');

    const gameTime = (settings.pokerNightDefaults && settings.pokerNightDefaults.firstHandTime) || '7:30 PM CT';
    const prompt = `Generate a Discord poker night vote poll for ${MONTH_NAMES[month-1]} ${year}.

The poll is for the Shadow Spade Lounge poker group. They meet on Thursdays at ${gameTime}.

Thursdays in ${MONTH_NAMES[month-1]} ${year}: ${thursdayList}

Return ONLY a JSON object:
{"title":"[emoji] ${MONTH_NAMES[month-1]} ${year} Monthly Poker Night Vote [emoji]","options":[{"emoji":"🃏","label":"Thurs (MM/DD) @ ${gameTime}","holidayNote":""}]}

Rules: month-thematic emojis on each side of title, one option per Thursday with its own emoji, holiday-aware. Return ONLY valid JSON.`;

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'Pitboss - Shadow Spade Lounge'
        },
        body: JSON.stringify({
          model: settings.openrouterModel || 'google/gemini-2.0-flash-lite-001',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
      const data = await res.json();
      let content = data.choices?.[0]?.message?.content?.trim();
      content = content.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const parsed = JSON.parse(jsonMatch[0]);
      pollData = parsed;
      renderPollPreview(parsed);
      await writeLog('success', `Vote poll generated for ${MONTH_NAMES[month-1]} ${year}.`, {});
    } catch (err) {
      previewWrap.innerHTML = `<div style="color:var(--red-text);padding:12px;font-size:13px;">Vote generation failed: ${err.message}</div>`;
      await writeLog('error', `Vote generation failed: ${err.message}`, {});
    }
  }

  function renderPollPreview(data) {
    previewWrap.innerHTML = '';
    previewWrap.classList.add('show');
    const titleInput = document.createElement('input');
    titleInput.className = 'poll-title-edit';
    titleInput.value = data.title;
    titleInput.addEventListener('input', () => { pollData.title = titleInput.value; });
    previewWrap.appendChild(titleInput);

    data.options.forEach((opt, idx) => {
      const row = document.createElement('div');
      row.className = 'poll-option-item';
      const emojiSpan = document.createElement('span');
      emojiSpan.style.fontSize = '18px';
      emojiSpan.contentEditable = true;
      emojiSpan.textContent = opt.emoji;
      emojiSpan.addEventListener('input', () => { pollData.options[idx].emoji = emojiSpan.textContent; });
      const labelInput = document.createElement('input');
      labelInput.value = opt.label + (opt.holidayNote ? ` — ${opt.holidayNote}` : '');
      labelInput.addEventListener('input', () => { pollData.options[idx].label = labelInput.value; });
      row.appendChild(emojiSpan);
      row.appendChild(labelInput);
      previewWrap.appendChild(row);
    });
    const meta = document.createElement('div');
    meta.className = 'poll-meta';
    meta.textContent = '✅ Multi-select  •  ⏱ Auto-closes when month-list exhausted (default 7-day duration)';
    previewWrap.appendChild(meta);
  }

  async function scheduleVoteAndWorkflow() {
    if (!pollData) { alert('Generate the vote first.'); return; }
    if (!voteDt.value) { alert('Pick a vote send time.'); return; }
    if (!voteChannel.value) { alert('Pick a vote channel.'); return; }
    const scheduledDate = localDatetimeToUTC(voteDt.value);
    const month = parseInt(monthSel.value);
    const year = parseInt(yearSel.value);
    const opt = voteChannel.options[voteChannel.selectedIndex];
    const channelName = opt ? opt.textContent.replace('#','') : '';

    // 1. Create scheduled poll job (existing 'poll' type — backward compatible)
    const pollDuration = 168; // 7 days default
    const pollJobRef = await addDoc(collection(db, 'scheduled_jobs'), {
      type: 'poll',
      channelId: voteChannel.value, channelName,
      content: pollData.title,
      pollData: {
        title: pollData.title,
        options: pollData.options.map(o => ({ emoji: o.emoji, text: o.label })),
        multiSelect: true,
        duration: pollDuration
      },
      scheduledFor: Timestamp.fromDate(scheduledDate),
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null,
      // workflow link
      workflowId: null  // patched below
    });

    // 2. Create vote_workflows doc
    const wfRef = await addDoc(collection(db, 'vote_workflows'), {
      status: 'scheduled', // → 'awaiting_results' after poll sends → 'generating' → 'approval_pending' → 'approved'/'declined'/'edit_mode'
      pollJobId: pollJobRef.id,
      pollMessageId: null, // bot writes after sending
      pollChannelId: voteChannel.value,
      pollChannelName: channelName,
      pollDurationHours: pollDuration,
      month, year,
      pollScheduledFor: Timestamp.fromDate(scheduledDate),
      pollClosesAt: Timestamp.fromDate(new Date(scheduledDate.getTime() + pollDuration * 3600 * 1000)),
      gameTime: (settings.pokerNightDefaults && settings.pokerNightDefaults.firstHandTime) || '7:30 PM CT',
      tableOpenTime: (settings.pokerNightDefaults && settings.pokerNightDefaults.tableOpenTime) || '7:00 PM CT',
      reminderOffsets: (settings.pokerNightDefaults && settings.pokerNightDefaults.reminderOffsetsMinutes) || [1440, 240, 30], // 24h, 4h, 30m
      announceChannelId: settings.lastChannels?.['pn-edit-channel'] || (findChannelByName('announcements')?.id || voteChannel.value),
      announceChannelName: (findChannelByName('announcements')?.name || channelName),
      reminderChannelId: settings.lastChannels?.['pn-edit-rem-channel'] || (findChannelByName('riff-room')?.id || voteChannel.value),
      reminderChannelName: (findChannelByName('riff-room')?.name || channelName),
      approvalChannelId: settings.approvalChannelId || (findChannelByName('clanker')?.id || ''),
      generatedAnnouncementText: null,
      generatedImageUrl: null,
      winningWeekday: null,
      computedFirstHandUtc: null,
      createdAt: serverTimestamp()
    });

    // patch poll job with workflow id
    await updateDoc(pollJobRef, { workflowId: wfRef.id });

    await writeLog('vote_open', `Poker Night vote scheduled for ${ctDateStr(scheduledDate)} in #${channelName}. Workflow ${wfRef.id.slice(0,6)} created.`, { workflowId: wfRef.id });
    alert(`✅ Vote scheduled. Workflow created. The bot will watch for the result and post an approval card in #${(findChannelByName('clanker')?.name || 'clanker')} when ready.`);
    pollData = null;
    previewWrap.innerHTML = '';
    previewWrap.classList.remove('show');
  }

  genBtn.addEventListener('click', generatePoll);
  schedBtn.addEventListener('click', scheduleVoteAndWorkflow);

  // ====== Workflow listing & edit-mode handling ======
  let editingWfId = null;

  function showEditMode(wf) {
    editingWfId = wf.id;
    editWrap.style.display = 'block';
    editText.value = wf.generatedAnnouncementText || '';
    editImage.value = wf.generatedImageUrl || '';
    updateImagePreview();
    if (wf.computedFirstHandUtc) {
      const d = wf.computedFirstHandUtc.toDate ? wf.computedFirstHandUtc.toDate() : new Date(wf.computedFirstHandUtc);
      editFirstHand.value = dateToLocalDatetimeStr(d);
    }
    if (wf.announceChannelId) editChannel.value = wf.announceChannelId;
    if (wf.reminderChannelId) editRemChannel.value = wf.reminderChannelId;
    editWrap.scrollIntoView({ behavior: 'smooth' });
    setStep('approve');
    statusPill.textContent = 'Edit Mode';
    statusPill.className = 'pn-status-pill pill-edit';
  }

  function hideEditMode() {
    editingWfId = null;
    editWrap.style.display = 'none';
  }

  function updateImagePreview() {
    const url = editImage.value.trim();
    editImagePreview.innerHTML = url ? `<img src="${url}" alt="preview" />` : '';
  }
  editImage.addEventListener('input', updateImagePreview);
  cancelEditBtn.addEventListener('click', hideEditMode);

  resubmitBtn.addEventListener('click', async () => {
    if (!editingWfId) return;
    if (!editText.value.trim()) { alert('Announcement text empty.'); return; }
    if (!editFirstHand.value) { alert('Set first-hand time.'); return; }
    if (!editChannel.value) { alert('Pick announce channel.'); return; }
    if (!editRemChannel.value) { alert('Pick reminders channel.'); return; }

    const firstHandDate = localDatetimeToUTC(editFirstHand.value);
    const announceOpt = editChannel.options[editChannel.selectedIndex];
    const remOpt = editRemChannel.options[editRemChannel.selectedIndex];
    const announceName = announceOpt ? announceOpt.textContent.replace('#','') : '';
    const remName = remOpt ? remOpt.textContent.replace('#','') : '';

    // Update workflow doc to approved + edited content
    await updateDoc(doc(db, 'vote_workflows', editingWfId), {
      status: 'approved',
      generatedAnnouncementText: editText.value,
      generatedImageUrl: editImage.value.trim() || null,
      computedFirstHandUtc: Timestamp.fromDate(firstHandDate),
      announceChannelId: editChannel.value,
      announceChannelName: announceName,
      reminderChannelId: editRemChannel.value,
      reminderChannelName: remName,
      approvedAt: serverTimestamp(),
      approvedSource: 'dashboard_edit'
    });

    // Schedule announcement + reminders directly from the dashboard.
    // (The bot also schedules these on Approve interaction; both paths land at
    // the same job docs by checking workflow status before bot-side enqueue.)
    const offsetsMin = (settings.pokerNightDefaults && settings.pokerNightDefaults.reminderOffsetsMinutes) || [1440, 240, 30];
    const announcementJob = {
      type: 'announcement',
      channelId: editChannel.value,
      channelName: announceName,
      content: editText.value,
      imageUrl: editImage.value.trim() || null,
      scheduledFor: Timestamp.fromDate(new Date(firstHandDate.getTime() - 6 * 24 * 3600 * 1000)), // ~6 days before by default
      status: 'pending',
      createdAt: serverTimestamp(),
      workflowId: editingWfId,
      sentAt: null, error: null
    };
    // Actually schedule announcement to send immediately (now) — Parker is approving live
    announcementJob.scheduledFor = Timestamp.now();
    await addDoc(collection(db, 'scheduled_jobs'), announcementJob);

    // Schedule 3 reminders relative to first-hand
    const reminderTexts = await generateReminderTexts(firstHandDate);
    for (let i = 0; i < offsetsMin.length; i++) {
      const offsetMs = offsetsMin[i] * 60 * 1000;
      const remTime = new Date(firstHandDate.getTime() - offsetMs);
      if (remTime <= new Date()) continue; // skip past reminders
      await addDoc(collection(db, 'scheduled_jobs'), {
        type: 'reminder',
        channelId: editRemChannel.value,
        channelName: remName,
        content: reminderTexts[i] || `Reminder: poker is coming up at ${ctTimeShort(firstHandDate)} CT.`,
        scheduledFor: Timestamp.fromDate(remTime),
        status: 'pending',
        createdAt: serverTimestamp(),
        workflowId: editingWfId,
        sentAt: null, error: null
      });
    }

    await writeLog('approved', `Workflow ${editingWfId.slice(0,6)} approved via dashboard. Announcement + reminders scheduled.`, { workflowId: editingWfId });
    alert('✅ Approved. Announcement queued for immediate send and reminders scheduled.');
    hideEditMode();
    statusPill.textContent = 'Approved';
    statusPill.className = 'pn-status-pill pill-approved';
  });

  async function generateReminderTexts(firstHandDate) {
    const tableOpenStr = (settings.pokerNightDefaults && settings.pokerNightDefaults.tableOpenTime) || '7:00 PM CT';
    const firstHandStr = (settings.pokerNightDefaults && settings.pokerNightDefaults.firstHandTime) || '7:30 PM CT';
    // Default texts (auto-generated, not regenerated by user)
    const defaults = [
      `🃏 Poker night is tomorrow at ${firstHandStr}! Hope to see everyone at the tables. 🂡`,
      `🎰 Heads up — Poker Night is in ~4 hours. First hand at ${firstHandStr}. Get your chips ready. ♠️`,
      `🂡 30 minutes out! Table opens at ${tableOpenStr.replace(' CT','')} — first hand at ${firstHandStr.replace(' CT','')}. Don't be late! ♣️`
    ];
    if (!settings.openrouterKey) return defaults;
    try {
      const prompt = `Write 3 short Discord reminder messages for an online poker night. First hand at ${firstHandStr}. Table opens at ${tableOpenStr}.

Reminder 1: 24 HOURS BEFORE — chill heads-up, "tomorrow"
Reminder 2: 4 HOURS BEFORE — energetic
Reminder 3: 30 MINUTES BEFORE — MUST literally say "Table opens at 7 — first hand at 7:30" (with the @everyone tag)

Return ONLY a JSON array of 3 strings, each under 240 chars. Use 1-2 poker emojis per message. No code fences.`;
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'Pitboss - Shadow Spade Lounge'
        },
        body: JSON.stringify({
          model: settings.openrouterModel || 'google/gemini-2.0-flash-lite-001',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      let txt = data.choices?.[0]?.message?.content?.trim() || '';
      txt = txt.replace(/^```(json)?\s*/i,'').replace(/\s*```$/,'').trim();
      const m = txt.match(/\[[\s\S]*\]/);
      if (!m) return defaults;
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr) || arr.length !== 3) return defaults;
      // Force 30-min copy correctness if it's missing
      if (!/Table opens at 7\b/i.test(arr[2])) {
        arr[2] = `🂡 30 min out — Table opens at 7, first hand at 7:30. @everyone don't be late! ♣️`;
      }
      return arr;
    } catch (e) {
      console.error('Reminder gen failed', e);
      return defaults;
    }
  }

  // Subscribe to vote_workflows for live status + edit_mode detection
  subscribeToWorkflows();

  function subscribeToWorkflows() {
    const q = query(collection(db, 'vote_workflows'), orderBy('createdAt', 'desc'), limit(10));
    onSnapshot(q, (snap) => {
      wfList.innerHTML = '';
      if (snap.empty) {
        wfList.innerHTML = '<div class="queue-empty">No active workflows.</div>';
        statusPill.textContent = 'Idle';
        statusPill.className = 'pn-status-pill';
        setStep('vote');
        return;
      }
      let firstActive = null;
      snap.forEach(d => {
        const wf = { id: d.id, ...d.data() };
        if (!firstActive && wf.status !== 'approved' && wf.status !== 'declined') firstActive = wf;
        renderWorkflowCard(wf);
      });

      // Pick the most recent non-terminal workflow to drive UI
      const drive = firstActive || { id: snap.docs[0].id, ...snap.docs[0].data() };
      driveUiFromWorkflow(drive);
    });
  }

  function driveUiFromWorkflow(wf) {
    const s = wf.status;
    if (s === 'scheduled') { setStep('vote'); statusPill.textContent = 'Vote Scheduled'; statusPill.className = 'pn-status-pill pill-vote'; }
    else if (s === 'awaiting_results') { setStep('watch'); statusPill.textContent = 'Watching Vote'; statusPill.className = 'pn-status-pill pill-watching'; }
    else if (s === 'generating') { setStep('generate'); statusPill.textContent = 'Generating'; statusPill.className = 'pn-status-pill pill-pending'; }
    else if (s === 'approval_pending') { setStep('approve'); statusPill.textContent = 'Awaiting Approval'; statusPill.className = 'pn-status-pill pill-pending'; }
    else if (s === 'edit_mode') { showEditMode(wf); }
    else if (s === 'approved') { setStep('schedule'); statusPill.textContent = 'Approved'; statusPill.className = 'pn-status-pill pill-approved'; }
    else if (s === 'declined') { statusPill.textContent = 'Declined'; statusPill.className = 'pn-status-pill pill-declined'; }
  }

  function renderWorkflowCard(wf) {
    const card = document.createElement('div');
    card.className = 'pn-workflow-card';
    const header = document.createElement('div');
    header.className = 'pn-wf-header';
    const title = document.createElement('div');
    title.className = 'pn-wf-title';
    title.textContent = `${MONTH_NAMES[(wf.month||1)-1] || ''} ${wf.year || ''} Workflow`;
    const pill = document.createElement('span');
    pill.className = 'pn-status-pill pill-' + (wf.status === 'approved' ? 'approved' : wf.status === 'declined' ? 'declined' : wf.status === 'edit_mode' ? 'edit' : wf.status === 'awaiting_results' ? 'watching' : 'pending');
    pill.textContent = (wf.status || 'unknown').replace(/_/g, ' ');
    header.appendChild(title);
    header.appendChild(pill);

    const meta = document.createElement('div');
    meta.className = 'pn-wf-meta';
    const parts = [];
    if (wf.pollScheduledFor) parts.push(`Vote: ${ctDateStr(wf.pollScheduledFor.toDate())}`);
    if (wf.winningWeekday) parts.push(`Winner: ${wf.winningWeekday}`);
    if (wf.computedFirstHandUtc) parts.push(`First hand: ${ctDateStr(wf.computedFirstHandUtc.toDate())}`);
    meta.textContent = parts.join('  •  ');

    const actions = document.createElement('div');
    actions.className = 'pn-wf-actions';

    if (wf.status === 'edit_mode' || wf.status === 'approval_pending' || wf.status === 'declined') {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '✏️ Open in Editor';
      editBtn.addEventListener('click', () => showEditMode(wf));
      actions.appendChild(editBtn);
    }
    if (wf.status !== 'approved') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-outline btn-sm';
      cancelBtn.textContent = '🗑 Cancel Workflow';
      cancelBtn.addEventListener('click', async () => {
        if (!confirm('Cancel this workflow? (Pending poll/announcement jobs will not be auto-cancelled.)')) return;
        await updateDoc(doc(db, 'vote_workflows', wf.id), { status: 'declined', declinedAt: serverTimestamp(), declinedSource: 'dashboard_cancel' });
        await writeLog('declined', `Workflow ${wf.id.slice(0,6)} cancelled from dashboard.`, { workflowId: wf.id });
      });
      actions.appendChild(cancelBtn);
    }

    card.appendChild(header);
    card.appendChild(meta);
    if (actions.children.length) card.appendChild(actions);
    wfList.appendChild(card);
  }
})();

// ==================== JOIN THE TABLE ====================
(function initTableLive() {
  const tableUrlInput = document.getElementById('table-url');
  const schedTimeInput = document.getElementById('table-schedule-time');
  const previewEl = document.getElementById('table-preview');
  const warnEl = document.getElementById('table-config-warn');

  (function setDefaultTime() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = fmt.formatToParts(now);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    schedTimeInput.value = `${y}-${m}-${d}T19:00`;
  })();

  function buildMessage(url) {
    return `The Table is LIVE: ${url}\n⚠️   Starting in: 30 min\n\n@everyone`;
  }
  function checkConfig() {
    const configured = settings.joinTableChannelId && settings.activeCategoryId;
    warnEl.style.display = configured ? 'none' : 'block';
    return !!configured;
  }
  tableUrlInput.addEventListener('input', () => {
    const url = tableUrlInput.value.trim();
    if (url) { previewEl.textContent = buildMessage(url); previewEl.style.display = 'block'; }
    else { previewEl.style.display = 'none'; }
  });
  document.getElementById('table-btn-test').addEventListener('click', async () => {
    const url = tableUrlInput.value.trim();
    if (!url) { alert('Please enter a table URL.'); return; }
    if (!settings.testChannelId) { alert('No test channel configured.'); return; }
    await addDoc(collection(db, 'scheduled_jobs'), {
      type: 'message', channelId: settings.testChannelId, channelName: settings.testChannelName,
      content: buildMessage(url), scheduledFor: Timestamp.now(), status: 'pending',
      createdAt: serverTimestamp(), sentAt: null, error: null
    });
    await writeLog('sent', `Test: Join The Table message sent to #${settings.testChannelName}`, {});
  });
  document.getElementById('table-btn-schedule').addEventListener('click', async () => {
    const url = tableUrlInput.value.trim();
    if (!url) { alert('Please enter a table URL.'); return; }
    if (!checkConfig()) { alert('Configure Join-the-Table settings first.'); return; }
    const dtVal = schedTimeInput.value;
    if (!dtVal) { alert('Please set a post time.'); return; }
    const scheduledDate = localDatetimeToUTC(dtVal);
    if (scheduledDate <= new Date()) { alert('Scheduled time must be in the future.'); return; }
    await addDoc(collection(db, 'scheduled_jobs'), {
      type: 'table_live', channelId: settings.joinTableChannelId,
      channelName: settings.joinTableChannelName || 'join-the-game',
      content: buildMessage(url), tableUrl: url, activeCategoryId: settings.activeCategoryId,
      scheduledFor: Timestamp.fromDate(scheduledDate), status: 'pending',
      createdAt: serverTimestamp(), sentAt: null, error: null
    });
    await writeLog('scheduled', `Join The Table scheduled for ${ctDateStr(scheduledDate)}`, { url });
    alert(`✅ Table link scheduled for ${ctDateStr(scheduledDate)} CT`);
    tableUrlInput.value = '';
    previewEl.style.display = 'none';
  });
  checkConfig();
})();

// ==================== COLLAPSIBLE PANELS ====================
(function initDashboardCollapsibles() {
  const PANELS = ['dash-panel-pokernight','dash-panel-broadcast','dash-panel-jointable'];
  PANELS.forEach(panelId => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const header = panel.querySelector('.panel-header.collapsible');
    if (!header) return;
    const savedOpen = localStorage.getItem(`dash-panel-open-${panelId}`);
    // Default poker night open, others collapsed
    const defaultOpen = panelId === 'dash-panel-pokernight';
    const open = savedOpen === null ? defaultOpen : savedOpen === 'true';
    if (!open) panel.classList.add('collapsed');
    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      localStorage.setItem(`dash-panel-open-${panelId}`, !panel.classList.contains('collapsed'));
    });
  });
})();

// ==================== START ====================
subscribeToUnifiedQueue();
subscribeToActivityLog();
