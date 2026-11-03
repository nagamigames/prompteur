// Code commun à l'écran (iPhone), à la régie (iPad) et aux tests (Node).

export const DEFAULT_SETTINGS = {
  speed: 20,          // lignes par minute
  fontSize: 56,       // px
  lineHeight: 1.35,
  margin: 6,          // % de largeur, de chaque côté
  readingLine: 30,    // % de hauteur, depuis le haut
  showLine: true,
  mirrorX: false,
  mirrorY: false,
  align: 'left',      // left | center
  theme: 'dark',      // dark | yellow | light
  voice: false,       // le texte suit la voix (micro de l'iPhone)
  catchUp: 5,         // rattrapage du suivi vocal, en mots (0 : jamais)
};

export const LIMITS = {
  speed: [2, 200],
  fontSize: [20, 160],
  lineHeight: [1, 2.2],
  margin: [0, 30],
  readingLine: [5, 70],
  catchUp: [0, 15],
};

// Réglages qui changent la mise en page (les autres ne demandent pas de recalcul).
export const LAYOUT_KEYS = ['fontSize', 'lineHeight', 'margin', 'align'];

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function sanitizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object') return s;
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const v = Number(input[key]);
    if (Number.isFinite(v)) s[key] = clamp(v, min, max);
  }
  s.catchUp = Math.round(s.catchUp);
  for (const key of ['showLine', 'mirrorX', 'mirrorY', 'voice']) {
    if (typeof input[key] === 'boolean') s[key] = input[key];
  }
  if (input.align === 'left' || input.align === 'center') s.align = input.align;
  if (['dark', 'yellow', 'light'].includes(input.theme)) s.theme = input.theme;
  return s;
}

// Découpe le texte en blocs : une ligne vide sépare deux paragraphes,
// une ligne qui commence par # est un repère de chapitre.
// Chaque bloc garde sa position de départ dans le texte (pour « lire depuis le curseur »).
export function parseScript(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const blocks = [];
  let cur = null;
  let offset = 0;
  const flush = () => {
    if (cur) {
      const t = cur.lines.join('\n').trim();
      if (t) blocks.push({ kind: 'para', text: t, start: cur.start });
      cur = null;
    }
  };
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
    } else if (trimmed.startsWith('#')) {
      flush();
      const title = trimmed.replace(/^#+\s*/, '');
      if (title) blocks.push({ kind: 'chapter', text: title, start: offset });
    } else {
      if (!cur) cur = { lines: [], start: offset };
      cur.lines.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return blocks;
}

// Index du bloc qui contient la position `caret` du texte.
export function blockIndexAt(blocks, caret) {
  let idx = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].start <= caret) idx = i;
    else break;
  }
  return idx;
}

const blockKey = (b) => b.kind + '\u0000' + b.text;

// Après une modification du texte, retrouve le bloc qui correspond à `index`.
// `same` vaut false quand le bloc lui-même a été modifié.
export function remapAnchor(oldBlocks, newBlocks, index) {
  const a = oldBlocks.map(blockKey);
  const b = newBlocks.map(blockKey);
  if (!b.length) return { index: 0, same: false };
  if (index < 0) return { index: 0, same: false };
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (index < p) return { index, same: true };
  if (index >= a.length - s) return { index: clamp(index + b.length - a.length, 0, b.length - 1), same: true };
  const lastChanged = b.length - s - 1;
  if (lastChanged >= p) return { index: clamp(index, p, lastChanged), same: false };
  return { index: clamp(p, 0, b.length - 1), same: false };
}

export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function settingsHash(s) {
  const clean = sanitizeSettings(s);
  return hash(JSON.stringify(Object.keys(clean).sort().map((k) => [k, clean[k]])));
}

export function randomId(len = 10) {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

export function randomCode() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => String(b % 10)).join('');
}

// ---- Mise en page partagée entre l'écran et l'aperçu de la régie ----

// Remplit `content` avec les blocs (textContent : aucun HTML injecté).
export function renderBlocks(doc, content, blocks) {
  content.textContent = '';
  const els = [];
  for (const b of blocks) {
    const el = doc.createElement('div');
    el.className = 'block ' + b.kind;
    el.textContent = b.text;
    content.appendChild(el);
    els.push(el);
  }
  const end = doc.createElement('div');
  end.className = 'end';
  end.textContent = '— Fin —';
  content.appendChild(end);
  return { els, end };
}

export function applyStageStyle(stage, settings, opts = {}) {
  const s = settings;
  stage.style.setProperty('--fs', s.fontSize + 'px');
  stage.style.setProperty('--lh', String(s.lineHeight));
  stage.style.setProperty('--margin', s.margin + '%');
  stage.style.setProperty('--align', s.align);
  stage.style.setProperty('--rl', s.readingLine + '%');
  stage.dataset.theme = s.theme;
  stage.classList.toggle('no-line', !s.showLine);
  if (opts.mirror) {
    const sx = s.mirrorX ? -1 : 1;
    const sy = s.mirrorY ? -1 : 1;
    stage.style.transform = sx === 1 && sy === 1 ? '' : `scale(${sx}, ${sy})`;
  }
}

// Positions des blocs dans le contenu, en px.
export function measure(stage, rendered, settings) {
  const tops = rendered.els.map((el) => el.offsetTop);
  const endTop = rendered.end.offsetTop;
  const spans = tops.map((t, i) => Math.max(1, (i + 1 < tops.length ? tops[i + 1] : endTop) - t));
  return {
    tops,
    spans,
    max: endTop,
    lineH: settings.fontSize * settings.lineHeight,
    rl: (stage.clientHeight * settings.readingLine) / 100,
    w: stage.clientWidth,
    h: stage.clientHeight,
  };
}

export function paraAt(layout, pos) {
  const t = layout.tops;
  if (!t.length) return 0;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= pos + 0.5) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function anchorOf(layout, pos) {
  if (!layout.tops.length) return { para: 0, frac: 0 };
  const para = paraAt(layout, pos);
  const frac = clamp((pos - layout.tops[para]) / layout.spans[para], 0, 1);
  return { para, frac };
}

export function posOf(layout, para, frac) {
  if (!layout.tops.length) return 0;
  const i = clamp(Math.round(para) || 0, 0, layout.tops.length - 1);
  return clamp(layout.tops[i] + clamp(frac || 0, 0, 1) * layout.spans[i], 0, layout.max);
}

export const SAMPLE_SCRIPT = `# Bienvenue

Ceci est un texte d'exemple. Remplacez-le dans l'onglet Texte de la régie.

Une ligne vide sépare deux paragraphes. Les boutons « Paragraphe » sautent de l'un à l'autre.

# Repères

Une ligne qui commence par # devient un repère de chapitre. Il apparaît dans l'onglet Plan : touchez-le pour y aller directement.

# Vitesse

Réglez la vitesse avec les boutons moins et plus, ou avec le curseur. Le changement s'applique tout de suite, même pendant la lecture.

Bon tournage !`;
