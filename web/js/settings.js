import { requireAuth, logout } from './auth.js';
import { db } from './firebase-init.js';
import {
  doc, getDoc, setDoc, collection, onSnapshot,
  query, orderBy, limit, deleteDoc, getDocs,
  serverTimestamp, addDoc, where
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { initParticles } from './particles.js';
import { initNavStats } from './nav-stats.js';

const user = await requireAuth('index.html');
document.getElementById('logout-btn').addEventListener('click', logout);

// ==================== BACKGROUND + NAV STATS ====================
initParticles('smoke-canvas');
initNavStats();

// ==================== HELPERS ====================
async function writeLog(type, message, metadata = {}) {
  await addDoc(collection(db, 'logs'), {
    type, message, metadata,
    timestamp: serverTimestamp()
  });
}

const HARDCODED_SERVER_ID = '1374936866188689489';

function ctTimeStr(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
  }).format(date) + ' CT';
}

// ==================== SETTINGS LOAD/SAVE ====================
const SETTINGS_DOC = doc(db, 'settings', 'config');
let currentSettings = {};

async function loadSettings() {
  const snap = await getDoc(SETTINGS_DOC);
  if (snap.exists()) {
    currentSettings = snap.data();
    applySettingsToUI(currentSettings);
  }
}

function applySettingsToUI(s) {
  const tokenInput = document.getElementById('bot-token-input');
  if (s.discordToken) {
    tokenInput.placeholder = 'Token saved — paste new token to replace';
  }
  if (s.openrouterKey) document.getElementById('or-key').value = s.openrouterKey;
  if (s.openrouterModel) document.getElementById('or-model').value = s.openrouterModel;
  renderChannelList(s.channels || []);
  updateTestChannelDropdown(s.channels || [], s.testChannelId);
  // Discord badge is set by the heartbeat onSnapshot listener — don't override it here.
  if (s.openrouterKey) setOrBadge('unknown', 'Configured');
  setChannelsBadge((s.channels || []).filter(c => c.name && c.id).length);
  loadPersonality(s);
  applyJoinTableSettings(s);
}

async function saveSettings(updates) {
  currentSettings = { ...currentSettings, ...updates };
  await setDoc(SETTINGS_DOC, currentSettings, { merge: true });
}

// ==================== BOT TOKEN SAVE & CONNECT ====================
const botTokenInput = document.getElementById('bot-token-input');
const botTokenSaveBtn = document.getElementById('bot-token-save-btn');
const botTokenStatus = document.getElementById('bot-token-status');

botTokenSaveBtn.addEventListener('click', async () => {
  const token = botTokenInput.value.trim();
  if (!token) { alert('Please paste a bot token.'); return; }
  botTokenSaveBtn.disabled = true;
  botTokenSaveBtn.textContent = 'Saving...';
  botTokenStatus.style.color = 'var(--text-dim)';
  botTokenStatus.textContent = '💾 Saving token to config...';
  try {
    await saveSettings({ discordToken: token });
    await writeLog('connection', 'Bot token updated via dashboard.', {});
    botTokenStatus.textContent = '🔄 Token saved. Sending restart command...';
    const restartSentAt = Date.now();
    await sendBotCommand('restart');
    // Wait for a heartbeat written AFTER restartSentAt using onSnapshot (zero polling reads).
    botTokenStatus.style.color = '#fbbf24';
    let tokenCountdown = 60;
    const tokenCountdownIv = setInterval(() => {
      tokenCountdown--;
      botTokenStatus.textContent = `⏳ Waiting for bot to reconnect... (${tokenCountdown}s)`;
    }, 1000);

    let tokenResolved = false;
    const tokenTimer = setTimeout(() => {
      if (tokenResolved) return;
      tokenResolved = true;
      clearInterval(tokenCountdownIv);
      tokenUnsub();
      botTokenStatus.style.color = '#f87171';
      botTokenStatus.textContent = '⚠️ Bot did not reconnect within 60s. Check PM2 logs on the server.';
      setBotStatus('offline');
      botTokenSaveBtn.disabled = false;
      botTokenSaveBtn.textContent = 'Save & Connect';
    }, 60000);

    const tokenUnsub = onSnapshot(
      doc(db, 'bot_status', 'heartbeat'),
      async (snap) => {
        if (tokenResolved) return;
        if (snap.exists()) {
          const ts = snap.data().lastSeen?.toDate();
          if (ts && ts.getTime() > restartSentAt) {
            tokenResolved = true;
            clearTimeout(tokenTimer);
            clearInterval(tokenCountdownIv);
            tokenUnsub();
            botTokenStatus.style.color = '#4ade80';
            botTokenStatus.textContent = `✅ Bot is online as ${snap.data().tag || 'connected'}!`;
            setBotStatus('online');
            botTokenSaveBtn.disabled = false;
            botTokenSaveBtn.textContent = 'Save & Connect';
            await writeLog('connection', `Bot reconnected after token update: ${snap.data().tag}`, {});
          }
        }
      }
    );
  } catch (e) {
    botTokenStatus.style.color = '#f87171';
    botTokenStatus.textContent = `❌ Error: ${e.message}`;
    await writeLog('error', `Token save failed: ${e.message}`, {});
    botTokenSaveBtn.disabled = false;
    botTokenSaveBtn.textContent = 'Save & Connect';
  }
});

// ==================== BOT STATUS ====================
const botStatusPill = document.getElementById('bot-status');
const botPingBtn = document.getElementById('bot-ping-btn');

botPingBtn.addEventListener('click', async () => {
  botPingBtn.disabled = true;
  botPingBtn.textContent = 'Pinging...';
  setBotStatus('connecting');
  try {
    const cmdId = await sendBotCommand('ping', {});
    const statusEl = document.getElementById('fetch-channels-status');
    statusEl.textContent = 'Waiting for bot response...';
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      const cmdSnap = await getDocFromServer(doc(db, 'bot_commands', cmdId));
      const cmdData = cmdSnap.data();
      if (cmdData?.status === 'done') {
        clearInterval(interval);
        setBotStatus('online');
        const r = cmdData.result || {};
        statusEl.textContent = `✅ Pong! ${r.tag || 'Bot'} · ${r.guilds ?? '?'} server(s) · up ${r.uptime || '?'}`;
        await writeLog('connection', `Bot ping successful. ${r.tag || ''} online.`, {});
      } else if (cmdData?.status === 'error' || attempts > 15) {
        clearInterval(interval);
        setBotStatus('offline');
        statusEl.textContent = attempts > 15 ? '⚠️ No response from bot.' : `❌ ${cmdData?.error || 'Error'}`;
      }
    }, 1000);
  } catch (e) {
    setBotStatus('offline');
    await writeLog('error', `Ping failed: ${e.message}`, {});
  } finally {
    setTimeout(() => { botPingBtn.disabled = false; botPingBtn.textContent = '🏓 Test / Ping'; }, 2000);
  }
});

function setBotStatus(status) {
  botStatusPill.className = 'status-pill';
  if (status === 'online') {
    botStatusPill.classList.add('status-online'); botStatusPill.textContent = '🟢 Online';
    setDiscordBadge('online', 'Online');
  } else if (status === 'offline') {
    botStatusPill.classList.add('status-offline'); botStatusPill.textContent = '🔴 Offline';
    setDiscordBadge('offline', 'Offline');
  } else if (status === 'connecting') {
    botStatusPill.classList.add('status-connecting'); botStatusPill.textContent = '🟡 Connecting';
    setDiscordBadge('unknown', 'Connecting…');
  } else {
    botStatusPill.classList.add('status-unknown'); botStatusPill.textContent = '⚪ Unknown';
    setDiscordBadge('unknown', 'Unknown');
  }
}

// Watch bot_status/heartbeat — no polling, just onSnapshot + local age timer
let lastHeartbeatTs = null;

function evaluateHeartbeatAge() {
  if (!lastHeartbeatTs) { setBotStatus('offline'); return; }
  const ageSecs = (Date.now() - lastHeartbeatTs) / 1000;
  // Thresholds account for 60s heartbeat interval: online < 150s, connecting < 360s
  if (ageSecs < 150) setBotStatus('online');
  else if (ageSecs < 360) setBotStatus('connecting');
  else setBotStatus('offline');
}

onSnapshot(doc(db, 'bot_status', 'heartbeat'), (snap) => {
  if (!snap.exists()) { setBotStatus('offline'); return; }
  const ts = snap.data().lastSeen?.toDate();
  if (ts) lastHeartbeatTs = ts.getTime();
  evaluateHeartbeatAge();
}, (_err) => {
  // Listener error (quota, network) — mark offline so UI doesn't show stale green
  setBotStatus('offline');
});

// Re-evaluate age every 30s locally — no Firestore reads needed
setInterval(evaluateHeartbeatAge, 30000);

// ==================== OPENROUTER ====================
const orKeyInput = document.getElementById('or-key');
const orModelSel = document.getElementById('or-model');
const orSaveBtn = document.getElementById('or-save-btn');
const orModelSaveBtn = document.getElementById('or-model-save-btn');
const orTestBtn = document.getElementById('or-test-btn');
const orStatusPill = document.getElementById('or-status');

orSaveBtn.addEventListener('click', async () => {
  const key = orKeyInput.value.trim();
  if (!key) { alert('Please enter an API key.'); return; }
  orSaveBtn.disabled = true;
  orSaveBtn.textContent = 'Saved ✓';
  try {
    await saveSettings({ openrouterKey: key });
    await writeLog('connection', 'OpenRouter API key updated.', {});
    setOrStatus('connected');
  } catch (e) {
    setOrStatus('error');
    alert('Error saving: ' + e.message);
  } finally {
    setTimeout(() => { orSaveBtn.disabled = false; orSaveBtn.textContent = 'Save'; }, 2000);
  }
});

orModelSaveBtn.addEventListener('click', async () => {
  const model = orModelSel.value;
  orModelSaveBtn.disabled = true;
  orModelSaveBtn.textContent = 'Saved ✓';
  try {
    await saveSettings({ openrouterModel: model });
    await writeLog('success', `OpenRouter model set to ${model}.`, {});
  } catch (e) {
    alert('Error saving model: ' + e.message);
  } finally {
    setTimeout(() => { orModelSaveBtn.disabled = false; orModelSaveBtn.textContent = 'Save'; }, 2000);
  }
});

orTestBtn.addEventListener('click', async () => {
  const key = orKeyInput.value.trim() || currentSettings.openrouterKey;
  if (!key) { alert('No API key configured.'); return; }
  orTestBtn.disabled = true;
  orTestBtn.textContent = 'Testing...';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    if (res.ok) {
      setOrStatus('connected');
      await writeLog('connection', 'OpenRouter connection test successful.', {});
      alert('OpenRouter connection successful!');
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    setOrStatus('error');
    await writeLog('error', `OpenRouter connection test failed: ${e.message}`, {});
    alert('Connection failed: ' + e.message);
  } finally {
    orTestBtn.disabled = false;
    orTestBtn.textContent = 'Test Connection';
  }
});

function setOrStatus(status) {
  orStatusPill.className = 'status-pill';
  if (status === 'connected') {
    orStatusPill.classList.add('status-connected'); orStatusPill.textContent = '🟢 Connected';
    setOrBadge('connected', 'Connected');
  } else if (status === 'error') {
    orStatusPill.classList.add('status-error'); orStatusPill.textContent = '🔴 Error';
    setOrBadge('offline', 'Error');
  } else {
    orStatusPill.classList.add('status-unknown'); orStatusPill.textContent = '⚪ Unknown';
    setOrBadge('unknown', 'Unknown');
  }
}

// ==================== TEST CHANNEL ====================
const testChannelSel = document.getElementById('test-channel-sel');

document.getElementById('save-test-channel-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-test-channel-btn');
  const opt = testChannelSel.options[testChannelSel.selectedIndex];
  if (!testChannelSel.value) { alert('Select a channel first.'); return; }
  btn.disabled = true;
  btn.textContent = 'Saved ✓';
  await saveSettings({
    testChannelId: testChannelSel.value,
    testChannelName: opt ? opt.textContent.replace('#', '') : ''
  });
  await writeLog('success', `Test channel set to #${opt?.textContent.replace('#','') || testChannelSel.value}.`, {});
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Save'; }, 2000);
});

function updateTestChannelDropdown(channels, selectedId) {
  testChannelSel.innerHTML = '<option value="">-- Select Test Channel --</option>';
  channels.forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `#${ch.name}`;
    if (ch.id === selectedId) opt.selected = true;
    testChannelSel.appendChild(opt);
  });
}

// ==================== CHANNELS ====================
const channelList = document.getElementById('channel-list');
const addChannelBtn = document.getElementById('add-channel-btn');

let channels = [];

function renderChannelList(chs) {
  channels = [...chs];
  channelList.innerHTML = '';
  channels.forEach((ch, idx) => {
    channelList.appendChild(buildChannelRow(ch, idx));
  });
  updateTestChannelDropdown(channels, currentSettings.testChannelId);
}

function buildChannelRow(ch, idx) {
  const row = document.createElement('div');
  row.className = 'channel-item';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Channel name';
  nameInput.value = ch.name || '';
  nameInput.addEventListener('change', () => {
    channels[idx].name = nameInput.value.trim();
    saveChannels();
  });

  const sep = document.createElement('span');
  sep.className = 'channel-sep';
  sep.textContent = '→';

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.placeholder = 'Channel ID';
  idInput.value = ch.id || '';
  idInput.style.fontFamily = 'monospace';
  idInput.addEventListener('change', () => {
    channels[idx].id = idInput.value.trim();
    saveChannels();
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-icon btn-sm';
  delBtn.innerHTML = '🗑';
  delBtn.title = 'Remove channel';
  delBtn.addEventListener('click', async () => {
    channels.splice(idx, 1);
    await saveChannels();
    renderChannelList(channels);
  });

  row.appendChild(nameInput);
  row.appendChild(sep);
  row.appendChild(idInput);
  row.appendChild(delBtn);
  return row;
}

async function saveChannels() {
  const valid = channels.filter(c => c.name && c.id);
  await saveSettings({ channels: valid });
  updateTestChannelDropdown(valid, currentSettings.testChannelId);
  setChannelsBadge(valid.length);
  await writeLog('success', `Channels updated (${valid.length} total)`, {});
}

// ==================== FETCH CHANNELS FROM DISCORD ====================
document.getElementById('fetch-channels-btn').addEventListener('click', async () => {
  const btn = document.getElementById('fetch-channels-btn');
  const statusEl = document.getElementById('fetch-channels-status');
  const serverId = HARDCODED_SERVER_ID;
  btn.disabled = true;
  btn.textContent = 'Fetching...';
  statusEl.style.color = 'var(--text-dim)';
  statusEl.textContent = 'Sending request to bot...';

  const cmdId = await sendBotCommand('fetch_channels', { serverId });
  const { timedOut, data } = await pollCommand(cmdId, 15000);

  if (timedOut) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = '⚠️ No response — is the bot online?';
    await writeLog('warning', 'fetch_channels command timed out.', {});
  } else if (data?.error) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = `❌ ${data.error}`;
    await writeLog('error', `fetch_channels failed: ${data.error}`, {});
  } else {
    const fetched = data?.result?.channels || [];
    if (fetched.length === 0) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = '⚠️ No text channels found in that server.';
    } else {
      const existing = channels.map(c => c.id);
      const newOnes = fetched.filter(c => !existing.includes(c.id));
      const merged = [...channels, ...newOnes];
      await saveSettings({ channels: merged });
      renderChannelList(merged);
      statusEl.style.color = '#4ade80';
      statusEl.textContent = `✅ Found ${fetched.length} channels — ${newOnes.length} new added.`;
      await writeLog('success', `Fetched ${fetched.length} channels from server ${serverId}.`, {});
    }
  }

  btn.disabled = false;
  btn.textContent = '🔄 Refresh Channels';
});

addChannelBtn.addEventListener('click', () => {
  channels.push({ name: '', id: '' });
  renderChannelList(channels);
  const inputs = channelList.querySelectorAll('.channel-item input');
  if (inputs.length > 0) inputs[inputs.length - 2].focus();
});

// ==================== JOIN THE TABLE SETTINGS ====================
function updateJoinTableBadge() {
  const badge = document.getElementById('join-table-badge');
  const badgeText = document.getElementById('join-table-badge-text');
  const configured = currentSettings.joinTableChannelId && currentSettings.activeCategoryId;
  badge.className = `panel-status-badge ${configured ? 'badge-connected' : 'badge-unknown'}`;
  badgeText.textContent = configured ? 'Configured' : 'Not configured';
}

function populateChannelDropdown(sel, channels, selectedId) {
  const prev = sel.value || selectedId;
  sel.innerHTML = '<option value="">-- Select Channel --</option>';
  (channels || []).forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `#${ch.name}`;
    if (ch.id === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

function populateCategoryDropdown(sel, categories, selectedId) {
  const prev = sel.value || selectedId;
  sel.innerHTML = '<option value="">-- Select Category --</option>';
  (categories || []).forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    if (cat.id === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

function applyJoinTableSettings(s) {
  populateChannelDropdown(
    document.getElementById('join-table-channel-sel'),
    s.channels || [],
    s.joinTableChannelId
  );
  const cats = s.categories || [];
  populateCategoryDropdown(document.getElementById('inactive-category-sel'), cats, s.inactiveCategoryId);
  populateCategoryDropdown(document.getElementById('active-category-sel'), cats, s.activeCategoryId);
  updateJoinTableBadge();
}

document.getElementById('save-join-table-channel-btn').addEventListener('click', async () => {
  const sel = document.getElementById('join-table-channel-sel');
  const channelId = sel.value;
  const opt = sel.options[sel.selectedIndex];
  const channelName = opt ? opt.textContent.replace('#', '') : '';
  if (!channelId) { alert('Please select a channel.'); return; }
  await saveSettings({ joinTableChannelId: channelId, joinTableChannelName: channelName });
  updateJoinTableBadge();
  const btn = document.getElementById('save-join-table-channel-btn');
  btn.textContent = 'Saved ✓'; btn.disabled = true;
  setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
});

document.getElementById('save-inactive-cat-btn').addEventListener('click', async () => {
  const sel = document.getElementById('inactive-category-sel');
  const catId = sel.value;
  const opt = sel.options[sel.selectedIndex];
  const catName = opt ? opt.textContent : '';
  if (!catId) { alert('Please select a category.'); return; }
  await saveSettings({ inactiveCategoryId: catId, inactiveCategoryName: catName });
  updateJoinTableBadge();
  const btn = document.getElementById('save-inactive-cat-btn');
  btn.textContent = 'Saved ✓'; btn.disabled = true;
  setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
});

document.getElementById('save-active-cat-btn').addEventListener('click', async () => {
  const sel = document.getElementById('active-category-sel');
  const catId = sel.value;
  const opt = sel.options[sel.selectedIndex];
  const catName = opt ? opt.textContent : '';
  if (!catId) { alert('Please select a category.'); return; }
  await saveSettings({ activeCategoryId: catId, activeCategoryName: catName });
  updateJoinTableBadge();
  const btn = document.getElementById('save-active-cat-btn');
  btn.textContent = 'Saved ✓'; btn.disabled = true;
  setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
});

document.getElementById('fetch-categories-btn').addEventListener('click', async () => {
  const btn = document.getElementById('fetch-categories-btn');
  const statusEl = document.getElementById('fetch-categories-status');
  const serverId = HARDCODED_SERVER_ID;
  btn.disabled = true;
  btn.textContent = 'Fetching...';
  statusEl.style.color = 'var(--text-dim)';
  statusEl.textContent = 'Sending request to bot...';

  const cmdId = await sendBotCommand('fetch_categories', { serverId });
  const { timedOut, data } = await pollCommand(cmdId, 15000);

  if (timedOut) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = '⚠️ No response — is the bot online?';
    await writeLog('warning', 'fetch_categories command timed out.', {});
  } else if (data?.error) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = `❌ ${data.error}`;
  } else {
    const fetched = data?.result?.categories || [];
    if (fetched.length === 0) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = '⚠️ No categories found in that server.';
    } else {
      await saveSettings({ categories: fetched });
      populateCategoryDropdown(document.getElementById('inactive-category-sel'), fetched, currentSettings.inactiveCategoryId);
      populateCategoryDropdown(document.getElementById('active-category-sel'), fetched, currentSettings.activeCategoryId);
      statusEl.style.color = '#4ade80';
      statusEl.textContent = `✅ Found ${fetched.length} categories.`;
      await writeLog('success', `Fetched ${fetched.length} categories from server ${serverId}.`, {});
    }
  }

  btn.disabled = false;
  btn.textContent = '📂 Fetch Categories from Server';
});

// ==================== ACTIVITY LOG ====================
const logContainer = document.getElementById('log-container');
const clearLogBtn = document.getElementById('clear-log-btn');

const LOG_LABELS = {
  success:    { badge: '✅ SUCCESS',     emoji: '✅' },
  sent:       { badge: '📤 SENT',        emoji: '📤' },
  scheduled:  { badge: '📅 SCHEDULED',   emoji: '📅' },
  warning:    { badge: '⚠️ WARNING',     emoji: '⚠️' },
  error:      { badge: '❌ ERROR',        emoji: '❌' },
  connection: { badge: '🔌 CONNECTION',  emoji: '🔌' },
  reply:      { badge: '🎭 REPLY',       emoji: '🎭' },
  ping:       { badge: '🏓 PING',        emoji: '🏓' },
  restart:    { badge: '🔄 RESTART',     emoji: '🔄' },
  command:    { badge: '🎮 COMMAND',     emoji: '🎮' },
};

function prependLogEntry(data) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${data.type || 'connection'}`;

  const ts = document.createElement('span');
  ts.className = 'log-ts';
  const date = data.timestamp?.toDate ? data.timestamp.toDate() : new Date();
  ts.textContent = ctTimeStr(date);

  const badge = document.createElement('span');
  badge.className = 'log-badge';
  const meta = LOG_LABELS[data.type];
  badge.textContent = meta ? meta.badge : (data.type?.toUpperCase() || 'LOG');

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  const emoji = meta?.emoji || '';
  msg.textContent = (emoji && !data.message?.startsWith(emoji)) ? `${emoji} ${data.message || ''}` : (data.message || '');

  entry.appendChild(ts);
  entry.appendChild(badge);
  entry.appendChild(msg);

  // Prepend — newest at top
  logContainer.insertBefore(entry, logContainer.firstChild);

  // Keep max 1000 entries
  while (logContainer.children.length > 1000) {
    logContainer.removeChild(logContainer.lastChild);
  }
}

// Real-time log subscription — newest first, capped at 50 to conserve Firestore reads
const logQuery = query(
  collection(db, 'logs'),
  orderBy('timestamp', 'desc'),
  limit(50)
);

let initialLoad = true;
let renderedFromCache = false;

onSnapshot(logQuery, (snap) => {
  const fromCache = snap.metadata.fromCache;
  // If this is a cached snapshot and we haven't yet received server data,
  // show a subtle indicator so the user knows logs may be stale.
  if (fromCache && initialLoad) {
    logContainer.dataset.cacheWarning = '1';
  } else {
    delete logContainer.dataset.cacheWarning;
  }

  if (initialLoad || (renderedFromCache && !fromCache)) {
    // Re-render the full list when we get server data (replaces any stale cached render)
    logContainer.innerHTML = '';
    snap.forEach(d => {
      const entry = document.createElement('div');
      const data = { id: d.id, ...d.data() };
      entry.className = `log-entry log-${data.type || 'connection'}`;

      const ts = document.createElement('span');
      ts.className = 'log-ts';
      const date = data.timestamp?.toDate ? data.timestamp.toDate() : new Date();
      ts.textContent = ctTimeStr(date);

      const badge = document.createElement('span');
      badge.className = 'log-badge';
      const meta = LOG_LABELS[data.type];
      badge.textContent = meta ? meta.badge : (data.type?.toUpperCase() || 'LOG');

      const msg = document.createElement('span');
      msg.className = 'log-msg';
      const emoji = meta?.emoji || '';
      msg.textContent = (emoji && !data.message?.startsWith(emoji)) ? `${emoji} ${data.message || ''}` : (data.message || '');

      entry.appendChild(ts);
      entry.appendChild(badge);
      entry.appendChild(msg);
      logContainer.appendChild(entry);
    });
    renderedFromCache = fromCache;
    initialLoad = false;
  } else {
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        prependLogEntry({ id: change.doc.id, ...change.doc.data() });
      }
    });
  }
}, (_err) => {
  // Log listener error — leave existing entries visible, just stop updating
  console.warn('Log listener error:', _err?.message);
});

clearLogBtn.addEventListener('click', async () => {
  if (!confirm('Clear all log entries? This cannot be undone.')) return;
  clearLogBtn.disabled = true;
  clearLogBtn.textContent = 'Clearing...';
  try {
    const snap = await getDocs(collection(db, 'logs'));
    const batches = [];
    snap.forEach(d => batches.push(deleteDoc(doc(db, 'logs', d.id))));
    await Promise.all(batches);
    logContainer.innerHTML = '';
  } catch (e) {
    alert('Error clearing log: ' + e.message);
  } finally {
    clearLogBtn.disabled = false;
    clearLogBtn.textContent = 'Clear Log';
  }
});

// ==================== BOT CONTROLS ====================
const ctrlFeedback = document.getElementById('ctrl-feedback');
const heartbeatDisplay = document.getElementById('heartbeat-display');

function setCtrlFeedback(msg, color = 'var(--gold)') {
  ctrlFeedback.style.color = color;
  ctrlFeedback.textContent = msg;
}
function clearCtrlFeedback(delay = 8000) {
  setTimeout(() => { if (ctrlFeedback) ctrlFeedback.textContent = ''; }, delay);
}

async function sendBotCommand(type, payload = {}) {
  const ref = await addDoc(collection(db, 'bot_commands'), {
    type, payload, status: 'pending', createdAt: serverTimestamp()
  });
  return ref.id;
}

// Wait for a command doc to reach a terminal status using onSnapshot (zero polling reads).
// The listener fires when the bot writes status = done/completed/failed/stale.
function pollCommand(cmdId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsub();
      resolve({ timedOut: true, data: null });
    }, timeoutMs);

    const unsub = onSnapshot(
      doc(db, 'bot_commands', cmdId),
      (snap) => {
        if (resolved) return;
        const status = snap.data()?.status;
        if (status === 'completed' || status === 'failed' || status === 'done') {
          resolved = true;
          clearTimeout(timer);
          unsub();
          resolve({ timedOut: false, data: snap.data() });
        } else if (status === 'stale') {
          resolved = true;
          clearTimeout(timer);
          unsub();
          resolve({ timedOut: true, data: snap.data(), stale: true });
        }
      },
      (_err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ timedOut: true, data: null });
      }
    );
  });
}

// Wait for bot to come back online after a restart using onSnapshot (zero polling reads).
// Only resolves when heartbeat.lastSeen is written AFTER restartSentAt to avoid
// false positives from the pre-restart heartbeat.
function pollForOnline(restartSentAt, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let resolved = false;
    let countdown = Math.floor(timeoutMs / 1000);

    const countdownIv = setInterval(() => {
      if (resolved) { clearInterval(countdownIv); return; }
      countdown--;
      setCtrlFeedback(`🔄 Waiting for bot to come back online... (${countdown}s)`);
    }, 1000);

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      clearInterval(countdownIv);
      unsub();
      resolve({ online: false });
    }, timeoutMs);

    const unsub = onSnapshot(
      doc(db, 'bot_status', 'heartbeat'),
      (snap) => {
        if (resolved) return;
        if (snap.exists()) {
          const ts = snap.data().lastSeen?.toDate();
          if (ts && ts.getTime() > restartSentAt) {
            resolved = true;
            clearTimeout(timer);
            clearInterval(countdownIv);
            unsub();
            resolve({ online: true, tag: snap.data().tag });
          }
        }
      },
      (_err) => { /* network error — keep waiting until timeout */ }
    );
  });
}

// Heartbeat display — ticks locally every second, no Firestore reads
function tickHeartbeatDisplay() {
  if (!heartbeatDisplay) return;
  if (!lastHeartbeatTs) {
    heartbeatDisplay.textContent = 'Last seen: never';
    heartbeatDisplay.style.color = '#f87171';
    return;
  }
  const secs = Math.floor((Date.now() - lastHeartbeatTs) / 1000);
  const label = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs/60)}m ago` : `${Math.floor(secs/3600)}h ago`;
  heartbeatDisplay.textContent = `Last seen: ${label}`;
  heartbeatDisplay.style.color = secs < 90 ? '#4ade80' : secs < 300 ? '#fbbf24' : '#f87171';
}
// The onSnapshot above already updates lastHeartbeatTs; just tick the display locally
setInterval(tickHeartbeatDisplay, 1000);

// ── Ping ──────────────────────────────────────────────────────
document.getElementById('ctrl-ping-btn').addEventListener('click', async () => {
  const btn = document.getElementById('ctrl-ping-btn');
  btn.disabled = true;
  setCtrlFeedback('🏓 Pinging bot...');
  const sentAt = Date.now();
  const cmdId = await sendBotCommand('ping', { sentAt });
  const { timedOut, data } = await pollCommand(cmdId, 12000);
  if (timedOut) {
    setCtrlFeedback('⚠️ No response — is the bot running?', '#f87171');
    await writeLog('warning', 'Ping timed out — bot did not respond within 12s.', {});
  } else {
    const rtt = Date.now() - sentAt;
    setCtrlFeedback(`🏓 Pong! ${rtt}ms`, '#4ade80');
    await writeLog('success', `Ping successful — response time ${rtt}ms.`, { rtt });
  }
  clearCtrlFeedback();
  btn.disabled = false;
});

// ── Test Send ─────────────────────────────────────────────────
document.getElementById('ctrl-test-btn').addEventListener('click', async () => {
  const btn = document.getElementById('ctrl-test-btn');
  const testCh = currentSettings.testChannelId;
  const testChName = currentSettings.testChannelName || testCh;
  if (!testCh) {
    setCtrlFeedback('⚠️ No test channel configured in settings', '#f87171');
    clearCtrlFeedback();
    return;
  }
  btn.disabled = true;
  setCtrlFeedback('📤 Dispatching test message...');
  await sendBotCommand('test_send', { channelId: testCh, message: '🃏 Pitboss is online and ready to deal. ♠️' });
  await writeLog('sent', `Test message dispatched to #${testChName} via bot controls.`, { channelId: testCh });
  setCtrlFeedback(`📤 Sent to #${testChName}`, '#4ade80');
  clearCtrlFeedback();
  btn.disabled = false;
});

// ── Restart ───────────────────────────────────────────────────
async function doRestart(source = 'manual') {
  const restartSentAt = Date.now();
  await sendBotCommand('restart');
  await writeLog('warning', `Bot restart triggered (${source}). Waiting for reconnect...`, {});
  setCtrlFeedback('🔄 Restart sent — waiting for bot to come back online...');
  const result = await pollForOnline(restartSentAt, 60000);
  if (result.online) {
    setCtrlFeedback(`✅ Bot is back online as ${result.tag || 'Pitboss'}`, '#4ade80');
    await writeLog('connection', `Bot reconnected after restart as ${result.tag}.`, {});
  } else {
    setCtrlFeedback('⚠️ Bot did not come back within 60s — check your VPS / PM2', '#f87171');
    await writeLog('error', 'Bot did not reconnect within 60s after restart.', {});
  }
  clearCtrlFeedback(10000);
}

document.getElementById('ctrl-restart-btn').addEventListener('click', async () => {
  if (!confirm('Send restart command to the bot? PM2 will automatically restart it.')) return;
  const btn = document.getElementById('ctrl-restart-btn');
  btn.disabled = true;
  await doRestart('dashboard button');
  btn.disabled = false;
});

// ── Force Status ──────────────────────────────────────────────
document.getElementById('ctrl-status-btn').addEventListener('click', async () => {
  const btn = document.getElementById('ctrl-status-btn');
  btn.disabled = true;
  setCtrlFeedback('📡 Requesting status...');
  const cmdId = await sendBotCommand('status_check');
  const { timedOut, data } = await pollCommand(cmdId, 12000);
  if (timedOut) {
    setCtrlFeedback('⚠️ No response — bot may be offline', '#f87171');
    await writeLog('warning', 'Status check timed out — bot did not respond.', {});
  } else {
    const r = data?.result || {};
    const msg = `${r.tag || 'Bot'} · ${r.guilds ?? '?'} server(s) · up ${r.uptime || '?'}`;
    setCtrlFeedback(`📡 ${msg}`, '#4ade80');
    await writeLog('success', `Status check: ${msg}`, r);
  }
  clearCtrlFeedback();
  btn.disabled = false;
});

// ── Auto-ping ─────────────────────────────────────────────────
let autoPingInterval = null;
const autoPingSel = document.getElementById('autoping-sel');
const autoPingBadge = document.getElementById('autoping-badge');

autoPingSel.addEventListener('change', () => {
  if (autoPingInterval) { clearInterval(autoPingInterval); autoPingInterval = null; }
  const mins = parseInt(autoPingSel.value, 10);
  if (mins === 0) {
    autoPingBadge.style.display = 'none';
    return;
  }
  autoPingBadge.style.display = 'inline';
  autoPingBadge.textContent = `● Auto-pinging every ${mins}m`;

  async function autoPing() {
    const sentAt = Date.now();
    const cmdId = await sendBotCommand('ping', { sentAt, source: 'auto-ping' });
    const { timedOut } = await pollCommand(cmdId, 15000);
    if (timedOut) {
      await writeLog('warning', `Auto-ping (${mins}m interval): no response from bot.`, {});
    } else {
      const rtt = Date.now() - sentAt;
      await writeLog('success', `Auto-ping (${mins}m interval): bot responded in ${rtt}ms.`, { rtt });
    }
  }

  autoPing(); // immediate first ping
  autoPingInterval = setInterval(autoPing, mins * 60 * 1000);
});

// ==================== PITBOSS PERSONALITY ====================
const DEFAULT_PERSONALITY = `You're Pitboss — off-the-books poker den enforcer. Talk like a mob boss: cold, clipped, no fluff. You're a poker expert — answer any hand, odds, or scenario correctly. Roast without mercy, swear freely, get vulgar when earned. Hard rule: every reply is 300 chars MAX. Never break character.`;

const personalityTextarea = document.getElementById('personality-prompt');
const personalitySaveBtn = document.getElementById('personality-save-btn');
const personalityResetBtn = document.getElementById('personality-reset-btn');

function loadPersonality(s) {
  personalityTextarea.value = s.pitbossPersonality || DEFAULT_PERSONALITY;
  const isCustom = s.pitbossPersonality && s.pitbossPersonality !== DEFAULT_PERSONALITY;
  const badge = document.getElementById('personality-badge');
  const badgeText = document.getElementById('personality-badge-text');
  if (badge && badgeText) {
    badge.className = `panel-status-badge ${isCustom ? 'badge-connected' : 'badge-unknown'}`;
    badgeText.textContent = isCustom ? 'Custom' : 'Default';
  }
}

personalitySaveBtn.addEventListener('click', async () => {
  const prompt = personalityTextarea.value.trim();
  if (!prompt) { alert('Personality prompt cannot be empty.'); return; }
  personalitySaveBtn.disabled = true;
  personalitySaveBtn.textContent = 'Saved ✓';
  await saveSettings({ pitbossPersonality: prompt });
  await writeLog('success', 'Pitboss personality prompt updated.', {});
  const isCustom = prompt !== DEFAULT_PERSONALITY;
  const badge = document.getElementById('personality-badge');
  const badgeText = document.getElementById('personality-badge-text');
  if (badge) badge.className = `panel-status-badge ${isCustom ? 'badge-connected' : 'badge-unknown'}`;
  if (badgeText) badgeText.textContent = isCustom ? 'Custom' : 'Default';
  setTimeout(() => { personalitySaveBtn.disabled = false; personalitySaveBtn.textContent = 'Save Personality'; }, 2000);
});

personalityResetBtn.addEventListener('click', async () => {
  if (!confirm('Reset personality to default?')) return;
  personalityTextarea.value = DEFAULT_PERSONALITY;
  await saveSettings({ pitbossPersonality: DEFAULT_PERSONALITY });
  const badge = document.getElementById('personality-badge');
  const badgeText = document.getElementById('personality-badge-text');
  if (badge) badge.className = 'panel-status-badge badge-unknown';
  if (badgeText) badgeText.textContent = 'Default';
  await writeLog('success', 'Pitboss personality reset to default.', {});
});

// ==================== COLLAPSIBLE PANELS ====================
function initCollapsible() {
  document.querySelectorAll('.panel-header.collapsible').forEach(header => {
    const panelId = header.dataset.panel;
    const panel = document.getElementById(panelId);
    if (!panel) return;
    // Default: collapsed. Restore if user explicitly opened it.
    const savedOpen = localStorage.getItem(`panel-open-${panelId}`) === 'true';
    if (!savedOpen) panel.classList.add('collapsed');
    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      localStorage.setItem(`panel-open-${panelId}`, !panel.classList.contains('collapsed'));
    });
  });
}

function setDiscordBadge(status, label) {
  const badge = document.getElementById('discord-badge');
  const text = document.getElementById('discord-badge-text');
  if (!badge || !text) return;
  badge.className = `panel-status-badge badge-${status}`;
  text.textContent = label;
}

function setOrBadge(status, label) {
  const badge = document.getElementById('or-badge');
  const text = document.getElementById('or-badge-text');
  if (!badge || !text) return;
  badge.className = `panel-status-badge badge-${status}`;
  text.textContent = label;
}

function setChannelsBadge(count) {
  const badge = document.getElementById('channels-badge');
  const text = document.getElementById('channels-badge-text');
  if (!badge || !text) return;
  badge.className = `panel-status-badge ${count > 0 ? 'badge-connected' : 'badge-unknown'}`;
  text.textContent = `${count} channel${count !== 1 ? 's' : ''}`;
}

initCollapsible();

// ==================== INIT ====================
await loadSettings();
