// Régie (iPad) : pilote l'écran de l'iPhone, montre ce qu'il affiche, édite le texte.

import {
  DEFAULT_SETTINGS, LAYOUT_KEYS, SAMPLE_SCRIPT, sanitizeSettings, parseScript, blockIndexAt,
  renderBlocks, applyStageStyle, measure, anchorOf, posOf, hash, settingsHash, clamp, randomId, randomCode,
} from './shared.js';
import { createLink, detectMode } from './link.js';

const $ = (id) => document.getElementById(id);
const LIB = 'ipp.remote.library';
const SET = 'ipp.remote.settings';
const CODE = 'ipp.remote.code';
const PAIRED = 'ipp.remote.paired';

const read = (k, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; }
};
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---- État ----

let lib = read(LIB, null);
if (!lib || !Array.isArray(lib.scripts) || !lib.scripts.length) {
  lib = { scripts: [{ id: 'exemple', text: SAMPLE_SCRIPT, updated: Date.now() }], currentId: 'exemple', pristine: true };
}
if (!lib.scripts.some((s) => s.id === lib.currentId)) lib.currentId = lib.scripts[0].id;

let settings = sanitizeSettings(read(SET, DEFAULT_SETTINGS));
let code = read(CODE, null);
if (!/^\d{6}$/.test(code || '')) { code = randomCode(); write(CODE, code); }

const current = () => lib.scripts.find((s) => s.id === lib.currentId);
const saveLib = () => write(LIB, lib);

let link = null;
let mode = 'local';
let modeInfo = null;
let connState = 'connecting';
let status = null;       // dernier état reçu de l'iPhone
let statusAt = 0;
let lastScriptPush = 0;
let lastSettingsPush = 0;
let pullPending = 0;

// ---- Envoi vers l'iPhone ----

const send = (msg) => link?.send(msg);
const cmd = (c, extra = {}) => send({ t: 'cmd', c, ...extra });

function pushScript() {
  const s = current();
  lastScriptPush = performance.now();
  send({ t: 'script', id: s.id, text: s.text });
}
function pushSettings() {
  lastSettingsPush = performance.now();
  send({ t: 'settings', s: settings });
}

let scriptTimer = null;
function schedulePushScript() {
  clearTimeout(scriptTimer);
  $('sync').textContent = 'Envoi…';
  scriptTimer = setTimeout(() => { scriptTimer = null; pushScript(); }, 300);
}
function flushScript() {
  if (scriptTimer) { clearTimeout(scriptTimer); scriptTimer = null; pushScript(); }
}

let settingsQueued = false;
function schedulePushSettings() {
  if (settingsQueued) return;
  settingsQueued = true;
  setTimeout(() => { settingsQueued = false; pushSettings(); }, 60);
}

// ---- Réception ----

function onMessage(m) {
  if (m.t === 'status') {
    status = m;
    statusAt = performance.now();
    if (m.vw !== preview.vw || m.vh !== preview.vh) {
      preview.vw = m.vw; preview.vh = m.vh;
      renderPreview();
    }
    updatePlayButton();
    updatePlanCurrent();
    updateSync();
    updateVoiceBar();
    repairIfNeeded();
  } else if (m.t === 'current') {
    adoptFromDisplay(m);
  }
}

// Une régie neuve (rien d'écrit) reprend le texte déjà affiché par l'iPhone au lieu de l'écraser.
function adoptFromDisplay(m) {
  if (!pullPending) return;
  pullPending = 0;
  if (!lib.pristine) return;
  lib.pristine = false;
  if (typeof m.text === 'string' && typeof m.id === 'string' && !(m.id === 'exemple' && m.text === SAMPLE_SCRIPT)) {
    const existing = lib.scripts.find((s) => s.id === m.id);
    if (existing) existing.text = m.text;
    else lib.scripts.unshift({ id: m.id, text: m.text, updated: Date.now() });
    lib.currentId = m.id;
  }
  if (m.s) { settings = sanitizeSettings(m.s); write(SET, settings); }
  saveLib();
  loadCurrentIntoUI();
  pushSettings();
}

function onPeerJoined() {
  write(PAIRED, true);
  if (lib.pristine) {
    pullPending = performance.now();
    send({ t: 'pull' });
  } else {
    pushSettings();
    pushScript();
  }
  send({ t: 'hello' });
}

// Si l'iPhone n'affiche pas le même texte ou les mêmes réglages, on renvoie (après un délai de grâce).
function repairIfNeeded() {
  const now = performance.now();
  if (pullPending && now - pullPending < 3000) return;
  if (pullPending) { pullPending = 0; lib.pristine = false; saveLib(); }
  const s = current();
  if (!scriptTimer && (status.scriptId !== s.id || status.scriptHash !== hash(s.text)) && now - lastScriptPush > 2500) pushScript();
  if (status.settingsHash !== settingsHash(settings) && now - lastSettingsPush > 2500) pushSettings();
}

function onState(s) {
  connState = s;
  const pill = $('conn');
  pill.dataset.state = s;
  $('conn-label').textContent =
    s === 'connected' ? 'iPhone connecté'
    : s === 'waiting' ? 'iPhone non connecté'
    : s === 'replaced' ? 'Régie ouverte ailleurs · toucher pour reprendre'
    : mode === 'online' ? 'Connexion à internet…' : 'Connexion au Mac…';
  $('preview-box').classList.toggle('offline', s !== 'connected');
  $('preview-badge').textContent = s === 'connected' ? 'Aperçu de l\'iPhone' : 'iPhone non connecté · aperçu du texte';
  if (s !== 'connected') { status = null; updatePlayButton(); }
  updateVoiceBar();
  if (s === 'connected' && $('pair').open) $('pair').close();
  updateSync();
}

function updateSync() {
  const el = $('sync');
  if (scriptTimer) return;
  if (connState !== 'connected') { el.textContent = 'Non envoyé (iPhone absent)'; return; }
  const s = current();
  el.textContent = status && status.scriptHash === hash(s.text) && status.scriptId === s.id ? '✓ Sur l\'iPhone' : 'Envoi…';
}

// ---- Aperçu ----

const preview = {
  box: $('preview-box'), frame: $('preview-frame'), stage: $('preview'), content: $('preview-content'),
  vw: 844, vh: 390, scale: 1, rendered: null, layout: null, blocks: [],
  drag: null, holdUntil: 0, pos: 0,
};

function renderPreview() {
  const p = preview;
  p.blocks = parseScript(current().text);
  applyStageStyle(p.stage, settings);
  p.stage.style.width = p.vw + 'px';
  p.stage.style.height = p.vh + 'px';
  p.rendered = renderBlocks(document, p.content, p.blocks);
  p.layout = measure(p.stage, p.rendered, settings);
  fitPreview();
  renderPlan();
}

function fitPreview() {
  const p = preview;
  const bw = p.box.clientWidth;
  const bh = p.box.clientHeight;
  if (!bw || !bh) return;
  p.scale = Math.min(bw / p.vw, bh / p.vh);
  p.frame.style.transform = `scale(${p.scale})`;
  p.frame.style.left = (bw - p.vw * p.scale) / 2 + 'px';
  p.frame.style.top = (bh - p.vh * p.scale) / 2 + 'px';
}

function previewPos(now) {
  const p = preview;
  if (p.drag || now < p.holdUntil) return p.pos;
  if (!status || !p.layout) return p.pos;
  let pos = posOf(p.layout, status.para, status.frac);
  if (status.playing) pos += status.pxPerSec * Math.min(1, (now - statusAt) / 1000);
  return clamp(pos, 0, p.layout.max);
}

let lastFrame = performance.now();
function previewLoop(now) {
  const p = preview;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (p.layout) {
    const goal = previewPos(now);
    // Mode voix : pas de vitesse à prévoir, l'aperçu glisse vers la dernière position reçue.
    if (status?.voice && status.playing && !p.drag && now >= p.holdUntil) p.pos += (goal - p.pos) * Math.min(1, dt * 8);
    else p.pos = goal;
    p.content.style.transform = `translate3d(0, ${(p.layout.rl - p.pos).toFixed(2)}px, 0)`;
  }
  requestAnimationFrame(previewLoop);
}

// Glisser sur l'aperçu pour avancer ou reculer.
let lastSeek = 0;
preview.box.addEventListener('pointerdown', (e) => {
  if (!preview.layout) return;
  preview.box.setPointerCapture(e.pointerId);
  preview.drag = { y: e.clientY, start: preview.pos, id: e.pointerId };
});
preview.box.addEventListener('pointermove', (e) => {
  const d = preview.drag;
  if (!d || d.id !== e.pointerId) return;
  preview.pos = clamp(d.start - (e.clientY - d.y) / preview.scale, 0, preview.layout.max);
  const now = performance.now();
  if (now - lastSeek > 40) { lastSeek = now; sendSeek(); }
});
const endDrag = (e) => {
  const d = preview.drag;
  if (!d || d.id !== e.pointerId) return;
  preview.drag = null;
  if (Math.abs(e.clientY - d.y) > 2) {
    sendSeek();
    preview.holdUntil = performance.now() + 500;
  }
};
preview.box.addEventListener('pointerup', endDrag);
preview.box.addEventListener('pointercancel', endDrag);

function sendSeek() {
  const a = anchorOf(preview.layout, preview.pos);
  cmd('seek', { para: a.para, frac: a.frac });
}

new ResizeObserver(fitPreview).observe(preview.box);

// ---- Commandes ----

function updatePlayButton() {
  const playing = !!status?.playing;
  $('play').classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
}

const COMMANDS = {
  toggle: () => {
    if (status) { status.playing = !status.playing; statusAt = performance.now(); updatePlayButton(); }
    cmd('toggle');
  },
  top: () => cmd('top'),
  'para-prev': () => cmd('jump', { unit: 'para', n: -1 }),
  'para-next': () => cmd('jump', { unit: 'para', n: 1 }),
  'line-prev': () => cmd('jump', { unit: 'line', n: -1 }),
  'line-next': () => cmd('jump', { unit: 'line', n: 1 }),
};
document.querySelectorAll('[data-cmd]').forEach((b) => {
  b.addEventListener('click', () => COMMANDS[b.dataset.cmd]());
});

function setSpeed(v) {
  lib.pristine = false;
  settings.speed = clamp(Math.round(v), 2, 200);
  write(SET, settings);
  $('speed-value').textContent = settings.speed;
  $('speed-range').value = settings.speed;
  schedulePushSettings();
}
$('speed-down').addEventListener('click', () => setSpeed(settings.speed - (settings.speed > 20 ? 2 : 1)));
$('speed-up').addEventListener('click', () => setSpeed(settings.speed + (settings.speed >= 20 ? 2 : 1)));
$('speed-range').addEventListener('input', (e) => setSpeed(Number(e.target.value)));

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox')) return;
  if ($('pair').open) return;
  const map = {
    ' ': 'toggle', ArrowRight: 'para-next', PageDown: 'para-next', ArrowLeft: 'para-prev', PageUp: 'para-prev',
    ArrowDown: 'line-next', ArrowUp: 'line-prev', Home: 'top',
  };
  if (map[e.key]) { e.preventDefault(); COMMANDS[map[e.key]](); return; }
  if (e.key === '+' || e.key === '=') setSpeed(settings.speed + 2);
  if (e.key === '-') setSpeed(settings.speed - 2);
});

// ---- Voix ----

const VOICE_LABEL = {
  listening: 'À l\'écoute',
  starting: 'Ouverture du micro…',
  'needs-tap': 'Touchez l\'écran de l\'iPhone pour activer le micro',
  off: 'Micro coupé',
  unsupported: 'Micro indisponible : utilisez le mode sans Mac (adresse https)',
};

function updateVoiceBar() {
  const on = !!settings.voice;
  $('speed-row').hidden = on;
  $('voice-bar').hidden = !on;
  if (!on) return;
  const v = connState === 'connected' ? status?.voice : null;
  $('voice-dot').dataset.s = v?.mic || '';
  $('voice-state').textContent = !v ? 'Voix · en attente de l\'iPhone'
    : v.mic === 'listening' ? (status.playing ? 'À l\'écoute · le texte suit votre voix' : 'À l\'écoute · en pause')
    : VOICE_LABEL[v.mic] || 'Voix';
  $('voice-heard').textContent = v?.heard ? '« ' + v.heard + ' »' : '';
}
$('voice-on').addEventListener('click', () => changeSetting('voice', true));
$('voice-off').addEventListener('click', () => changeSetting('voice', false));

// ---- Onglets ----

document.querySelectorAll('[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});
function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'plan') updatePlanCurrent(true);
  if (name === 'library') renderLibrary();
}

// ---- Texte ----

const editor = $('editor');
editor.addEventListener('input', () => {
  const s = current();
  s.text = editor.value;
  s.updated = Date.now();
  lib.pristine = false;
  pullPending = 0;
  saveLib();
  renderPreview();
  schedulePushScript();
});

$('read-here').addEventListener('click', () => {
  flushScript();
  const blocks = parseScript(editor.value);
  if (!blocks.length) return;
  const idx = blockIndexAt(blocks, editor.selectionStart);
  cmd('goto', { para: idx });
});

// ---- Plan ----

let planTouchedAt = 0;
$('plan').addEventListener('scroll', () => { planTouchedAt = performance.now(); }, { passive: true });

function renderPlan() {
  const list = $('plan');
  list.textContent = '';
  if (!preview.blocks.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Le texte est vide.';
    list.appendChild(li);
    return;
  }
  let n = 0;
  preview.blocks.forEach((b, i) => {
    const li = document.createElement('li');
    li.className = b.kind;
    li.dataset.i = i;
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = b.kind === 'chapter' ? '#' : String(++n);
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = b.text;
    li.append(num, x);
    li.addEventListener('click', () => {
      cmd('goto', { para: i });
      planTouchedAt = 0;
    });
    list.appendChild(li);
  });
  updatePlanCurrent(true);
}

let planCurrent = -1;
function updatePlanCurrent(force) {
  const idx = status ? status.para : -1;
  if (idx === planCurrent && !force) return;
  planCurrent = idx;
  const list = $('plan');
  list.querySelector('li.current')?.classList.remove('current');
  const li = list.querySelector(`li[data-i="${idx}"]`);
  if (!li) return;
  li.classList.add('current');
  if (!$('plan').closest('.panel').hidden && performance.now() - planTouchedAt > 3000) {
    li.scrollIntoView({ block: 'nearest' });
  }
}

// ---- Affichage ----

const FORMAT = {
  fontSize: (v) => v + ' px',
  lineHeight: (v) => v.toFixed(2),
  margin: (v) => v + ' %',
  readingLine: (v) => v + ' %',
  catchUp: (v) => (v === 0 ? 'aucun' : v + (v > 1 ? ' mots' : ' mot')),
};

function syncSettingsUI() {
  document.querySelectorAll('[data-set]').forEach((el) => {
    const k = el.dataset.set;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = settings[k];
    const label = $('v-' + k);
    if (label) label.textContent = FORMAT[k](settings[k]);
  });
  document.querySelectorAll('[data-seg]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings[seg.dataset.seg]));
  });
  $('speed-value').textContent = settings.speed;
  $('speed-range').value = settings.speed;
  updateVoiceBar();
}

function changeSetting(k, v) {
  lib.pristine = false;
  const before = settings;
  settings = sanitizeSettings({ ...settings, [k]: v });
  write(SET, settings);
  syncSettingsUI();
  if (LAYOUT_KEYS.includes(k) || k === 'readingLine' || before.theme !== settings.theme || before.showLine !== settings.showLine) {
    renderPreview();
  }
  schedulePushSettings();
}

document.querySelectorAll('[data-set]').forEach((el) => {
  const k = el.dataset.set;
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
    changeSetting(k, el.type === 'checkbox' ? el.checked : Number(el.value));
  });
});
document.querySelectorAll('[data-seg]').forEach((seg) => {
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => changeSetting(seg.dataset.seg, b.dataset.v)));
});
$('reset-look').addEventListener('click', () => {
  settings = sanitizeSettings({ ...DEFAULT_SETTINGS, speed: settings.speed, voice: settings.voice, catchUp: settings.catchUp });
  write(SET, settings);
  syncSettingsUI();
  renderPreview();
  schedulePushSettings();
});

// ---- Scripts ----

const titleOf = (text) => {
  const line = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  return line ? line.slice(0, 70) : 'Texte sans titre';
};
const wordsOf = (text) => (text.match(/\S+/g) || []).length;

function renderLibrary() {
  const list = $('library');
  list.textContent = '';
  const sorted = [...lib.scripts].sort((a, b) => b.updated - a.updated);
  for (const s of sorted) {
    const li = document.createElement('li');
    li.classList.toggle('on', s.id === lib.currentId);
    const t = document.createElement('div');
    t.className = 'title';
    const b = document.createElement('b');
    b.textContent = titleOf(s.text);
    const small = document.createElement('small');
    const words = wordsOf(s.text);
    small.textContent = `${words} mot${words > 1 ? 's' : ''} · ${new Date(s.updated).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`
      + (s.id === lib.currentId ? ' · affiché' : '');
    t.append(b, small);
    t.addEventListener('click', () => selectScript(s.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = 'Supprimer';
    del.addEventListener('click', () => {
      if (!confirm(`Supprimer « ${titleOf(s.text)} » ?`)) return;
      lib.scripts = lib.scripts.filter((x) => x.id !== s.id);
      if (!lib.scripts.length) lib.scripts.push({ id: randomId(), text: '', updated: Date.now() });
      if (lib.currentId === s.id) {
        lib.currentId = [...lib.scripts].sort((a, b2) => b2.updated - a.updated)[0].id;
        loadCurrentIntoUI();
        pushScript();
      }
      lib.pristine = false;
      saveLib();
      renderLibrary();
    });
    li.append(t, del);
    list.appendChild(li);
  }
}

function selectScript(id) {
  if (id === lib.currentId) { showTab('text'); return; }
  flushScript();
  lib.currentId = id;
  lib.pristine = false;
  pullPending = 0;
  saveLib();
  loadCurrentIntoUI();
  pushScript();
  showTab('text');
}

function addScript(text) {
  const s = { id: randomId(), text, updated: Date.now() };
  lib.scripts.push(s);
  selectScript(s.id);
  editor.focus();
}

$('new-script').addEventListener('click', () => addScript(''));
$('import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  addScript(text.replace(/\r\n?/g, '\n'));
});

function loadCurrentIntoUI() {
  editor.value = current().text;
  syncSettingsUI();
  renderPreview();
  updateSync();
  if (!$('library').closest('.panel').hidden) renderLibrary();
}

// ---- Appairage ----

function displayUrl() {
  if (mode === 'local') {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const ip = modeInfo?.addresses?.[0];
    const origin = loopback && ip ? `http://${ip}:${modeInfo.port}` : location.origin;
    return origin + new URL('display.html', location.href).pathname;
  }
  return new URL('display.html?code=' + code, location.href).href;
}

function openPair() {
  const url = displayUrl();
  $('pair-url').textContent = url;
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  $('pair-code-row').hidden = mode !== 'online';
  $('pair-code').value = code;
  $('pair-intro').textContent = mode === 'online'
    ? 'Avec l\'appareil photo de l\'iPhone, scannez ce QR code, puis touchez le lien. Si l\'iPhone affiche déjà un autre code, saisissez-le ici.'
    : 'L\'iPhone doit être sur le même Wi-Fi que le Mac. Avec son appareil photo, scannez ce QR code, puis touchez le lien.';
  if (!$('pair').open) $('pair').showModal();
}
$('conn').addEventListener('click', () => (connState === 'replaced' ? link?.reconnectNow() : openPair()));
$('pair-apply').addEventListener('click', async () => {
  const v = $('pair-code').value.trim();
  if (!/^\d{6}$/.test(v)) { $('pair-code').focus(); return; }
  if (v !== code) {
    code = v;
    write(CODE, code);
    link?.close();
    await connect();
  }
  openPair();
});

// ---- Démarrage ----

async function connect() {
  status = null;
  link = await createLink({ role: 'remote', code, onMessage, onState, onPeerJoined });
  mode = link.mode;
  onState(connState);
}

loadCurrentIntoUI();
requestAnimationFrame(previewLoop);
document.fonts?.ready.then(renderPreview);

(async () => {
  const d = await detectMode();
  mode = d.mode;
  modeInfo = d.info;
  await connect();
  if (!read(PAIRED, false)) setTimeout(() => { if (connState !== 'connected') openPair(); }, 1200);
})();

// Accès pour les tests automatiques.
window.__ipp = {
  get status() { return status; }, get settings() { return settings; }, get lib() { return lib; },
  preview, get connState() { return connState; }, COMMANDS, setSpeed, changeSetting, selectScript, addScript,
};
