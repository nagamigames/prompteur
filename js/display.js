// Écran du prompteur (iPhone posé sur le support). Il fait défiler le texte et obéit à la régie.

import {
  DEFAULT_SETTINGS, LAYOUT_KEYS, SAMPLE_SCRIPT, sanitizeSettings, parseScript, remapAnchor,
  renderBlocks, applyStageStyle, measure, paraAt, anchorOf, posOf, hash, settingsHash, clamp, randomCode,
} from './shared.js';
import { createLink } from './link.js';
import { tokenize, splitHeard, createFollower, createMic } from './voice.js';

const STORE = 'ipp.display';
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const content = $('content');
const hud = $('hud');

const saved = load();
const st = {
  script: saved.script || { id: 'exemple', text: SAMPLE_SCRIPT },
  settings: sanitizeSettings(saved.settings || DEFAULT_SETTINGS),
  blocks: [],
  rendered: null,
  layout: null,
  pos: 0,
  playing: false,
  anim: null,
  lastSent: 0,
  connState: 'connecting',
};

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save() {
  const a = st.layout ? anchorOf(st.layout, st.pos) : { para: 0, frac: 0 };
  try {
    localStorage.setItem(STORE, JSON.stringify({ script: st.script, settings: st.settings, anchor: a, code }));
  } catch {}
}

// ---- Code d'appairage (mode en ligne) ----
const params = new URLSearchParams(location.search);
let code = params.get('code') || saved.code || randomCode();
if (!/^\d{6}$/.test(code)) code = randomCode();

// ---- Mise en page ----

function render(anchor) {
  st.blocks = parseScript(st.script.text);
  applyStageStyle(stage, st.settings, { mirror: true });
  st.rendered = renderBlocks(document, content, st.blocks);
  voice.words = tokenize(st.blocks);
  voice.firstOfBlock = [];
  for (let b = 0, i = 0; b < st.blocks.length; b++) {
    while (i < voice.words.length && voice.words[i].b < b) i++;
    voice.firstOfBlock.push(i);
  }
  voice.follower.setWords(voice.words);
  relayout(anchor);
}

function relayout(anchor) {
  const a = anchor || (st.layout ? anchorOf(st.layout, st.pos) : { para: 0, frac: 0 });
  st.layout = measure(stage, st.rendered, st.settings);
  st.pos = posOf(st.layout, a.para, a.frac);
  st.anim = null;
  voice.tops.clear();
  voiceMoved(st.pos);
  paint();
  sendStatus(true);
}

function paint() {
  content.style.transform = `translate3d(0, ${(st.layout.rl - st.pos).toFixed(2)}px, 0)`;
}

const pxPerSec = () => (st.settings.speed / 60) * st.layout.lineH;

// ---- Déplacements ----

function animateTo(target) {
  target = clamp(target, 0, st.layout.max);
  st.anim = { from: st.pos, to: target, start: performance.now(), dur: 260 };
}

function jump(unit, n) {
  const L = st.layout;
  const base = st.anim ? st.anim.to : st.pos;
  if (unit === 'line') return animateTo(base + n * L.lineH);
  if (!L.tops.length) return;
  const cur = paraAt(L, base);
  let target;
  if (n > 0) {
    target = cur + 1 < L.tops.length ? L.tops[cur + 1] : L.max;
  } else {
    // Si l'on est déjà avancé dans le paragraphe, on revient à son début ; sinon au précédent.
    target = base - L.tops[cur] > L.lineH * 0.5 ? L.tops[cur] : L.tops[Math.max(0, cur - 1)];
  }
  animateTo(target);
}

function play() {
  if (st.pos >= st.layout.max - 0.5) { st.pos = 0; st.anim = null; voiceMoved(0); }
  st.playing = true;
}

function handleCommand(m) {
  switch (m.c) {
    case 'play': play(); break;
    case 'pause': st.playing = false; break;
    case 'toggle': st.playing ? (st.playing = false) : play(); break;
    case 'jump': jump(m.unit === 'para' ? 'para' : 'line', Math.sign(m.n) || 1); break;
    case 'goto': if (st.layout.tops.length) animateTo(posOf(st.layout, m.para, 0)); break;
    case 'seek': st.anim = null; st.pos = posOf(st.layout, m.para, m.frac); paint(); break;
    case 'top': st.anim = null; st.pos = 0; paint(); break;
  }
  if (['jump', 'goto', 'seek', 'top'].includes(m.c)) voiceMoved(st.anim ? st.anim.to : st.pos);
  else if (st.playing) voice.follower.resetHere(); // reprise : les mots dits pendant la pause ne comptent pas
  sendStatus(true);
  save();
}

function applyScript(m) {
  if (typeof m.text !== 'string' || typeof m.id !== 'string') return;
  if (m.id === st.script.id && m.text === st.script.text) return;
  if (m.id !== st.script.id) {
    st.script = { id: m.id, text: m.text };
    st.playing = false;
    render({ para: 0, frac: 0 });
  } else {
    const oldBlocks = st.blocks;
    const a = anchorOf(st.layout, st.pos);
    st.script = { id: m.id, text: m.text };
    const r = remapAnchor(oldBlocks, parseScript(m.text), a.para);
    render({ para: r.index, frac: r.same ? a.frac : Math.min(a.frac, 0.5) });
  }
  save();
}

function applySettings(m) {
  const next = sanitizeSettings(m.s);
  const prev = st.settings;
  st.settings = next;
  const layoutChanged = LAYOUT_KEYS.some((k) => prev[k] !== next[k]);
  applyStageStyle(stage, next, { mirror: true });
  if (prev.voice !== next.voice) {
    voice.target = null;
    if (voiceOn()) { voiceMoved(st.pos); mic.start(); } else mic.stop();
    updateMicPrompt();
  }
  if (layoutChanged || prev.readingLine !== next.readingLine) relayout();
  else sendStatus(true);
  save();
}

// ---- Boucle d'animation ----

let lastT = performance.now();
let lastSave = 0;
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  const L = st.layout;
  let moved = false;
  if (st.playing && voiceOn()) {
    // Mode voix : le texte glisse vers la ligne du prochain mot à lire.
    if (voice.target !== null && !st.anim) {
      const diff = voice.target - st.pos;
      if (diff !== 0) {
        // Glissé doux, avec une vitesse minimale pour finir d'arriver.
        const step = Math.min(Math.abs(diff), Math.max(Math.abs(diff) * Math.min(1, dt * 6), 60 * dt));
        st.pos += Math.sign(diff) * step;
        moved = true;
      }
    }
  } else if (st.playing) {
    const d = pxPerSec() * dt;
    if (st.anim) { st.anim.from += d; st.anim.to += d; } else st.pos += d;
    moved = true;
  }
  if (st.anim) {
    const k = clamp((t - st.anim.start) / st.anim.dur, 0, 1);
    const e = 1 - Math.pow(1 - k, 3);
    st.pos = st.anim.from + (st.anim.to - st.anim.from) * e;
    if (k >= 1) st.anim = null;
    moved = true;
  }
  if (moved) {
    if (st.pos >= L.max) {
      st.pos = L.max;
      st.anim = null;
      if (st.playing) { st.playing = false; sendStatus(true); save(); }
    }
    if (st.pos < 0) st.pos = 0;
    paint();
    sendStatus(false);
    if (t - lastSave > 2000) { lastSave = t; save(); }
  }
  requestAnimationFrame(frame);
}

// ---- Suivi de la voix ----
// L'iPhone écoute ; chaque mot reconnu fait avancer le texte (voice.js). Les sauts restent à la régie.

const voice = {
  words: [],
  firstOfBlock: [],
  follower: createFollower(),
  target: null,      // position vers laquelle le texte glisse
  heard: '',         // derniers mots entendus, montrés sur la régie
  tops: new Map(),   // mot → position de sa ligne (calculée à la demande)
};
const mic = createMic({
  onWords: onHeard,
  onSession: () => voice.follower.newSession(),
  onState: () => { updateMicPrompt(); sendStatus(true); },
});
const voiceOn = () => st.settings.voice && mic.supported;
const voiceGliding = () => voiceOn() && st.playing && voice.target !== null && voice.target !== st.pos;
const range = document.createRange();

// Position (px) de la ligne où se trouve le mot i.
function wordTop(i) {
  if (i >= voice.words.length) return st.layout.max;
  if (voice.tops.has(i)) return voice.tops.get(i);
  const w = voice.words[i];
  const el = st.rendered.els[w.b];
  const node = el.firstChild;
  let top = st.layout.tops[w.b];
  if (node) {
    range.setStart(node, Math.min(w.start, node.length));
    range.setEnd(node, Math.min(w.end, node.length));
    const r = range.getClientRects()[0];
    if (r) {
      const box = el.getBoundingClientRect();
      const off = st.settings.mirrorY ? box.bottom - r.bottom : r.top - box.top; // l'écran peut être retourné
      top += Math.max(0, Math.floor((off + r.height / 2) / st.layout.lineH)) * st.layout.lineH;
    }
  }
  voice.tops.set(i, top);
  return top;
}

// Premier mot sur la ligne de lecture quand le texte est à la position p.
function wordAt(p) {
  const L = st.layout;
  if (!voice.words.length || !L.tops.length) return 0;
  let i = voice.firstOfBlock[paraAt(L, p)] ?? voice.words.length;
  while (i < voice.words.length && wordTop(i) < p - L.lineH * 0.5) i++;
  return i;
}

// Déplacement à la main (ou nouveau texte) : le suivi repart de là.
function voiceMoved(p) {
  if (!st.layout) return;
  voice.target = null;
  voice.follower.moveTo(wordAt(p));
}

function onHeard(text) {
  voice.heard = text.trim().split(/\s+/).slice(-8).join(' ');
  const heard = splitHeard(text);
  if (voiceOn() && st.playing && !st.anim) {
    if (voice.follower.feed(heard, st.settings.catchUp)) voice.target = wordTop(voice.follower.pos);
  } else {
    voice.follower.heardNow = heard.length; // entendu en pause : ignoré à la reprise
  }
  sendStatus(false);
}

function updateMicPrompt() {
  $('mic-prompt').hidden = !(voiceOn() && mic.state === 'needs-tap' && $('overlay').hidden);
}

// ---- Liaison ----

let link = null;

function status() {
  const a = anchorOf(st.layout, st.pos);
  return {
    t: 'status',
    para: a.para,
    frac: a.frac,
    playing: st.playing,
    moving: (st.playing && !voiceOn()) || !!st.anim || voiceGliding(),
    pxPerSec: st.playing && !voiceOn() ? pxPerSec() : 0,
    voice: st.settings.voice ? { mic: mic.state, heard: voice.heard } : null,
    atEnd: st.pos >= st.layout.max - 0.5,
    vw: st.layout.w,
    vh: st.layout.h,
    scriptId: st.script.id,
    scriptHash: hash(st.script.text),
    settingsHash: settingsHash(st.settings),
  };
}

function sendStatus(force) {
  if (!link || !st.layout) return;
  const now = performance.now();
  if (!force && now - st.lastSent < 100) return;
  st.lastSent = now;
  link.send(status());
}

setInterval(() => sendStatus(true), 1500);

function onMessage(m) {
  if (!st.layout) return;
  switch (m.t) {
    case 'cmd': handleCommand(m); break;
    case 'script': applyScript(m); sendStatus(true); break;
    case 'settings': applySettings(m); break;
    case 'hello': sendStatus(true); break;
    case 'pull':
      link.send({ t: 'current', id: st.script.id, text: st.script.text, s: st.settings });
      break;
  }
}

function onState(s) {
  st.connState = s;
  hud.dataset.state = s;
  const label = hud.querySelector('.label');
  const online = link?.mode === 'online';
  if (s === 'connected') label.textContent = 'Régie connectée';
  else if (s === 'waiting') label.textContent = online ? `En attente de la régie · code ${code}` : 'En attente de la régie';
  else if (s === 'replaced') label.textContent = 'Écran ouvert sur un autre appareil';
  else label.textContent = 'Connexion…';
  hud.classList.toggle('discreet', s === 'connected' && overlay.hidden);
  updateOverlay();
  if (s === 'connected') sendStatus(true);
}

// ---- Écran d'accueil, veille ----

const overlay = $('overlay');
let wakeLock = null;

async function keepAwake() {
  if ('wakeLock' in navigator && window.isSecureContext) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      return 'wakelock';
    } catch {}
  }
  try {
    await $('keepawake').play();
    return 'video';
  } catch {
    return 'none';
  }
}

function updateOverlay() {
  if (overlay.hidden) return;
  const online = link?.mode === 'online';
  $('overlay-code').hidden = !online || st.connState === 'connected';
  $('overlay-code').textContent = code;
  $('overlay-status').textContent =
    st.connState === 'connected' ? 'Régie connectée. Touchez le bouton pour passer en mode lecture.'
    : online ? 'Sur l\'iPad, dans la régie, saisissez ce code ou scannez le QR code :'
    : st.connState === 'waiting' ? 'En attente de la régie. Ouvrez la régie sur l\'iPad.'
    : st.connState === 'replaced' ? 'L\'écran est ouvert sur un autre appareil ou un autre onglet. Rechargez cette page pour le reprendre ici.'
    : 'Connexion au Mac…';
}

$('activate').addEventListener('click', async () => {
  overlay.hidden = true;
  if (voiceOn()) mic.start(); // iOS veut un toucher pour ouvrir le micro
  updateMicPrompt();
  hud.classList.toggle('discreet', st.connState === 'connected');
  await keepAwake();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && overlay.hidden) keepAwake();
});

$('overlay-tip').textContent = window.isSecureContext && 'wakeLock' in navigator
  ? ''
  : 'Conseil : pour que l\'écran ne se mette jamais en veille, Réglages › Luminosité et affichage › Verrouillage automatique › Jamais.';

// Double toucher sur l'écran : lecture / pause (secours si la régie est indisponible).
let lastTap = 0;
stage.addEventListener('pointerup', () => {
  if (voiceOn() && mic.state !== 'listening' && mic.state !== 'starting') mic.start();
  const now = Date.now();
  if (now - lastTap < 320) { handleCommand({ c: 'toggle' }); lastTap = 0; } else lastTap = now;
});

// Clavier ou pédale Bluetooth branchés sur l'iPhone.
document.addEventListener('keydown', (e) => {
  const map = {
    ' ': { c: 'toggle' }, Enter: { c: 'toggle' },
    ArrowRight: { c: 'jump', unit: 'para', n: 1 }, PageDown: { c: 'jump', unit: 'para', n: 1 },
    ArrowLeft: { c: 'jump', unit: 'para', n: -1 }, PageUp: { c: 'jump', unit: 'para', n: -1 },
  };
  const m = map[e.key];
  if (m) { e.preventDefault(); handleCommand(m); }
});

// Rotation ou redimensionnement : on garde le même endroit du texte.
let resizeTimer = null;
const onResize = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => relayout(), 120);
};
window.addEventListener('resize', onResize);
window.visualViewport?.addEventListener('resize', onResize);

// ---- Démarrage ----

if (voiceOn()) mic.start(); // sans toucher, iOS peut refuser : l'écran demandera alors un toucher

render(saved.anchor || { para: 0, frac: 0 });
document.fonts?.ready.then(() => relayout());
requestAnimationFrame(frame);
save();

createLink({ role: 'display', code, onMessage, onState }).then((l) => {
  link = l;
  onState(st.connState);
  sendStatus(true);
});

// Accès pour les tests automatiques.
window.__ipp = { st, handleCommand, voice, mic, wordAt, wordTop, get link() { return link; } };
