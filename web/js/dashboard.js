import { requireAuth, logout } from './auth.js';
import { db } from './firebase-init.js';
import {
  collection, doc, getDoc, addDoc, deleteDoc, onSnapshot,
  query, where, orderBy, Timestamp, serverTimestamp, updateDoc
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

function ctTimeStr(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date) + ' CT';
}

function localDatetimeToUTC(localStr) {
  // localStr is "YYYY-MM-DDTHH:MM" treated as CT
  const [datePart, timePart] = localStr.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  // Use Intl trick: create date as if UTC, then adjust
  // We format a test date in CT to find the offset
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

function renderDiscordMarkdown(text) {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Code blocks first
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic *
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // Italic _
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  // Underline
  html = html.replace(/__(.+?)__/g, '<u>$1</u>');
  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Quotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

async function writeLog(type, message, metadata = {}) {
  try {
    await addDoc(collection(db, 'logs'), {
      type, message, metadata,
      timestamp: serverTimestamp()
    });
  } catch (e) { console.error('Log write failed', e); }
}

// ==================== SETTINGS LOAD ====================
let settings = { channels: [], testChannelId: '', testChannelName: '', openrouterKey: '', openrouterModel: 'google/gemini-flash-1.5' };

// ==================== ANNOUNCEMENT CONSTANTS ====================
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

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'config'));
    if (snap.exists()) {
      settings = { ...settings, ...snap.data() };
    }
  } catch (e) { console.error('Settings load error', e); }
  populateChannelDropdowns();
}

function populateChannelDropdowns() {
  const dropdowns = document.querySelectorAll('.channel-dropdown');
  dropdowns.forEach(sel => {
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
      if (ch.id === current) opt.selected = true;
      sel.appendChild(opt);
    });
  });
}

await loadSettings();

// ==================== EMOJI PICKER ====================
const EMOJI_DATA = {
  'Smileys': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','☹️','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','🥴','😠','😡','🤬','😷','🤒','🤕','🤢','🤮','🤧','😇','🥳','🥺','🤠','🤡','🤥','🤫','🤭','🧐','🤓','😈','👿','👋','🤚','🖐','✋','🖖','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🤲','🤝','🙏'],
  'Activities': ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🥍','🏒','🥅','⛳','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸','🥌','🎯','🎿','🎳','🏋️','🤸','🤾','🏌️','🏇','🧘','🤺','🏊','🚴','🤼','🤽','🤾','🧗','🏄','🧜','🚣','🧑‍🤝‍🧑','🎠','🎡','🎢','🎪','🎭','🎨','🎰','🎲','🧩','🃏','🀄','🎴','🎹','🥁','🎷','🎺','🎸','🎻','🎤','🎧','📻','🎬','🎮'],
  'Food': ['🍎','🍊','🍋','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌽','🌶','🫑','🥕','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🧃','🥤','🧋','☕','🍵','🍶','🍾','🍷','🍸','🍹','🍺','🍻'],
  'Travel': ['🚗','🚕','🚙','🚌','🚎','🏎','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍','🛵','🚲','🛴','🛺','🚨','🚔','🚍','🚘','🚖','🚡','🚠','🚟','🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️','🛩','🛫','🛬','🪂','💺','🚁','🚟','⛵','🚤','🛥','🛳','⛴','🚢','⛽','🏗','⚓','🗺','🏔','⛰','🌋','🗻','🏕','🏖','🏜','🏝','🏞','🏟','🏛','🏗','🏘','🏙','🏚','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏧','🏨','🏩','🏪','🏫','🏬','🏭','🗼','🗽','⛪','🕌','🛕','🕍','⛩','🗾','🎌'],
  'Objects': ['⌚','📱','💻','🖥','🖨','⌨️','🖱','🖲','💾','💿','📀','📷','📸','📹','🎥','📽','🎞','📞','☎️','📟','📠','📺','📻','🧭','⏱','⏲','⏰','🕰','⌛','📡','🔋','🔌','💡','🔦','🕯','🪔','🗑','🛢','💸','💵','💴','💶','💷','💰','💳','🪙','💎','⚖️','🧰','🔧','🪛','🔩','⚙️','🗜','🔗','⛓','🧲','🔫','💣','🧨','🪓','🔪','🗡','⚔️','🛡','🚪','🪞','🪟','🛏','🛋','🪑','🚽','🚿','🛁','🧴','🧷','🧹','🧺','🧻','🧼','🫧','🔑','🗝','🔐','🔏','🔒','🔓','📦','📫','📪','📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉'],
  'Symbols': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉','☯️','✡️','🔯','🕎','☦️','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🔀','🔁','🔂','▶️','⏩','⏪','⏫','⏬','◀️','⏮','⏭','🔼','🔽','⏏️','🎦','🔅','🔆','📶','📳','📴','♾','⚠️','🚸','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵','🔞','💯','🔔','🔕','🎵','🎶','✅','❎','🆗','🆙','🆕','🆓','🆒','🆖','🆚','💠','🔷','🔹','🔶','🔸','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','♠️','♥️','♦️','♣️','🃏','🎴'],
  'Flags': ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇺🇸','🇬🇧','🇨🇦','🇦🇺','🇩🇪','🇫🇷','🇯🇵','🇨🇳','🇧🇷','🇮🇳','🇲🇽','🇮🇹','🇪🇸','🇰🇷','🇷🇺','🇸🇦','🇿🇦','🇳🇬','🇦🇷','🇸🇪','🇳🇴','🇩🇰','🇫🇮','🇳🇱','🇧🇪','🇨🇭','🇦🇹','🇵🇱','🇨🇿','🇭🇺','🇬🇷','🇹🇷','🇮🇱','🇦🇪','🇮🇷','🇵🇰','🇧🇩','🇹🇭','🇻🇳','🇵🇭','🇮🇩','🇲🇾']
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
  const gridWrap = document.createElement('div');
  gridWrap.style.padding = '0';

  const catIcons = { 'Smileys':'😀', 'Activities':'⚽', 'Food':'🍔', 'Travel':'✈️', 'Objects':'💡', 'Symbols':'♠️', 'Flags':'🏁' };

  Object.entries(EMOJI_DATA).forEach(([cat, emojis], idx) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'emoji-tab' + (idx === 0 ? ' active' : '');
    tab.title = cat;
    tab.textContent = catIcons[cat] || cat[0];
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderGrid(emojis);
    });
    tabs.appendChild(tab);
  });

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

  renderGrid(EMOJI_DATA['Smileys']);
  gridWrap.appendChild(grid);

  panel.appendChild(tabs);
  panel.appendChild(gridWrap);
  wrap.appendChild(panel);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) panel.classList.remove('show');
  });

  return wrap;
}

// ==================== RICH TEXT TOOLBAR ====================
function buildToolbar(textarea) {
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const tools = [
    { label: 'B', title: 'Bold', tag: '**', style: 'font-weight:700' },
    { label: 'I', title: 'Italic', tag: '*', style: 'font-style:italic' },
    { label: 'U', title: 'Underline', tag: '__', style: 'text-decoration:underline' },
    { label: 'S', title: 'Strikethrough', tag: '~~', style: 'text-decoration:line-through' },
    null,
    { label: '`', title: 'Code', tag: '`', style: 'font-family:monospace' },
    { label: '```', title: 'Code Block', multiline: true },
    null,
    { label: '🔗', title: 'Link', link: true },
    null,
    { label: '• List', title: 'Unordered List', listType: 'ul' },
    { label: '1. List', title: 'Ordered List', listType: 'ol' },
    { label: '❝', title: 'Quote', quote: true },
  ];

  tools.forEach(t => {
    if (!t) {
      const sep = document.createElement('div');
      sep.className = 'toolbar-sep';
      toolbar.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn';
    btn.title = t.title;
    btn.innerHTML = `<span style="${t.style || ''}">${t.label}</span>`;

    btn.addEventListener('click', () => {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = textarea.value.slice(start, end);
      let newText = '';
      let cursorOffset = 0;

      if (t.multiline) {
        newText = '```\n' + (selected || 'code here') + '\n```';
        cursorOffset = selected ? newText.length : 4;
      } else if (t.link) {
        const url = prompt('Enter URL:', 'https://');
        if (!url) return;
        newText = `[${selected || 'link text'}](${url})`;
        cursorOffset = newText.length;
      } else if (t.listType === 'ul') {
        const lines = (selected || 'item').split('\n');
        newText = lines.map(l => `- ${l}`).join('\n');
        cursorOffset = newText.length;
      } else if (t.listType === 'ol') {
        const lines = (selected || 'item').split('\n');
        newText = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
        cursorOffset = newText.length;
      } else if (t.quote) {
        const lines = (selected || 'quote').split('\n');
        newText = lines.map(l => `> ${l}`).join('\n');
        cursorOffset = newText.length;
      } else {
        newText = `${t.tag}${selected || t.title.toLowerCase()}${t.tag}`;
        cursorOffset = selected ? newText.length : t.tag.length;
      }

      textarea.value = textarea.value.slice(0, start) + newText + textarea.value.slice(end);
      textarea.selectionStart = start + (selected ? cursorOffset : cursorOffset);
      textarea.selectionEnd = start + (selected ? cursorOffset : cursorOffset);
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

function renderQueueCard(job, container, editCallback) {
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
  if (job.type === 'poll' && job.pollData) {
    previewText = job.pollData.title || 'Poll';
  } else {
    previewText = (job.content || '').replace(/\n/g, ' ').slice(0, 100);
  }
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

  if (editCallback) {
    card.addEventListener('click', () => editCallback(job));
  }

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
    snap.forEach(d => renderQueueCard({ id: d.id, ...d.data() }, container, null));
  });
}

// ==================== COLUMN 1: BROADCAST ====================
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

  let editingJobId = null;

  async function sendMessage(channelId, channelName, content, clear = true) {
    if (!content.trim()) { alert('Message cannot be empty.'); return; }
    if (!channelId) { alert('Please select a channel.'); return; }
    const job = {
      type: 'message',
      channelId, channelName: channelName || channelId,
      content,
      scheduledFor: Timestamp.now(),
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null
    };
    await addDoc(collection(db, 'scheduled_jobs'), job);
    await writeLog('sent', `Message queued for immediate send to #${channelName}`, { channelId, preview: content.slice(0, 80) });
    if (clear) { textarea.value = ''; previewContent.innerHTML = ''; editingJobId = null; }
  }

  async function scheduleMessage(channelId, channelName, content, dtLocal) {
    if (!content.trim()) { alert('Message cannot be empty.'); return; }
    if (!channelId) { alert('Please select a channel.'); return; }
    if (!dtLocal) { alert('Please select a date and time.'); return; }
    const scheduledDate = localDatetimeToUTC(dtLocal);
    if (scheduledDate <= new Date()) { alert('Scheduled time must be in the future.'); return; }
    const job = {
      type: 'message',
      channelId, channelName: channelName || channelId,
      content,
      scheduledFor: Timestamp.fromDate(scheduledDate),
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null
    };
    await addDoc(collection(db, 'scheduled_jobs'), job);
    await writeLog('scheduled', `Message scheduled for ${ctDateStr(scheduledDate)} in #${channelName}`, { channelId });
    textarea.value = ''; previewContent.innerHTML = '';
    schedPicker.classList.remove('show');
    editingJobId = null;
    alert(`Message scheduled for ${ctDateStr(scheduledDate)} CT`);
  }

  document.getElementById('msg-btn-test').addEventListener('click', async () => {
    if (!settings.testChannelId) { alert('No test channel configured. Go to Settings.'); return; }
    await sendMessage(settings.testChannelId, settings.testChannelName, textarea.value, false);
    await writeLog('sent', `Test message sent to #${settings.testChannelName}`, {});
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

  function loadJobIntoEditor(job) {
    textarea.value = job.content || '';
    previewContent.innerHTML = renderDiscordMarkdown(job.content || '');
    editingJobId = job.id;
    if (job.channelId) channelSel.value = job.channelId;
    textarea.scrollIntoView({ behavior: 'smooth' });
  }

})();

// ==================== COLUMN 2: POLL GENERATOR ====================
(function initPollGenerator() {
  const monthSel = document.getElementById('poll-month');
  const yearSel = document.getElementById('poll-year');
  const genBtn = document.getElementById('poll-gen-btn');
  const previewArea = document.getElementById('poll-preview');
  const previewWrap = document.getElementById('poll-preview-wrap');
  const schedPicker = document.getElementById('poll-schedule-picker');
  const schedDatetime = document.getElementById('poll-schedule-datetime');

  // Default to next month
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

  genBtn.addEventListener('click', async () => {
    const month = parseInt(monthSel.value);
    const year = parseInt(yearSel.value);
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const thursdays = getThursdaysInMonth(year, month);

    if (!settings.openrouterKey) {
      alert('OpenRouter API key not configured. Go to Settings.');
      return;
    }

    previewWrap.innerHTML = '<div class="poll-generating"><div class="spinner"></div>Generating poll with AI...</div>';
    previewWrap.classList.add('show');

    const thursdayList = thursdays.map(d => {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${mm}/${dd}`;
    }).join(', ');

    const prompt = `Generate a Discord poker night vote poll for ${monthNames[month-1]} ${year}.

The poll is for the Shadow Spade Lounge poker group. They meet on Thursdays at 7:30 PM CT.

Thursdays in ${monthNames[month-1]} ${year}: ${thursdayList}

Return ONLY a JSON object with this exact structure:
{
  "title": "[emoji] ${monthNames[month-1]} ${year} Monthly Poker Night Vote [emoji]",
  "options": [
    { "emoji": "🃏", "label": "Thurs (MM/DD) @ 7:30 PM CT", "holidayNote": "" }
  ]
}

Rules:
- Title should have a month-thematic emoji on EACH side (e.g. 🎃 for October, 🦃 for November, ❄️ for December, 🌸 for April, etc.)
- Each option must follow format: "Thurs (MM/DD) @ 7:30 PM CT"
- Each option gets a relevant emoji. Consider nearby national/fun holidays for that Thursday. If a Thursday falls on or near a holiday, note it in holidayNote.
- Provide one option per Thursday in the month
- Return ONLY valid JSON, no other text`;

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
          model: settings.openrouterModel || 'google/gemini-2.0-flash-lite',
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`OpenRouter HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await res.json();
      let content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('OpenRouter returned an empty response.');

      // Strip markdown code fences if present
      content = content.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      // Extract JSON object if there's surrounding text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in model response.');

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.title || !Array.isArray(parsed.options)) throw new Error('Unexpected JSON structure from model.');

      pollData = parsed;
      renderPollPreview(parsed);
      await addDoc(collection(db, 'logs'), { type: 'success', message: `Poll generated for ${monthNames[month-1]} ${year} (${parsed.options.length} options).`, timestamp: serverTimestamp(), metadata: {} });
    } catch (err) {
      previewWrap.innerHTML = `<div style="color:var(--red-text);padding:16px;font-size:13px;"><strong>Poll generation failed</strong><br><br>${err.message}</div>`;
      await addDoc(collection(db, 'logs'), { type: 'error', message: `Poll generation failed: ${err.message}`, timestamp: serverTimestamp(), metadata: {} });
    }
  });

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
      emojiSpan.style.cursor = 'text';
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
    meta.textContent = '✅ Multiple answers allowed  •  ⏱ 7-day duration';
    previewWrap.appendChild(meta);
  }

  function getCurrentPollData() {
    return pollData;
  }

  async function submitPoll(channelId, channelName, immediate, dtLocal) {
    const pd = getCurrentPollData();
    if (!pd) { alert('Please generate a poll first.'); return; }
    if (!channelId) { alert('Please select a channel.'); return; }

    let scheduledFor;
    if (immediate) {
      scheduledFor = Timestamp.now();
    } else {
      if (!dtLocal) { alert('Please select a date and time.'); return; }
      const d = localDatetimeToUTC(dtLocal);
      if (d <= new Date()) { alert('Scheduled time must be in the future.'); return; }
      scheduledFor = Timestamp.fromDate(d);
    }

    const job = {
      type: 'poll',
      channelId, channelName: channelName || channelId,
      content: pd.title,
      pollData: {
        title: pd.title,
        options: pd.options.map(o => ({ emoji: o.emoji, text: o.label })),
        multiSelect: true,
        duration: 7 * 24 // hours
      },
      scheduledFor,
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null
    };

    await addDoc(collection(db, 'scheduled_jobs'), job);
    const action = immediate ? 'queued for immediate send' : `scheduled for ${ctDateStr(scheduledFor.toDate())}`;
    await writeLog(immediate ? 'sent' : 'scheduled', `Poll "${pd.title}" ${action} to #${channelName}`, { channelId });

    if (!immediate) {
      schedPicker.classList.remove('show');
      alert(`Poll scheduled for ${ctDateStr(scheduledFor.toDate())} CT`);
    }
    pollData = null;
    previewWrap.innerHTML = '';
    previewWrap.classList.remove('show');
  }

  document.getElementById('poll-btn-test').addEventListener('click', async () => {
    if (!settings.testChannelId) { alert('No test channel configured.'); return; }
    await submitPoll(settings.testChannelId, settings.testChannelName, true);
  });

  document.getElementById('poll-btn-send').addEventListener('click', async () => {
    const channelSel = document.getElementById('poll-channel');
    const opt = channelSel.options[channelSel.selectedIndex];
    await submitPoll(channelSel.value, opt ? opt.textContent.replace('#','') : '', true);
  });

  document.getElementById('poll-btn-schedule').addEventListener('click', () => {
    schedPicker.classList.toggle('show');
  });

  document.getElementById('poll-btn-confirm-schedule').addEventListener('click', async () => {
    const channelSel = document.getElementById('poll-channel');
    const opt = channelSel.options[channelSel.selectedIndex];
    await submitPoll(channelSel.value, opt ? opt.textContent.replace('#','') : '', false, schedDatetime.value);
  });

})();

// ==================== COLUMN 3: ANNOUNCEMENT ====================
(function initAnnouncement() {
  const pokerDateInput = document.getElementById('poker-date');
  const channelSel = document.getElementById('announce-channel');
  const imageUrlInput = document.getElementById('announce-image-url');
  const genBtn = document.getElementById('announce-gen-btn');
  const previewWrap = document.getElementById('announce-preview-wrap');
  const previewText = document.getElementById('announce-preview-text');
  const schedPicker = document.getElementById('announce-schedule-picker');
  const schedDatetime = document.getElementById('announce-schedule-datetime');

  function buildAnnouncementText(pokerDate) {
    const monthNumFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric' });
    const ctMonth = parseInt(monthNumFmt.format(pokerDate));

    const [emoji1, emoji2] = MONTH_EMOJIS[ctMonth] || ['🃏', '♠️'];
    const memoList = MEMO_WORDS[ctMonth] || ['payup'];
    const memo = memoList[Math.floor(Math.random() * memoList.length)];
    const monthNameFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long' });
    const yearFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' });
    const monthName = monthNameFmt.format(pokerDate);
    const year = yearFmt.format(pokerDate);
    const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long' });
    const shortDateFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric'
    });
    const weekday = weekdayFmt.format(pokerDate);
    const shortDate = shortDateFmt.format(pokerDate);

    return `${emoji1}   ${monthName} ${year} Round Poker Night  ${emoji2}

🗓️ Date: ${weekday}, ${shortDate}
⏰ Time: 7:30 PM CT
🎮 Platform: PokerNow (link drops in #join-the-game ~7 PM)
💰 Buy-in: $20 minimum via Venmo/CashApp
🤑  Blinds: 10/20
📩 Deposit Memo: ${memo}

@everyone

👇🏼  ✅  or ❌  below if you think you'll stop by! 👇🏼`;
  }

  genBtn.addEventListener('click', () => {
    const val = pokerDateInput.value;
    if (!val) { alert('Please enter the poker night date first.'); return; }
    const pokerDate = localDatetimeToUTC(val);
    previewText.value = buildAnnouncementText(pokerDate);
    previewWrap.style.display = 'block';
  });

  async function submitAnnouncement(channelId, channelName, immediate, dtLocal) {
    const content = previewText.value.trim();
    if (!content) { alert('Announcement content is empty.'); return; }
    if (!channelId) { alert('Please select a channel.'); return; }

    let scheduledFor;
    if (immediate) {
      scheduledFor = Timestamp.now();
    } else {
      if (!dtLocal) { alert('Please select a date and time.'); return; }
      const d = localDatetimeToUTC(dtLocal);
      if (d <= new Date()) { alert('Scheduled time must be in the future.'); return; }
      scheduledFor = Timestamp.fromDate(d);
    }

    const imageUrl = imageUrlInput.value.trim() || null;

    const job = {
      type: 'announcement',
      channelId, channelName: channelName || channelId,
      content,
      imageUrl,
      scheduledFor,
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null
    };

    await addDoc(collection(db, 'scheduled_jobs'), job);
    const action = immediate ? 'queued for immediate send' : `scheduled for ${ctDateStr(scheduledFor.toDate())}`;
    await writeLog(immediate ? 'sent' : 'scheduled', `Announcement ${action} to #${channelName}`, { channelId });

    if (!immediate) {
      schedPicker.classList.remove('show');
      alert(`Announcement scheduled for ${ctDateStr(scheduledFor.toDate())} CT`);
    }
  }

  document.getElementById('announce-btn-test').addEventListener('click', async () => {
    if (!settings.testChannelId) { alert('No test channel configured. Go to Settings.'); return; }
    await submitAnnouncement(settings.testChannelId, settings.testChannelName, true);
  });

  document.getElementById('announce-btn-send').addEventListener('click', async () => {
    const opt = channelSel.options[channelSel.selectedIndex];
    await submitAnnouncement(channelSel.value, opt ? opt.textContent.replace('#','') : '', true);
  });

  document.getElementById('announce-btn-schedule').addEventListener('click', () => {
    schedPicker.classList.toggle('show');
  });

  document.getElementById('announce-btn-confirm-schedule').addEventListener('click', async () => {
    const opt = channelSel.options[channelSel.selectedIndex];
    await submitAnnouncement(channelSel.value, opt ? opt.textContent.replace('#','') : '', false, schedDatetime.value);
  });
})();

// ==================== COLUMN 3: REMINDERS ====================
(function initReminders() {
  const pokerDateInput = document.getElementById('poker-date');
  const genBtn = document.getElementById('reminders-gen-btn');
  const remindersContainer = document.getElementById('reminders-container');
  const schedAllBtn = document.getElementById('reminders-schedule-all');

  let reminderJobs = [];

  genBtn.addEventListener('click', () => {
    const val = pokerDateInput.value;
    if (!val) { alert('Please enter the next poker night date.'); return; }

    const pokerDate = localDatetimeToUTC(val);

    const minus24h = new Date(pokerDate.getTime() - 24 * 60 * 60 * 1000);

    const pokerFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const pParts = pokerFormatter.formatToParts(pokerDate);
    const pYear = +pParts.find(p => p.type === 'year').value;
    const pMonth = +pParts.find(p => p.type === 'month').value;
    const pDay = +pParts.find(p => p.type === 'day').value;

    const noonCT = localDatetimeToUTC(`${pYear}-${String(pMonth).padStart(2,'0')}-${String(pDay).padStart(2,'0')}T12:00`);
    const sixThirtyCT = localDatetimeToUTC(`${pYear}-${String(pMonth).padStart(2,'0')}-${String(pDay).padStart(2,'0')}T18:30`);

    reminderJobs = [
      {
        label: '24H Before',
        time: minus24h,
        timeStr: ctDateStr(minus24h),
        content: `🃏 Poker night is tomorrow at 7:30 PM CT! Hope to see everyone at the tables. 🂡`
      },
      {
        label: 'Day-of 12:00 PM CT',
        time: noonCT,
        timeStr: ctDateStr(noonCT),
        content: `🎰 Friendly reminder — Poker Night is TONIGHT at 7:30 PM CT! Get your chips ready. ♠️`
      },
      {
        label: 'Day-of 6:30 PM CT',
        time: sixThirtyCT,
        timeStr: ctDateStr(sixThirtyCT),
        content: `🂡 One hour to go! Tables open at 7:30 PM CT tonight. Don't be late! ♣️`
      }
    ];

    renderReminders();
    schedAllBtn.style.display = 'block';
  });

  async function scheduleReminder(idx, immediate, dtOverride, channelId, channelName) {
    const r = reminderJobs[idx];
    const textarea = remindersContainer.querySelectorAll('.reminder-text')[idx];
    const content = textarea ? textarea.value : r.content;

    if (!channelId) { alert('Please select a channel for this reminder.'); return; }

    const scheduledFor = immediate
      ? Timestamp.now()
      : Timestamp.fromDate(dtOverride || r.time);

    const job = {
      type: 'reminder',
      channelId, channelName,
      content,
      scheduledFor,
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null
    };

    await addDoc(collection(db, 'scheduled_jobs'), job);
    const action = immediate ? 'sent immediately' : `scheduled for ${ctDateStr((dtOverride || r.time))}`;
    await writeLog(immediate ? 'sent' : 'scheduled', `Reminder "${r.label}" ${action}`, { channelId });
  }

  function makeChannelDropdown() {
    const sel = document.createElement('select');
    sel.className = 'form-control channel-dropdown';
    sel.innerHTML = '<option value="">-- Select Channel --</option>';
    if (settings.channels && settings.channels.length > 0) {
      settings.channels.forEach(ch => {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = `#${ch.name}`;
        sel.appendChild(opt);
      });
    }
    return sel;
  }

  function getCardChannel(chSel) {
    const opt = chSel.options[chSel.selectedIndex];
    return {
      channelId: chSel.value,
      channelName: opt ? opt.textContent.replace('#', '') : chSel.value
    };
  }

  function renderReminders() {
    remindersContainer.innerHTML = '';

    reminderJobs.forEach((r, idx) => {
      const card = document.createElement('div');
      card.className = 'reminder-card';

      const label = document.createElement('div');
      label.className = 'reminder-card-label';
      label.textContent = r.label;

      const timeEl = document.createElement('div');
      timeEl.className = 'reminder-card-time';
      timeEl.textContent = r.timeStr;

      const textarea = document.createElement('textarea');
      textarea.className = 'reminder-text';
      textarea.value = r.content;
      textarea.rows = 3;

      // Per-card channel selector
      const chWrap = document.createElement('div');
      chWrap.className = 'form-group';
      chWrap.style.marginTop = '8px';
      const chLabel = document.createElement('label');
      chLabel.textContent = 'Channel';
      chLabel.style.cssText = 'font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:6px;';
      const chSel = makeChannelDropdown();
      chWrap.appendChild(chLabel);
      chWrap.appendChild(chSel);

      const schedPickerEl = document.createElement('div');
      schedPickerEl.className = 'schedule-picker';
      schedPickerEl.innerHTML = `
        <label>Date & Time (CT)</label>
        <input type="datetime-local" class="form-control rem-dt" style="margin-bottom:8px" />
        <button type="button" class="btn btn-gold btn-sm rem-confirm-sched">Confirm Schedule</button>
      `;

      const btnRow = document.createElement('div');
      btnRow.className = 'btn-row';
      btnRow.style.marginTop = '10px';

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn btn-outline btn-sm';
      testBtn.textContent = '🧪 Test';
      testBtn.addEventListener('click', async () => {
        if (!settings.testChannelId) { alert('No test channel configured.'); return; }
        const content = textarea.value;
        await addDoc(collection(db, 'scheduled_jobs'), {
          type: 'reminder', channelId: settings.testChannelId, channelName: settings.testChannelName,
          content, scheduledFor: Timestamp.now(), status: 'pending',
          createdAt: serverTimestamp(), sentAt: null, error: null
        });
        await writeLog('sent', `Test reminder sent: ${r.label}`, {});
      });

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'btn btn-gold btn-sm';
      sendBtn.textContent = '⚡ Send Now';
      sendBtn.addEventListener('click', async () => {
        const { channelId, channelName } = getCardChannel(chSel);
        await scheduleReminder(idx, true, null, channelId, channelName);
        alert('Reminder sent!');
      });

      const schedBtn = document.createElement('button');
      schedBtn.type = 'button';
      schedBtn.className = 'btn btn-outline btn-sm';
      schedBtn.textContent = '📅 Schedule';
      schedBtn.addEventListener('click', () => schedPickerEl.classList.toggle('show'));

      schedPickerEl.querySelector('.rem-confirm-sched').addEventListener('click', async () => {
        const dtVal = schedPickerEl.querySelector('.rem-dt').value;
        if (!dtVal) { alert('Please select a date and time.'); return; }
        const dt = localDatetimeToUTC(dtVal);
        const { channelId, channelName } = getCardChannel(chSel);
        await scheduleReminder(idx, false, dt, channelId, channelName);
        schedPickerEl.classList.remove('show');
        alert(`Reminder scheduled for ${ctDateStr(dt)} CT`);
      });

      btnRow.appendChild(testBtn);
      btnRow.appendChild(sendBtn);
      btnRow.appendChild(schedBtn);

      card.appendChild(label);
      card.appendChild(timeEl);
      card.appendChild(textarea);
      card.appendChild(chWrap);
      card.appendChild(btnRow);
      card.appendChild(schedPickerEl);
      remindersContainer.appendChild(card);
    });
  }

  schedAllBtn.style.display = 'none';
  schedAllBtn.addEventListener('click', async () => {
    if (!reminderJobs.length) { alert('Generate reminders first.'); return; }
    const cards = remindersContainer.querySelectorAll('.reminder-card');
    // Validate all channels selected
    let allValid = true;
    cards.forEach((card, idx) => {
      const chSel = card.querySelector('select');
      if (!chSel || !chSel.value) {
        alert(`Please select a channel for reminder ${idx + 1}.`);
        allValid = false;
      }
    });
    if (!allValid) return;
    if (!confirm('Schedule all 3 reminders?')) return;

    for (let i = 0; i < reminderJobs.length; i++) {
      const card = cards[i];
      const chSel = card.querySelector('select');
      const { channelId, channelName } = getCardChannel(chSel);
      await scheduleReminder(i, false, null, channelId, channelName);
    }
    await writeLog('scheduled', 'All 3 reminders scheduled', {});
    alert('All 3 reminders scheduled!');
  });
})();

// ==================== JOIN THE TABLE ====================
(function initTableLive() {
  const tableUrlInput = document.getElementById('table-url');
  const schedTimeInput = document.getElementById('table-schedule-time');
  const previewEl = document.getElementById('table-preview');
  const warnEl = document.getElementById('table-config-warn');

  // Default schedule time: 7:00 PM CT today
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
    if (url) {
      previewEl.textContent = buildMessage(url);
      previewEl.style.display = 'block';
    } else {
      previewEl.style.display = 'none';
    }
  });

  document.getElementById('table-btn-test').addEventListener('click', async () => {
    const url = tableUrlInput.value.trim();
    if (!url) { alert('Please enter a table URL.'); return; }
    if (!settings.testChannelId) { alert('No test channel configured. Go to Settings.'); return; }
    const content = buildMessage(url);
    await addDoc(collection(db, 'scheduled_jobs'), {
      type: 'message',
      channelId: settings.testChannelId,
      channelName: settings.testChannelName,
      content,
      scheduledFor: Timestamp.now(),
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null
    });
    await writeLog('sent', `Test: Join The Table message sent to #${settings.testChannelName}`, {});
  });

  document.getElementById('table-btn-schedule').addEventListener('click', async () => {
    const url = tableUrlInput.value.trim();
    if (!url) { alert('Please enter a table URL.'); return; }
    if (!checkConfig()) { alert('Configure Join-the-Table settings first (Settings → 🃏 Join The Table).'); return; }
    const dtVal = schedTimeInput.value;
    if (!dtVal) { alert('Please set a post time.'); return; }
    const scheduledDate = localDatetimeToUTC(dtVal);
    if (scheduledDate <= new Date()) { alert('Scheduled time must be in the future.'); return; }

    const content = buildMessage(url);
    const job = {
      type: 'table_live',
      channelId: settings.joinTableChannelId,
      channelName: settings.joinTableChannelName || 'join-the-game',
      content,
      tableUrl: url,
      activeCategoryId: settings.activeCategoryId,
      scheduledFor: Timestamp.fromDate(scheduledDate),
      status: 'pending',
      createdAt: serverTimestamp(),
      sentAt: null, error: null
    };
    await addDoc(collection(db, 'scheduled_jobs'), job);
    await writeLog('scheduled', `Join The Table scheduled for ${ctDateStr(scheduledDate)}`, { url });
    alert(`✅ Table link scheduled for ${ctDateStr(scheduledDate)} CT`);
    tableUrlInput.value = '';
    previewEl.style.display = 'none';
  });

  // Check config on load
  checkConfig();
})();

// ==================== COLLAPSIBLE PANELS ====================
(function initDashboardCollapsibles() {
  const PANELS = ['dash-panel-broadcast', 'dash-panel-poll', 'dash-panel-remind'];
  PANELS.forEach(panelId => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const header = panel.querySelector('.panel-header.collapsible');
    if (!header) return;

    // Default: collapsed. Restore if user previously opened it.
    const savedOpen = localStorage.getItem(`dash-panel-open-${panelId}`) === 'true';
    if (!savedOpen) panel.classList.add('collapsed');

    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      localStorage.setItem(`dash-panel-open-${panelId}`, !panel.classList.contains('collapsed'));
    });
  });
})();

// ==================== UNIFIED QUEUE ====================
subscribeToUnifiedQueue();
