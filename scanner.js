// Card scanner: reads a photo of a card and finds the exact printing.
//
// Works across every era of card layout:
//  1. Read the card name from the top of the card. The OCR text is matched against the list of
//     every real card name (so "Lugi gia" -> Lugia), preferring the largest text (the name is
//     printed bigger than "Evolves from ..." lines).
//  2. Read the collector number. Modern cards print it bottom-left, older ones bottom-right,
//     and some use letters (TG05/TG30, SWSH050, RC12/RC32), so several crops are tried.
//  3. If name + number pin down one printing, done. Otherwise compare the photo's look
//     (artwork, frame colours) with the picture of every printing of that name and rank them.
'use strict';

const Scanner = {
  workers: null,
  index: null,

  // ---------- Card index: every card's id, number, name and image (≈20k cards) ----------
  async loadIndex() {
    if (this.index) return this.index;
    if (this._indexP) return this._indexP;
    this._indexP = (async () => {
      let rows = null, setPaths = null;
      try {
        const c = JSON.parse(localStorage.getItem('df.index.v2') || 'null');
        if (c && Date.now() - c.at < 7 * 864e5) { rows = c.rows; setPaths = c.setPaths; }
      } catch (e) { /* refetch */ }
      if (!rows) {
        const res = await fetch(`${API_REST}/cards`);
        if (!res.ok) throw new Error('Could not download the card list.');
        const all = await res.json();
        setPaths = {};
        rows = [];
        for (const c of all) {
          if (isPocketCard(c)) continue;
          const setId = c.id.slice(0, c.id.lastIndexOf('-'));
          // image = https://assets.tcgdex.net/en/<serie>/<set>/<localId>; keep "<serie>/<set>" once per set
          if (c.image && !setPaths[setId]) setPaths[setId] = c.image.replace('https://assets.tcgdex.net/en/', '').replace(/\/[^/]+$/, '');
          rows.push([c.id, c.localId, c.name, c.image ? 1 : 0]);
        }
        try { localStorage.setItem('df.index.v2', JSON.stringify({ at: Date.now(), rows, setPaths })); } catch (e) { /* too big for storage: keep in memory */ }
      }
      this.setPaths = setPaths;
      const byName = new Map();
      for (const [id, localId, name, hasImg] of rows) {
        const key = normName(name);
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, { name, key, cards: [] });
        byName.get(key).cards.push({ id, localId, hasImg });
      }
      // Trigram index for fast fuzzy lookups
      const tri = new Map();
      for (const entry of byName.values()) {
        for (const g of trigrams(entry.key)) {
          if (!tri.has(g)) tri.set(g, []);
          tri.get(g).push(entry);
        }
      }
      this.index = { byName, tri };
      return this.index;
    })();
    try { return await this._indexP; } catch (e) { this._indexP = null; throw e; }
  },

  // ---------- OCR ----------
  async getWorkers() {
    if (this.workers) return this.workers;
    const T = await loadTesseract();
    const [text, digits] = await Promise.all([T.createWorker('eng'), T.createWorker('eng')]);
    // Sparse-text mode finds small isolated strings like "4/102" anywhere in the crop.
    await digits.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    this.workers = { text, digits };
    return this.workers;
  },

  // Find the best-matching real card names in the top strip of the card.
  async readName(canvas) {
    const { text } = await this.getWorkers();
    const idx = await this.loadIndex();
    let best = [];
    // Different layouts need different reads: normal text mode first, then sparse mode
    // (names floating over artwork), black/white, and inverted (white names on dark V/VMAX bars).
    // Text size matters to the OCR engine, so a couple of passes use a smaller scale.
    const passes = [['3', 'plain', 0.15, 1400], ['11', 'plain', 0.15, 1400], ['3', 'bw', 0.13, 1400], ['11', 'invert', 0.15, 1400], ['3', 'invert', 0.12, 800], ['6', 'plain', 0.1, 900]];
    for (const [psm, variant, h, width] of passes) {
      await text.setParameters({ tessedit_pageseg_mode: psm });
      const r = await text.recognize(prepCrop(canvas, 0, 0, 1, h, width / canvas.width, variant));
      const words = (r.data.words || []).map(w => ({ t: w.text, h: w.bbox.y1 - w.bbox.y0, conf: w.confidence }))
        .filter(w => /[A-Za-zÀ-ÿ]{2,}/.test(w.t));
      best = mergeMatches(best, matchNames(words, idx));
      if (best[0] && best[0].score > 0.88) break;
    }
    if (!best.length || best[0].score < 0.6) {
      // Unusual layout (full art, name lower down): read the whole card; the name is
      // still the biggest text, which matchNames prefers.
      await text.setParameters({ tessedit_pageseg_mode: '11' });
      const r = await text.recognize(prepCrop(canvas, 0, 0, 1, 1, 1000 / canvas.width, 'plain'));
      const words = (r.data.words || []).map(w => ({ t: w.text, h: w.bbox.y1 - w.bbox.y0 })).filter(w => /[A-Za-zÀ-ÿ]{2,}/.test(w.t));
      best = mergeMatches(best, matchNames(words, idx).map(m => ({ ...m, score: m.score - 0.05 })));
    }
    return best.slice(0, 4);
  },

  async readNumber(canvas) {
    const { digits } = await this.getWorkers();
    const scale = 2400 / canvas.width;
    const crops = [
      [0, 0.88, 0.55, 0.12],    // modern: bottom-left
      [0.45, 0.88, 0.55, 0.12], // older: bottom-right
      [0, 0.84, 1, 0.16],
    ];
    for (const [x, y, w, h] of crops) {
      for (const variant of ['bw', 'plain']) {
        const r = await digits.recognize(prepCrop(canvas, x, y, w, h, scale, variant));
        const num = parseCollectorNumber(r.data.text);
        if (num) return num;
      }
    }
    return null;
  },

  // ---------- Main entry ----------
  async identify(photo, onStep = () => {}) {
    onStep('Loading the card list…');
    await Promise.all([this.loadIndex(), CardDB.loadSets()]);
    const canvas = autoCropCard(photo);
    onStep('Reading the name…');
    const names = await this.readName(canvas);
    onStep('Reading the card number…');
    const num = await this.readNumber(canvas);
    const idx = this.index;

    // Candidate printings: every printing of the matched names, plus their variants
    // (Venusaur -> Venusaur EX / Venusaur V / Mega Venusaur ex), because suffix logos
    // like "EX" or "VSTAR" are stylised and OCR rarely reads them.
    let cands = [];
    const added = new Set();
    const addEntry = (entry, nameScore) => {
      for (const c of entry.cards) if (!added.has(c.id)) { added.add(c.id); cands.push({ ...c, name: entry.name, nameScore }); }
    };
    const strongNames = names.filter(n => n.score >= Math.max(0.55, (names[0]?.score || 0) - 0.12));
    for (const n of strongNames) addEntry(n.entry, n.score);
    for (const n of strongNames) {
      const re = new RegExp(`(^|[ '])${n.entry.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
      for (const e of idx.byName.values()) if (e !== n.entry && re.test(e.key)) addEntry(e, n.score - 0.1);
    }

    // Number filter (allowing one misread digit in the set total)
    if (num) {
      const byNum = cands.filter(c => sameNumber(c.localId, num.number));
      const totalOk = c => !num.total || closeTotal(setTotalOf(c.id), num.total);
      const byNumAndTotal = byNum.filter(c => setTotalOf(c.id) === num.total);
      if (byNumAndTotal.length) cands = byNumAndTotal;
      else if (byNum.filter(totalOk).length) cands = byNum.filter(totalOk);
      else if (byNum.length) {
        // Number matches but the set total doesn't: the number may be misread, so don't
        // filter on it — just nudge those printings up and let the artwork decide.
        for (const c of byNum) c.nameScore += 0.3;
      } else if (!cands.length) {
        // Name unreadable (or wrong): look the number up across every card
        const pool = [];
        for (const e of idx.byName.values()) for (const c of e.cards) if (sameNumber(c.localId, num.number) && totalOk(c)) pool.push({ ...c, name: e.name, nameScore: 0 });
        if (pool.length && pool.length <= 60) cands = pool;
      }
    }
    if (!cands.length) return { names, num, results: [] };

    // Visual ranking when more than one printing is left
    if (cands.length > 1) {
      const MAX = 100;
      cands.sort((a, b) => b.nameScore - a.nameScore);
      const limited = cands.filter(c => c.hasImg).slice(0, MAX);
      onStep(`Comparing the artwork with ${limited.length} printings…`);
      const photoSigs = signatureVariants(canvas);
      await mapLimit(limited, 8, async c => {
        try {
          const url = cardImageUrl(c.id, 'low');
          const sig = this.sigCache.get(c.id) || signature(await loadImage(url).catch(() => new Promise(r => setTimeout(r, 700)).then(() => loadImage(url))));
          this.sigCache.set(c.id, sig);
          c.visual = Math.max(...photoSigs.map(p => visualSimilarity(p, sig)));
        } catch (e) { c.visual = 0; }
      });
      const noImg = cands.filter(c => !c.hasImg).map(c => ({ ...c, visual: 0 }));
      cands = [...limited, ...noImg];
      cands.sort((a, b) => (b.visual + b.nameScore * 0.1) - (a.visual + a.nameScore * 0.1));
    }

    onStep('Loading card details…');
    const top = cands.slice(0, 12);
    const full = (await Promise.all(top.map(c => CardDB.getCard(c.id).catch(() => null)))).filter(Boolean);
    if (!full.length) throw new Error('Found the card but the card database is busy — try again in a few seconds.');
    await CardDB.backfill(full);
    const order = new Map(top.map((c, i) => [c.id, i]));
    full.sort((a, b) => order.get(a.id) - order.get(b.id));
    // "Best match" only when the evidence is strong: a clear artwork winner, or a single
    // printing backed by a well-read name or a number that matched with its set total.
    const solidName = (names[0]?.score || 0) >= 0.75;
    const numHit = num && top.length === 1 && sameNumber(top[0].localId, num.number);
    const confident = top.length === 1 ? (solidName || numHit) && full.length === 1
      : (top[0].visual != null && top[1] && top[0].visual - top[1].visual > 0.06 && top[0].visual > 0.45);
    return { names, num, results: full, confident, visual: top.map(c => c.visual) };
  },
  sigCache: new Map(),
};

// Find the card inside a photo (card on a table, or a loose camera crop) and crop to it.
function autoCropCard(src) {
  const W = 240, H = Math.round(W * src.height / src.width);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  // Background colour = median of the outer ring
  const ring = [];
  const m = Math.max(2, Math.round(W * 0.02));
  for (let x = 0; x < W; x += 2) for (const y of [0, 1, H - 2, H - 1]) ring.push(px(x, y));
  for (let y = 0; y < H; y += 2) for (const x of [0, 1, W - 2, W - 1]) ring.push(px(x, y));
  const med = k => ring.map(p => p[k]).sort((a, b) => a - b)[ring.length >> 1];
  const bg = [med(0), med(1), med(2)];
  // A busy background means the card can't be separated reliably; keep the photo as is.
  const spread = ring.reduce((a, p) => a + Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]), 0) / ring.length;
  if (spread > 45) return src;
  const isCard = (x, y) => { const p = px(x, y); return Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) > 55; };
  const rowHit = y => { let n = 0; for (let x = 0; x < W; x++) if (isCard(x, y)) n++; return n / W; };
  const colHit = x => { let n = 0; for (let y = 0; y < H; y++) if (isCard(x, y)) n++; return n / H; };
  let top = 0, bot = H - 1, left = 0, right = W - 1;
  while (top < H / 3 && rowHit(top) < 0.45) top++;
  while (bot > H * 2 / 3 && rowHit(bot) < 0.45) bot--;
  while (left < W / 3 && colHit(left) < 0.45) left++;
  while (right > W * 2 / 3 && colHit(right) < 0.45) right--;
  const bw = right - left, bh = bot - top;
  if (bw < W * 0.4 || bh < H * 0.4) return src;
  const ratio = bh / bw; // a card is ~1.4 tall
  if (ratio < 1.15 || ratio > 1.7) return src;
  if (left <= m && top <= m && right >= W - 1 - m && bot >= H - 1 - m) return src; // already tight
  const s = src.width / W;
  const out = document.createElement('canvas');
  out.width = Math.round((bw + 1) * s); out.height = Math.round((bh + 1) * s);
  out.getContext('2d').drawImage(src, left * s, top * s, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
function closeTotal(a, b) {
  if (a == null || b == null) return false;
  if (a === b) return true;
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
  return diff === 1;
}
// Photo signatures at small shifts/zooms, so a slightly-off crop still lines up.
function signatureVariants(canvas) {
  const out = [];
  for (const z of [0, 0.03]) for (const dx of [-0.015, 0, 0.015]) for (const dy of [-0.015, 0, 0.015]) {
    if (z && (dx || dy)) continue;
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const w = canvas.width * (1 - 2 * z), h = canvas.height * (1 - 2 * z);
    c.getContext('2d').drawImage(canvas, canvas.width * (z + dx), canvas.height * (z + dy), w, h, 0, 0, c.width, c.height);
    out.push(signature(c));
  }
  return out;
}

// ---------- Helpers ----------
function normName(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").replace(/[^a-z0-9' &.-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function trigrams(s) {
  const t = ` ${s.replace(/[^a-z0-9]/g, '')} `;
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}
function bigramDice(a, b) {
  a = a.replace(/[^a-z0-9]/g, ''); b = b.replace(/[^a-z0-9]/g, '');
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const m = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2); const k = m.get(g); if (k) { hit++; m.set(g, k - 1); } }
  return (2 * hit) / (a.length + b.length - 2);
}

// Match OCR words (with their sizes) to real card names.
function matchNames(words, idx) {
  if (!words.length) return [];
  // Drop "Evolves from X" / "Put X on the Stage 1 card" — they name a *different* Pokémon.
  const cleaned = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].t.toLowerCase();
    if (/^evolves?$/.test(w) && /^from$/i.test(words[i + 1]?.t || '')) { i += 2; continue; }
    if (/^put$/.test(w)) { i += 2; continue; }
    cleaned.push(words[i]);
  }
  const maxH = Math.max(...cleaned.map(w => w.h), 1);
  // Candidate windows of 1-4 consecutive words
  const windows = [];
  for (let i = 0; i < cleaned.length; i++) {
    for (let n = 1; n <= 4 && i + n <= cleaned.length; n++) {
      const ws = cleaned.slice(i, i + n);
      const text = normName(ws.map(w => w.t).join(' '));
      if (text.replace(/[^a-z]/g, '').length < 3) continue;
      const h = ws.reduce((a, w) => a + w.h, 0) / n;
      windows.push({ text, size: h / maxH });
    }
  }
  // Shortlist names sharing trigrams with any window
  const counts = new Map();
  for (const win of windows) for (const g of trigrams(win.text)) for (const e of idx.tri.get(g) || []) counts.set(e, (counts.get(e) || 0) + 1);
  const shortlist = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(x => x[0]);
  const scored = shortlist.map(entry => {
    let best = 0;
    for (const win of windows) {
      const d = bigramDice(entry.key, win.text);
      // Prefer big text; tiny text is usually rules or "evolves from" lines.
      const s = d * (0.55 + 0.45 * win.size);
      if (s > best) best = s;
    }
    // Slight preference for longer, more specific names when equally good ("Charizard ex" over "Charizard")
    return { entry, score: best + Math.min(0.03, entry.key.length / 600) };
  }).filter(x => x.score > 0.45).sort((a, b) => b.score - a.score);
  return scored.slice(0, 6);
}
function mergeMatches(a, b) {
  const m = new Map();
  for (const x of [...a, ...b]) if (!m.has(x.entry) || m.get(x.entry).score < x.score) m.set(x.entry, x);
  return [...m.values()].sort((x, y) => y.score - x.score);
}

function parseCollectorNumber(raw) {
  const t = raw.toUpperCase().replace(/[|\]\[]/g, '/').replace(/\s*\/\s*/g, '/');
  // Fix common OCR swaps inside digit runs
  const fix = s => s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S(?=\d)/g, '5');
  // Special subsets: TG05/TG30, GG01/GG70, SV049/SV094, RC12/RC32, H5/H32
  let m = t.match(/\b(TG|GG|SV|RC|H|SH)\s?(\d{1,3})\/(?:TG|GG|SV|RC|H|SH)?\s?(\d{1,3})\b/);
  if (m) return { number: m[1] + m[2], total: null, text: m[0] };
  // Promos: SWSH050, SM60, XY120, BW50, DP40, SVP 045
  m = t.match(/\b(SWSH|SVP|SM|XY|BW|DP|HGSS)\s?(\d{1,3})\b/);
  if (m) return { number: m[1] + m[2], total: null, text: m[0], promo: m[1] };
  const all = [...t.matchAll(/([0-9OIL]{1,3})\/([0-9OIL]{2,3})/g)]
    .map(x => ({ n: parseInt(fix(x[1]), 10), tot: parseInt(fix(x[2]), 10), text: x[0] }))
    .filter(x => x.n > 0 && x.tot >= 10 && x.n <= x.tot + 150);
  if (all.length) return { number: String(all[0].n), total: all[0].tot, text: all[0].text };
  return null;
}
function sameNumber(localId, number) {
  if (/^\d+$/.test(number)) return parseInt(localId, 10) === parseInt(number, 10) && /^\d+$/.test(localId);
  const a = localId.toUpperCase().replace(/^([A-Z]+)0*/, '$1'), b = number.toUpperCase().replace(/^([A-Z]+)0*/, '$1');
  return a === b;
}
function setTotalOf(cardId) {
  const setId = cardId.slice(0, cardId.lastIndexOf('-'));
  return CardDB.sets?.find(s => s.id === setId)?.cardCount?.official ?? null;
}
function cardImageUrl(id, size) {
  const cut = id.lastIndexOf('-');
  const path = Scanner.setPaths?.[id.slice(0, cut)];
  return path ? `https://assets.tcgdex.net/en/${path}/${id.slice(cut + 1)}/${size}.webp` : null;
}

// Crop + upscale + optional black/white or inverted processing for OCR.
function prepCrop(src, x, y, w, h, scale, mode = 'plain') {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * w * scale));
  c.height = Math.max(1, Math.round(src.height * h * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = mode === 'invert' ? 'grayscale(1) invert(1) contrast(1.5)' : 'grayscale(1) contrast(1.4)';
  ctx.drawImage(src, src.width * x, src.height * y, src.width * w, src.height * h, 0, 0, c.width, c.height);
  if (mode === 'bw') {
    // Otsu threshold -> pure black text on white
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
    const total = d.length / 4;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; thr = i; }
    }
    for (let i = 0; i < d.length; i += 4) { const v = d[i] > thr ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

// Visual fingerprint: gradient hash of the upper card (art + name) + coarse colour layout.
function signature(src) {
  const W = 17, H = 16;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const crop = [sw * 0.06, sh * 0.08, sw * 0.88, sh * 0.5]; // artwork window
  ctx.drawImage(src, crop[0], crop[1], crop[2], crop[3], 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const gray = [];
  for (let i = 0; i < d.length; i += 4) gray.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  const bits = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) bits.push(gray[y * W + x] > gray[y * W + x + 1] ? 1 : 0);
  // Colour layout 6x6 over the whole card (frame colours differ a lot between eras)
  const C = 6;
  c.width = C; c.height = C;
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, C, C);
  const cd = ctx.getImageData(0, 0, C, C).data;
  const col = [];
  for (let i = 0; i < cd.length; i += 4) col.push(cd[i], cd[i + 1], cd[i + 2]);
  // Normalise colour for lighting: subtract mean, divide by spread
  const mean = col.reduce((a, b) => a + b, 0) / col.length;
  const sd = Math.sqrt(col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length) || 1;
  return { bits, col: col.map(v => (v - mean) / sd) };
}
function visualSimilarity(a, b) {
  let same = 0;
  for (let i = 0; i < a.bits.length; i++) if (a.bits[i] === b.bits[i]) same++;
  const hashSim = same / a.bits.length; // 0.5 = random, 1 = identical
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.col.length; i++) { dot += a.col[i] * b.col[i]; na += a.col[i] ** 2; nb += b.col[i] ** 2; }
  const colSim = (dot / Math.sqrt(na * nb || 1) + 1) / 2; // 0..1
  return 0.6 * ((hashSim - 0.5) * 2) + 0.4 * colSim;
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('no image'));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed'));
    img.src = url;
  });
}
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
