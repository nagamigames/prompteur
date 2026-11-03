// Suivi de la voix : l'iPhone écoute la lecture et le texte avance avec elle.
// Validé sur iPhone (Safari) avec la page d'essai voix.html, puis repris ici.
//
// Deux parties :
//  - createFollower : retrouve où en est la lecture dans le texte, pas à pas (jamais de saut lointain).
//  - createMic : garde la reconnaissance vocale ouverte et la relance si le système la coupe.

export const norm = (w) =>
  w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Mots du texte à lire, avec leur place (bloc, caractères). Les repères (# Titre) ne se lisent pas : exclus.
export function tokenize(blocks) {
  const words = [];
  blocks.forEach((b, bi) => {
    if (b.kind !== 'para') return;
    for (const m of b.text.matchAll(/\S+/g)) {
      // « l'idée » → deux mots pour la reconnaissance (« l », « idée »).
      for (const piece of m[0].split(/['’-]/)) {
        const n = norm(piece);
        if (n) words.push({ b: bi, start: m.index, end: m.index + m[0].length, n });
      }
    }
  });
  return words;
}

export const splitHeard = (text) => text.split(/[\s'’-]+/).map(norm).filter(Boolean);

// Mots proches : identiques, ou à une lettre près pour les mots de 4 lettres et plus (accords, pluriels).
export function close(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

const STEP = 3; // mots du texte que la reconnaissance peut avoir manqués entre deux mots entendus

// catchUp : rattrapage (réglable de 0 à 15) — 3 mots entendus d'affilée retrouvés au plus catchUp mots plus loin.
export function follow(words, cur, heard, catchUp) {
  for (let h = 0; h < heard.length; h++) {
    const w = heard[h];
    const reach = w.length < 3 ? 1 : STEP; // « de », « la », « et » : seulement le mot attendu ou le suivant
    let hit = -1;
    for (let k = cur; k <= Math.min(words.length - 1, cur + reach); k++) {
      if (close(w, words[k].n)) { hit = k; break; }
    }
    if (hit < 0 && catchUp > 0 && h + 2 < heard.length) {
      for (let k = cur; k <= Math.min(words.length - 3, cur + catchUp); k++) {
        if (close(w, words[k].n) && close(heard[h + 1], words[k + 1].n) && close(heard[h + 2], words[k + 2].n)) { hit = k; break; }
      }
    }
    if (hit >= 0) cur = hit + 1;
  }
  return cur;
}

// État du suivi : prochain mot à lire, et point de départ (le suivi est refait depuis là à chaque résultat,
// car la reconnaissance réécrit parfois ses derniers mots).
export function createFollower() {
  const f = {
    words: [],
    pos: 0,
    anchor: { pos: 0, heard: 0 },
    heardNow: 0,
    setWords(words) { f.words = words; f.pos = Math.min(f.pos, words.length); f.resetHere(); },
    // Le suivi repart du mot i : saut fait à la main, reprise après pause, nouvelle écoute.
    moveTo(i) { f.pos = Math.max(0, Math.min(i, f.words.length)); f.resetHere(); },
    resetHere() { f.anchor = { pos: f.pos, heard: f.heardNow }; },
    newSession() { f.heardNow = 0; f.resetHere(); },
    // Renvoie true si la lecture a avancé.
    feed(heard, catchUp) {
      f.heardNow = heard.length;
      const next = follow(f.words, f.anchor.pos, heard.slice(Math.min(f.anchor.heard, heard.length)), catchUp);
      if (next > f.pos) { f.pos = next; return true; }
      return false;
    },
  };
  return f;
}

// Micro : un seul objet de reconnaissance, gardé ouvert. Sur iPhone, en recréer un après un arrêt le rend souvent sourd.
// onState('off' | 'starting' | 'listening' | 'needs-tap' | 'denied' | 'unsupported')
export function createMic({ onWords, onState, onSession, log = () => {} }) {
  const Rec = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  let rec = null, wanted = false, running = false, state = '', startTimer = null;
  const setState = (s) => { if (s !== state) { state = s; onState?.(s); } };

  state = Rec && window.isSecureContext ? 'off' : 'unsupported'; // état de départ, sans prévenir

  function build() {
    const r = new Rec();
    r.lang = 'fr-FR';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => { running = true; clearTimeout(startTimer); onSession?.(); setState('listening'); log('écoute démarrée'); };
    r.onresult = (ev) => {
      let text = '';
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript + ' ';
      onWords?.(text);
    };
    r.onerror = (ev) => {
      log('erreur micro : ' + ev.error);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        // Sans geste de l'utilisateur, iOS refuse : il faudra un toucher sur l'écran.
        clearTimeout(startTimer);
        setState(wanted ? 'needs-tap' : 'off');
      }
    };
    r.onend = () => {
      running = false;
      log('écoute terminée');
      if (wanted && state === 'listening') setTimeout(relaunch, 250); // coupée par le système : on relance
      else if (!wanted) setState('off');
    };
    return r;
  }

  function relaunch() {
    if (!wanted || running) return;
    setState('starting');
    clearTimeout(startTimer);
    // Pas de démarrage au bout de 2 s : iOS attend sans doute un toucher.
    startTimer = setTimeout(() => { if (wanted && !running) setState('needs-tap'); }, 2000);
    try {
      rec.start();
    } catch (e) {
      if (e.name === 'InvalidStateError') return; // déjà en route
      log('micro : objet neuf (' + e.name + ')');
      rec = build();
      try { rec.start(); } catch { setState('needs-tap'); }
    }
  }

  return {
    get state() { return state; },
    supported: !!Rec && typeof window !== 'undefined' && window.isSecureContext,
    // À appeler de préférence depuis un toucher (iOS l'exige au moins la première fois).
    start() {
      if (!this.supported) return;
      wanted = true;
      if (!rec) rec = build();
      if (running) return;
      relaunch();
    },
    stop() {
      wanted = false;
      clearTimeout(startTimer);
      try { rec?.abort(); } catch {}
      if (!running) setState('off');
    },
  };
}
