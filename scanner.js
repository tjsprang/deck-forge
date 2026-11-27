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

  // The card name is ALWAYS the big text in the top-left corner, on every era of card (the HP
  // and type are top-right, "Evolves from …" is small text above or beside it). So only that
  // area is read — never the attack text, where words like "Energy" would match the wrong card.
  async readName(canvas, { loose = false } = {}) {
    const { text } = await this.getWorkers();
    const idx = await this.loadIndex();
    let best = [];
    const allWords = []; // what was read here; later used to pick between printings found by number
    // The OCR engine reads text best when letters are ~30–60 px tall, and a name is ~4.5% of the
    // card's height — so scale the crop to put the name at a few target heights instead of
    // whatever size the photo happens to be (huge text reads badly too).
    const nameHeight = canvas.height * 0.045;
    // Name strip (top-left), a looser version, and the full top strip — some layouts (V, VSTAR,
    // VMAX) put a stage tab and portrait left of the name, which can blur together in a tight crop.
    // Still only the top ~15% of the card: never the attack text.
    // Trainer cards (and older layouts) put a big "TRAINER" banner on top and the name on the
    // line below it — on the left (2010s) or the right (2000s, "Root Fossil HP 40") — so there's
    // also a full-width read of that line.
    const region = [[0, 0.015, 0.72, 0.125], [0, 0, 0.78, 0.16], [0, 0, 1, 0.15], [0, 0.05, 1, 0.11]];
    const passes = [
      // [region, target text height px, image variant, page mode]
      [0, 46, 'plain', '6'], [2, 70, 'plain', '3'], [3, 46, 'plain', '6'], [0, 46, 'invert', '6'],
      [2, 70, 'invert', '3'], [3, 36, 'plain', '11'], [0, 34, 'plain', '6'], [2, 90, 'plain', '3'],
      [0, 62, 'plain', '6'], [1, 46, 'plain', '11'], [0, 46, 'bw', '6'], [2, 70, 'bw', '3'], [0, 28, 'plain', '7'],
    ];
    // Card not found exactly in the picture (busy background): it may sit lower in the crop,
    // so also read a taller band — early, since the tight strips may miss the name entirely.
    if (loose) {
      region.push([0, 0.03, 1, 0.27]);
      passes.splice(2, 0, [4, 46, 'plain', '11'], [4, 46, 'invert', '11'], [4, 60, 'plain', '3']);
    }
    for (const [ri, target, variant, psm] of passes) {
      const [x, y, w, h] = region[ri];
      await text.setParameters({ tessedit_pageseg_mode: psm });
      const r = await text.recognize(prepCrop(canvas, x, y, w, h, target / nameHeight, variant));
      const words = (r.data.words || []).map(wd => ({ t: wd.text, h: wd.bbox.y1 - wd.bbox.y0, conf: wd.confidence }))
        .filter(wd => /[A-Za-zÀ-ÿ]{2,}/.test(wd.t));
      allWords.push(...words);
      best = mergeMatches(best, matchNames(words, idx));
      if (best[0] && best[0].score > 0.85) break;
    }
    this.lastWords = allWords;
    return best.slice(0, 4);
  },

  async readNumber(canvas, { loose = false } = {}) {
    const { digits } = await this.getWorkers();
    const scale = 2400 / canvas.width;
    // Tight strips around just the number line read far better than a wide strip that also
    // holds the illustrator credit and flavour text. A few heights cover small framing offsets.
    const crops = [
      [0, 0.895, 0.38, 0.065], [0, 0.88, 0.38, 0.065], [0, 0.91, 0.38, 0.065], // modern: bottom-left
      [0.6, 0.9, 0.4, 0.08], [0.6, 0.875, 0.4, 0.08],                         // older: bottom-right
      [0, 0.88, 0.55, 0.12], [0.45, 0.88, 0.55, 0.12], [0, 0.84, 1, 0.16],   // wider fallbacks
    ];
    // Card not found exactly: its bottom edge may sit higher in the crop
    if (loose) crops.push([0, 0.78, 0.55, 0.14], [0.45, 0.78, 0.55, 0.14], [0, 0.72, 1, 0.2]);
    // A read only counts if its set size is a real set size ("021/103" yes, "621/208" no)
    const totals = new Set((CardDB.sets || []).map(s => s.cardCount?.official).filter(Boolean));
    let fallback = null;
    for (const [x, y, w, h] of crops) {
      for (const variant of ['plain', 'bw']) {
        const r = await digits.recognize(prepCrop(canvas, x, y, w, h, scale, variant));
        const num = parseCollectorNumber(r.data.text);
        if (!num) continue;
        if (!num.total || totals.has(num.total)) return num;
        // The rarity symbol printed right after the number (● common, ◆ uncommon) is often read
        // as an extra digit: "80/92 ●" -> "80/920". If dropping the last digit gives a real set
        // size, that's the true reading.
        const trimmed = Math.floor(num.total / 10);
        if (num.total >= 100 && totals.has(trimmed) && +num.number <= trimmed + 150) {
          return { ...num, total: trimmed, text: `${num.number}/${trimmed}` };
        }
        fallback = fallback || num;
      }
    }
    return fallback;
  },

  // ---------- Main entry ----------
  // onStep(text, { step, state, detail }) reports progress through the stages:
  //   name -> number -> match (possible cards) -> art (artwork check) -> done
  async identify(photo, onStep = () => {}) {
    const step = (key, state, detail, text) => onStep(text || detail || '', { step: key, state, detail });
    onStep('Loading the card list…', { step: 'prep', state: 'active' });
    await Promise.all([this.loadIndex(), CardDB.loadSets()]);
    const found = locateCard(photo);
    const canvas = found.canvas;
    step('name', 'active', 'Reading…', 'Reading the card name…');
    const loose = found.method === 'frame' || found.method === 'centre'; // card position uncertain
    const names = await this.readName(canvas, { loose });
    step('name', names[0] && names[0].score >= 0.6 ? 'done' : 'weak', names[0] && names[0].score >= 0.6 ? names[0].entry.name : 'Not clear — will rely on the number and artwork');
    step('number', 'active', 'Reading…', 'Reading the card number…');
    const num = await this.readNumber(canvas, { loose });
    step('number', num ? 'done' : 'weak', num ? num.text : 'Not readable');
    step('match', 'active', 'Searching…', 'Finding possible cards…');
    const idx = this.index;
    const words = this.lastWords || [];

    // 1) A clearly read number WITH its set size ("033/103") is the strongest clue there is:
    //    it narrows ~20,000 cards to a handful. Pick among those by whatever name text was read
    //    and by the artwork — even if the name read on its own was wrong.
    let cands = [];
    let byNumber = false;
    if (num && num.total) {
      const pool = [];
      for (const e of idx.byName.values()) for (const c of e.cards) {
        if (!sameNumber(c.localId, num.number)) continue;
        const t = setTotalOf(c.id);
        const exact = t === num.total;
        if (exact || closeTotal(t, num.total)) pool.push({ ...c, name: e.name, nameScore: textSupport(e.key, words) + (exact ? 0.15 : 0) });
      }
      if (pool.length && pool.length <= 60) { cands = pool; byNumber = true; }
      // A misread number ("1/129" for 125/197) gives printings the name text doesn't support at
      // all; if a clear name was read, trust the name instead.
      const support = Math.max(0, ...pool.map(c => textSupport(normName(c.name), words)));
      if (byNumber && support < 0.45 && (names[0]?.score || 0) >= 0.7) { cands = []; byNumber = false; }
    }

    // 2) Otherwise use the name: every printing of a well-read name, plus its variants
    //    (Venusaur -> Venusaur EX / Venusaur V / Mega Venusaur ex), because suffix logos
    //    like "EX" or "VSTAR" are stylised and OCR rarely reads them.
    const added = new Set();
    const addEntry = (entry, nameScore) => {
      for (const c of entry.cards) if (!added.has(c.id)) { added.add(c.id); cands.push({ ...c, name: entry.name, nameScore }); }
    };
    // Without a number, only trust a solid name read — a wrong guess is worse than "try again"
    const minScore = num ? 0.6 : 0.68;
    const strongNames = byNumber ? [] : names.filter(n => n.score >= Math.max(minScore, (names[0]?.score || 0) - 0.12));
    for (const n of strongNames) addEntry(n.entry, n.score);
    for (const n of strongNames) {
      const re = new RegExp(`(^|[ '])${n.entry.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
      for (const e of idx.byName.values()) if (e !== n.entry && re.test(e.key)) addEntry(e, n.score - 0.1);
    }

    // The set size ("/197") is often read correctly even when the card number's digits aren't —
    // and printings of the same card in other sets (reprints) have different set sizes.
    if (num?.total && !byNumber) for (const c of cands) c.totalHit = setTotalOf(c.id) === num.total;

    // Number without a readable set size (or no match above): use it to filter the name's printings
    if (num && !byNumber) {
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
    if (!cands.length) {
      step('match', 'fail', 'No matching cards');
      return { names, num, results: [], cropped: found.method };
    }
    const nNames = new Set(cands.map(c => c.name)).size;
    step('match', 'done', `${cands.length} possible printing${cands.length === 1 ? '' : 's'}${nNames > 1 ? ` of ${nNames} cards` : ` of ${cands[0].name}`}${byNumber ? ' (by number)' : ''}`);

    // Visual ranking when more than one printing is left
    if (cands.length > 1) {
      const MAX = 100;
      cands.sort((a, b) => b.nameScore - a.nameScore);
      const limited = cands.filter(c => c.hasImg).slice(0, MAX);
      step('art', 'active', `Comparing with ${limited.length} card picture${limited.length === 1 ? '' : 's'}…`);
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
      // Among number matches the name text is real evidence, so it weighs more
      const w = byNumber ? 0.5 : 0.1;
      const score = c => c.visual + c.nameScore * w + (c.totalHit ? 0.08 : 0); // set size matched
      cands.sort((a, b) => score(b) - score(a));
      const lead = cands[1] ? cands[0].visual - cands[1].visual : 1;
      step('art', 'done', lead > 0.06 ? 'Clear artwork match' : 'Close call between printings');
    } else step('art', 'done', 'Only one possible card');

    onStep('Loading card details…', { step: 'done', state: 'active', detail: 'Loading…' });
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
    let confident = top.length === 1 ? (solidName || numHit) && full.length === 1
      : (top[0].visual != null && top[1] && top[0].visual - top[1].visual > 0.06 && top[0].visual > 0.45);
    // Number + set size matched, and the name text clearly agrees with the top pick
    if (byNumber && top[0].nameScore >= 0.6 && (!top[1] || top[0].nameScore - top[1].nameScore > 0.2)) confident = true;
    // Report the name that was actually matched (the number path may have overruled the name read)
    const readName = byNumber ? (top[0].nameScore >= 0.45 ? top[0].name : null) : names[0]?.entry.name;
    // The number decided it: show the card it matched, not the shaky name read
    if (byNumber && confident && names[0]?.entry.name !== full[0].name) step('name', 'done', `${full[0].name} (confirmed by the number)`);
    step('done', confident ? 'done' : 'weak', confident ? `${full[0].name} · ${full[0].setName} ${full[0].localId}` : `${full.length} likely card${full.length === 1 ? '' : 's'} — pick the right one`);
    return { names, num, readName, byNumber, results: full, confident, visual: top.map(c => c.visual), cropped: found.method };
  },
  sigCache: new Map(),
};

// Find the card in a photo or camera frame. Tries, in order:
//  1. colour: card stands out from a plain background (table, mat);
//  2. edges: the card's straight borders, for busy backgrounds;
//  3. shape: the frame is already roughly the card (camera guide) — keep it if card-shaped,
//     otherwise take the largest centred card-shaped area (people centre the card).
function locateCard(src) {
  const byColour = autoCropCard(src);
  if (byColour !== src) return { canvas: byColour, method: 'colour' };
  const byEdges = edgeCropCard(src);
  if (byEdges) return { canvas: byEdges, method: 'edges' };
  const ratio = src.height / src.width;
  if (ratio > 1.25 && ratio < 1.55) return { canvas: src, method: 'frame' };
  let w = src.width, h = w * CARD_RATIO_S;
  if (h > src.height) { h = src.height; w = h / CARD_RATIO_S; }
  const out = document.createElement('canvas');
  out.width = Math.round(w); out.height = Math.round(h);
  out.getContext('2d').drawImage(src, (src.width - w) / 2, (src.height - h) / 2, w, h, 0, 0, out.width, out.height);
  return { canvas: out, method: 'centre' };
}
const CARD_RATIO_S = 88 / 63;

// Card borders are long straight lines: look for strong vertical/horizontal edge lines whose
// rectangle has a card's proportions and covers a good part of the picture.
function edgeCropCard(src) {
  const W = 300, H = Math.round(W * src.height / src.width);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  // Edge "line" profiles: how much of each column/row is a consistent edge
  const col = new Float32Array(W), row = new Float32Array(H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const gx = Math.abs(g[y * W + x + 1] - g[y * W + x - 1]);
    const gy = Math.abs(g[(y + 1) * W + x] - g[(y - 1) * W + x]);
    if (gx > 24 && gx > gy * 1.5) col[x]++;
    if (gy > 24 && gy > gx * 1.5) row[y]++;
  }
  const smooth = (a, n) => a.map((_, i) => (a[i - 1] || 0) * 0.5 + a[i] + (a[i + 1] || 0) * 0.5);
  const cs = smooth(col).map(v => v / H), rs = smooth(row).map(v => v / W);
  const peaks = (a, from, to) => {
    const out = [];
    // (whole-number positions: a fractional start like 209.5 used to miss every row)
    for (let i = Math.max(1, Math.round(from)); i < Math.min(a.length - 1, Math.round(to)); i++) if (a[i] >= a[i - 1] && a[i] >= a[i + 1] && a[i] > 0.12) out.push({ i, v: a[i] });
    return out.sort((p, q) => q.v - p.v).slice(0, 6);
  };
  const L = peaks(cs, 0, W * 0.5), R = peaks(cs, W * 0.5, W), T = peaks(rs, 0, H * 0.5), B = peaks(rs, H * 0.5, H);
  let best = null;
  for (const l of L) for (const r of R) for (const t of T) for (const b of B) {
    const w = r.i - l.i, h = b.i - t.i;
    if (w < W * 0.35 || h < H * 0.35) continue;
    const ratio = h / w;
    if (ratio < 1.28 || ratio > 1.52) continue;
    // Strong edges, card-like proportions, and prefer the outer rectangle (the card, not its art box)
    const s = l.v + r.v + t.v + b.v - Math.abs(ratio - CARD_RATIO_S) * 2 + (w * h) / (W * H) * 0.6;
    if (!best || s > best.s) best = { s, l: l.i, r: r.i, t: t.i, b: b.i };
  }
  if (!best || best.s < 1.2) return null;
  const k = src.width / W;
  const out = document.createElement('canvas');
  out.width = Math.round((best.r - best.l) * k); out.height = Math.round((best.b - best.t) * k);
  out.getContext('2d').drawImage(src, best.l * k, best.t * k, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// How well the text that was read supports a given card name (0..1), using every word read.
function textSupport(key, words) {
  if (!words.length) return 0;
  const toks = words.map(w => normName(w.t)).filter(t => t.replace(/[^a-z]/g, '').length >= 2);
  let best = 0;
  const n = key.split(' ').length;
  for (let i = 0; i < toks.length; i++) for (let k = 1; k <= Math.min(4, n + 1) && i + k <= toks.length; k++) {
    best = Math.max(best, bigramDice(key, toks.slice(i, i + k).join(' ')));
  }
  return best;
}

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
  // Banner/label words ("TRAINER", "ITEM", "STAGE 1", "HP") are often the biggest text at the
  // top but are never the name — they mustn't make the real name look small by comparison.
  const label = w => /^(trainer|supporter|item|stadium|tool|pok[eé]mon|energy|basic|stage\d?|special|hp\d*|ability|pok[eé]-?(body|power)|ace|spec|technical|machine|rule|goldenrod|[0-9]+)$/i.test(w.t.replace(/[^\wÀ-ÿ-]/g, ''));
  const nameish = cleaned.filter(w => !label(w));
  const maxH = Math.max(...(nameish.length ? nameish : cleaned).map(w => w.h), 1);
  // Candidate windows of 1-4 consecutive words
  const windows = [];
  for (let i = 0; i < cleaned.length; i++) {
    for (let n = 1; n <= 4 && i + n <= cleaned.length; n++) {
      const ws = cleaned.slice(i, i + n);
      if (ws.every(label)) continue; // "TRAINER" alone is not a card name
      const text = normName(ws.map(w => w.t).join(' '));
      if (text.replace(/[^a-z]/g, '').length < 3) continue;
      const h = ws.reduce((a, w) => a + w.h, 0) / n;
      windows.push({ text, size: Math.min(1, h / maxH) });
    }
  }
  // Shortlist names sharing trigrams with any window
  const counts = new Map();
  for (const win of windows) for (const g of trigrams(win.text)) for (const e of idx.tri.get(g) || []) counts.set(e, (counts.get(e) || 0) + 1);
  const shortlist = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(x => x[0]);
  const scored = shortlist.map(entry => {
    let best = 0;
    const keyLetters = entry.key.replace(/[^a-z0-9]/g, '');
    for (const win of windows) {
      let d = bigramDice(entry.key, win.text);
      // Names often get glued to stylised logos ("LfCharizandZD" = Charizard + VSTAR logo):
      // also compare against pieces of a long read the length of the name.
      const flat = win.text.replace(/[^a-z0-9]/g, '');
      if (keyLetters.length >= 5 && flat.length > keyLetters.length + 2) {
        for (let len = keyLetters.length - 1; len <= keyLetters.length + 1; len++) {
          for (let i = 0; i + len <= flat.length; i++) d = Math.max(d, bigramDice(keyLetters, flat.slice(i, i + len)) * 0.97);
        }
      }
      // The name is the biggest text there; small text is "Evolves from …", "STAGE 1", etc.
      const s = d * (0.3 + 0.7 * win.size);
      if (s > best) best = s;
    }
    // Short names ("Bill", "Mary", "Iono") match random OCR noise far too easily: unless the
    // read is near-perfect, count them for much less.
    const letters = entry.key.replace(/[^a-z]/g, '').length;
    if (letters <= 5 && best < 0.92) best *= 0.75;
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
  // A rarity symbol separated by a space ("80/92 0") is not part of the number: keep the
  // gap so the set size stops before it.
  const t = raw.toUpperCase().replace(/[|\]\[]/g, '/').replace(/\s*\/\s*/g, '/').replace(/[●•◆★☆*]/g, ' ');
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
