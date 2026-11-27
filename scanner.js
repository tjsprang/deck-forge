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

    // 0) Basic Energy has no name printed — just "ENERGY" and a big type symbol (reading it as
    //    text gave things like "R Energy"). Recognise those by the symbol's colour and shape.
    let cands = [];
    let byNumber = false, energy = null;
    const saysEnergy = words.some(w => bigramDice(normName(w.t).replace(/[^a-z]/g, ''), 'energy') >= 0.72);
    const strongOther = names[0] && names[0].score >= 0.8 && !BASIC_ENERGY_RE.test(names[0].entry.name) && names[0].entry.key !== 'r energy';
    // Without a clear name, check for an Energy symbol: leniently if "ENERGY" was read, otherwise
    // only on a clear colour + symbol match (Pokémon cards score well below that)
    if (!strongOther) {
      energy = await this.identifyEnergy(canvas, { num, minScore: saysEnergy ? 0.4 : 0.58, onProgress: t => step('match', 'active', t) });
      if (energy) cands = energy.cands;
    }

    // 1) A clearly read number WITH its set size ("033/103") is the strongest clue there is:
    //    it narrows ~20,000 cards to a handful. Pick among those by whatever name text was read
    //    and by the artwork — even if the name read on its own was wrong.
    if (!energy && num && num.total) {
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
    const strongNames = byNumber || energy ? [] : names.filter(n => n.score >= Math.max(minScore, (names[0]?.score || 0) - 0.12));
    for (const n of strongNames) addEntry(n.entry, n.score);
    for (const n of strongNames) {
      const re = new RegExp(`(^|[ '])${n.entry.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
      for (const e of idx.byName.values()) if (e !== n.entry && re.test(e.key)) addEntry(e, n.score - 0.1);
    }

    // The set size ("/197") is often read correctly even when the card number's digits aren't —
    // and printings of the same card in other sets (reprints) have different set sizes.
    if (num?.total && !byNumber && !energy) for (const c of cands) c.totalHit = setTotalOf(c.id) === num.total;

    // Number without a readable set size (or no match above): use it to filter the name's printings
    if (num && !byNumber && !energy) {
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

    // Visual ranking when more than one printing is left (Energy printings are already ranked)
    if (energy) {
      step('name', 'done', `${energy.type} Energy (recognised by its symbol)`);
      step('art', 'done', energy.detail);
    } else if (cands.length > 1) {
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
    if (energy) confident = energy.confident;
    // Report the name that was actually matched (the number path may have overruled the name read)
    const readName = energy ? top[0].name : byNumber ? (top[0].nameScore >= 0.45 ? top[0].name : null) : names[0]?.entry.name;
    // The number decided it: show the card it matched, not the shaky name read
    if (byNumber && confident && names[0]?.entry.name !== full[0].name) step('name', 'done', `${full[0].name} (confirmed by the number)`);
    step('done', confident ? 'done' : 'weak', confident ? `${full[0].name} · ${full[0].setName} ${full[0].localId}` : `${full.length} likely card${full.length === 1 ? '' : 's'} — pick the right one`);
    return { names, num, readName, byNumber, results: full, confident, visual: top.map(c => c.visual), cropped: found.method };
  },
  sigCache: new Map(),

  // ---------- Basic Energy ----------
  // Every basic Energy printing that has a picture is a reference: its colours (hue histogram)
  // and symbol shape. Built once (≈180 small pictures), then kept in storage.
  async energyRefs(onStep) {
    if (this._energyRefs) return this._energyRefs;
    try {
      const c = JSON.parse(localStorage.getItem('df.energyref.v1') || 'null');
      if (c && c.refs?.length > 50) return (this._energyRefs = c.refs.map(unpackEnergyFeat));
    } catch (e) { /* rebuild */ }
    const idx = await this.loadIndex();
    const list = [];
    for (const t of ENERGY_TYPES) for (const name of [`${t} energy`, `basic ${t} energy`]) {
      for (const c of idx.byName.get(name)?.cards || []) if (c.hasImg) list.push({ id: c.id, type: t[0].toUpperCase() + t.slice(1) });
    }
    onStep?.('Learning what Energy cards look like (first time only)…');
    const refs = [];
    await mapLimit(list, 8, async r => {
      const url = cardImageUrl(r.id, 'low');
      try {
        const img = await loadImage(url).catch(() => new Promise(res => setTimeout(res, 700)).then(() => loadImage(url)));
        refs.push({ ...r, ...energyFeatures(img) });
      } catch (e) { /* skip */ }
    });
    if (refs.length > 50) try { localStorage.setItem('df.energyref.v1', JSON.stringify({ at: Date.now(), refs: refs.map(packEnergyFeat) })); } catch (e) { /* memory only */ }
    return (this._energyRefs = refs);
  },

  // Which basic Energy is this? Returns ranked printings, or null if it doesn't look like one.
  async identifyEnergy(canvas, { num, minScore, onProgress }) {
    const refs = await this.energyRefs(onProgress);
    if (!refs.length) return null;
    const f = energyFeatures(canvas);
    const byId = new Map(), byType = new Map();
    for (const r of refs) {
      const v = energySimilarity(f, r);
      byId.set(r.id, v);
      if (!byType.has(r.type) || v > byType.get(r.type)) byType.set(r.type, v);
    }
    const types = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    if (!types.length || types[0][1] < minScore) return null;
    // A close second type is offered too (dim photos can blur Fire/Fighting, Metal/Darkness)
    const use = types.filter(([, v], i) => i === 0 || (i === 1 && v >= types[0][1] - 0.03));
    const idx = this.index;
    const cands = [];
    for (const [type] of use) {
      // Printings without a picture (the newest Energy sets) look like the Crown Zenith art
      const artId = (ENERGY_ART[type] || '').replace(/^.*\/([^/]+)\/([^/]+)$/, '$1-$2');
      const artV = byId.get(artId) ?? byType.get(type) - 0.03;
      for (const name of [`${type} Energy`, `Basic ${type} Energy`]) {
        for (const c of idx.byName.get(normName(name))?.cards || []) {
          const set = c.id.slice(0, c.id.lastIndexOf('-'));
          let v = byId.get(c.id);
          // Newest sets first among look-alikes; trainer-kit printings last
          if (v == null) v = artV + (set === 'mee' ? 0.004 : set === 'sve' ? 0.003 : /^tk-/.test(set) ? -0.05 : -0.02);
          if (num && sameNumber(c.localId, num.number) && (!num.total || setTotalOf(c.id) === num.total)) v += 0.1;
          cands.push({ ...c, name: idx.byName.get(normName(name)).name, nameScore: 0, visual: v });
        }
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.visual - a.visual);
    const typeLead = types[1] ? types[0][1] - types[1][1] : 1;
    const confident = !!cands[0].hasImg && typeLead >= 0.05 && (!cands[1] || cands[0].visual - cands[1].visual > 0.04);
    return {
      type: types[0][0], cands, confident,
      detail: use.length > 1 ? `Looks like ${use[0][0]} or ${use[1][0]} Energy` : `${types[0][0]} Energy symbol`,
    };
  },
};

const ENERGY_TYPES = ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal', 'fairy'];
const BASIC_ENERGY_RE = /^(Basic )?(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy$/;

// Energy fingerprint: colours of the middle of the card (hue histogram, light/dark halves) and
// the shape of the big symbol in the centre. Tested on every basic Energy printing with simulated
// photo lighting: ~85% right with the card's own picture left out, so other eras' designs count.
function energyFeatures(src) {
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const c = document.createElement('canvas');
  const x = c.getContext('2d', { willReadFrequently: true });
  // Colours
  c.width = 40; c.height = 56;
  x.drawImage(src, sw * 0.12, sh * 0.12, sw * 0.76, sh * 0.76, 0, 0, 40, 56);
  let d = x.getImageData(0, 0, 40, 56).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0;
    if (mx !== mn) h = mx === r ? 60 * (((g - b) / (mx - mn)) % 6) : mx === g ? 60 * ((b - r) / (mx - mn) + 2) : 60 * ((r - g) / (mx - mn) + 4);
    px.push([(h + 360) % 360, (mx + mn) / 2, mx - mn]);
  }
  const med = px.map(p => p[1]).sort((a, b) => a - b)[px.length >> 1];
  const hist = new Array(50).fill(0);
  for (const p of px) {
    const light = p[1] > med ? 1 : 0;
    hist[p[2] > 0.18 ? Math.floor(p[0] / 15) % 24 * 2 + light : 48 + light] += 1 / px.length;
  }
  // Symbol shape (gradient directions in the centre)
  c.width = 16; c.height = 16;
  x.drawImage(src, sw * 0.2, sh * 0.28, sw * 0.6, sh * 0.43, 0, 0, 16, 16);
  d = x.getImageData(0, 0, 16, 16).data;
  const gr = [];
  for (let i = 0; i < d.length; i += 4) gr.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  const sym = [];
  for (let y = 0; y < 16; y++) for (let k = 0; k < 15; k++) sym.push(gr[y * 16 + k] > gr[y * 16 + k + 1] ? 1 : 0);
  for (let y = 0; y < 15; y++) for (let k = 0; k < 16; k++) sym.push(gr[y * 16 + k] > gr[(y + 1) * 16 + k] ? 1 : 0);
  return { hist, sym, sig: signature(src) };
}
function energySimilarity(a, b) {
  let h = 0;
  for (let i = 0; i < 24; i++) for (const l of [0, 1]) {
    const k = i * 2 + l, kn = (i + 1) % 24 * 2 + l, kp = (i + 23) % 24 * 2 + l;
    h += Math.min(a.hist[k], b.hist[k] + 0.5 * (b.hist[kn] + b.hist[kp]));
  }
  h += Math.min(a.hist[48], b.hist[48]) + Math.min(a.hist[49], b.hist[49]);
  let same = 0;
  for (let i = 0; i < a.sym.length; i++) if (a.sym[i] === b.sym[i]) same++;
  return 0.4 * h + 0.4 * (same / a.sym.length - 0.5) * 2 + 0.2 * visualSimilarity(a.sig, b.sig);
}
const bitsToHex = bits => { let s = ''; for (let i = 0; i < bits.length; i += 4) s += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | (bits[i + 3] | 0)).toString(16); return s; };
const hexToBits = (hex, n) => { const out = []; for (const ch of hex) { const v = parseInt(ch, 16); out.push(v >> 3 & 1, v >> 2 & 1, v >> 1 & 1, v & 1); } return out.slice(0, n); };
function packEnergyFeat(r) {
  return [r.id, r.type, r.hist.map(v => Math.round(v * 1000)), bitsToHex(r.sym), bitsToHex(r.sig.bits), r.sig.col.map(v => Math.round(v * 100))];
}
function unpackEnergyFeat([id, type, hist, sym, bits, col]) {
  return { id, type, hist: hist.map(v => v / 1000), sym: hexToBits(sym, 480), sig: { bits: hexToBits(bits, 256), col: col.map(v => v / 100) } };
}

// Find the card in a photo or camera frame. Tries, in order:
//  1. colour: card stands out from a plain background (table, mat);
//  2. edges: the card's straight borders, for busy backgrounds;
//  3. shape: the frame is already roughly the card (camera guide) — keep it if card-shaped,
//     otherwise take the largest centred card-shaped area (people centre the card).
function locateCard(src) {
  const byColour = autoCropCard(src);
  if (byColour !== src) return { canvas: byColour, method: 'colour' };
  const quad = findCardQuad(src);
  if (quad) return { canvas: cropQuad(src, quad), method: 'edges', quad };
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

// Find the card's outline in a busy picture. A cluttered table has plenty of edges, but only the
// card has four long straight borders that meet in a card-shaped rectangle. So instead of
// counting edges across the whole picture, every candidate rectangle is checked along its own
// four sides: what share of each side is actually an edge line. The search also tries small
// tilts (a hand-held card is rarely perfectly straight).
// Returns { angle, l, t, r, b, k, score } in a rotated, downscaled frame (see cropQuad), or null.
function findCardQuad(src, { angles = [-6, -4, -2, 0, 2, 4, 6], minScore = 1.0, areaW = 0.8, nPeaks = 14, minSide = 0.3 } = {}) {
  const W = 260, H = Math.round(W * src.height / src.width);
  const k = src.width / W;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let best = null;
  for (const angle of angles) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-angle * Math.PI / 180);
    ctx.drawImage(src, -W / 2, -H / 2, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // Edge maps: V = vertical line pixels, Hz = horizontal line pixels (thickened by a pixel
    // across the line so a slightly-off side still counts)
    const V = new Uint8Array(W * H), Hz = new Uint8Array(W * H);
    // Skip the picture's own border (and, when tilted, the edge of the grey fill around it):
    // it is a long straight line too, but never the card's
    const ca = Math.cos(angle * Math.PI / 180), sa = Math.sin(angle * Math.PI / 180), m = 4;
    const inside = (x, y) => {
      const dx = x - W / 2, dy = y - H / 2;
      const ox = W / 2 + dx * ca - dy * sa, oy = H / 2 + dx * sa + dy * ca;
      return ox > m && ox < W - m && oy > m && oy < H - m;
    };
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      if (!inside(x, y)) continue;
      const p = y * W + x;
      const gx = Math.abs(g[p + 1] - g[p - 1]), gy = Math.abs(g[p + W] - g[p - W]);
      if (gx > 18 && gx > gy) V[p] = V[p - 1] = V[p + 1] = 1;
      if (gy > 18 && gy > gx) Hz[p] = Hz[p - W] = Hz[p + W] = 1;
    }
    // Running sums down each column (V) and along each row (Hz) → any side's coverage in O(1)
    const vc = new Uint16Array(W * (H + 1)), hc = new Uint16Array((W + 1) * H);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) vc[(y + 1) * W + x] = vc[y * W + x] + V[y * W + x];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hc[y * (W + 1) + x + 1] = hc[y * (W + 1) + x] + Hz[y * W + x];
    const vCov = (x, y0, y1) => (vc[y1 * W + x] - vc[y0 * W + x]) / Math.max(1, y1 - y0);
    const hCov = (y, x0, x1) => (hc[y * (W + 1) + x1] - hc[y * (W + 1) + x0]) / Math.max(1, x1 - x0);
    // Candidate lines, judged only over the middle of the picture (where the card's sides run
    // when it is roughly centred), so clutter above/below or left/right doesn't drown them
    const colP = new Float32Array(W), rowP = new Float32Array(H);
    const y0 = Math.round(H * 0.3), y1 = Math.round(H * 0.7), x0 = Math.round(W * 0.3), x1 = Math.round(W * 0.7);
    for (let x = 0; x < W; x++) colP[x] = vCov(x, y0, y1);
    for (let y = 0; y < H; y++) rowP[y] = hCov(y, x0, x1);
    const peaks = (a, from, to) => {
      const out = [];
      for (let i = Math.max(1, Math.round(from)); i < Math.min(a.length - 1, Math.round(to)); i++) {
        if (a[i] >= a[i - 1] && a[i] >= a[i + 1] && a[i] > 0.25) out.push({ i, v: a[i] });
      }
      return out.sort((p, q) => q.v - p.v).slice(0, nPeaks);
    };
    const L = peaks(colP, 0, W * 0.42), R = peaks(colP, W * 0.58, W), T = peaks(rowP, 0, H * 0.42), B = peaks(rowP, H * 0.58, H);
    let lb = null;
    for (const l of L) for (const r of R) {
      const w = r.i - l.i;
      if (w < W * 0.4) continue;
      for (const t of T) for (const b of B) {
        const h = b.i - t.i;
        if (h < H * 0.3) continue;
        const ratio = h / w;
        if (ratio < 1.25 || ratio > 1.56) continue;
        // Coverage of each full side (corners trimmed: they are rounded on real cards)
        const ix = Math.round(w * 0.08), iy = Math.round(h * 0.08);
        const sides = [vCov(l.i, t.i + iy, b.i - iy), vCov(r.i, t.i + iy, b.i - iy), hCov(t.i, l.i + ix, r.i - ix), hCov(b.i, l.i + ix, r.i - ix)];
        const weakest = Math.min(...sides);
        if (weakest < minSide) continue;
        const mean = (sides[0] + sides[1] + sides[2] + sides[3]) / 4;
        // Mostly the sides; a bit for card proportions and for being the outer rectangle
        // (the card, not the inner frame or art box)
        const s = mean * 0.7 + weakest * 0.3 - Math.abs(ratio - CARD_RATIO_S) * 0.8 + (w * h) / (W * H) * areaW;
        if (!lb || s > lb.score) lb = { score: s, angle, l: l.i, t: t.i, r: r.i, b: b.i, k, W, H };
      }
    }
    if (!lb) continue;
    // A card's coloured border has an inner line too, often crisper than the outer one against
    // a busy table. If a weaker parallel line runs just outside a side, that is the real edge.
    const w = lb.r - lb.l, h = lb.b - lb.t, ix = Math.round(w * 0.08), iy = Math.round(h * 0.08);
    const reach = Math.round(w * 0.07);
    const outward = (cov, at, dir) => {
      const need = Math.max(0.3, cov(at) * 0.5);
      let edge = at;
      for (let n = 1; n <= reach; n++) if (cov(at + dir * n) >= need) edge = at + dir * n;
      return edge;
    };
    const t0 = lb.t + iy, b0 = lb.b - iy, l0 = lb.l + ix, r0 = lb.r - ix;
    lb.l = outward(x => x > 0 ? vCov(x, t0, b0) : 0, lb.l, -1);
    lb.r = outward(x => x < W - 1 ? vCov(x, t0, b0) : 0, lb.r, 1);
    lb.t = outward(y => y > 0 ? hCov(y, l0, r0) : 0, lb.t, -1);
    lb.b = outward(y => y < H - 1 ? hCov(y, l0, r0) : 0, lb.b, 1);
    if (!best || lb.score > best.score) best = lb;
  }
  return best && best.score >= minScore ? best : null;
}
// Corners of a found card in the original picture's coordinates (for drawing an outline).
function quadCorners(src, q) {
  const a = q.angle * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = q.W / 2, cy = q.H / 2;
  return [[q.l, q.t], [q.r, q.t], [q.r, q.b], [q.l, q.b]].map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [(cx + dx * cos - dy * sin) * q.k, (cy + dx * sin + dy * cos) * q.k];
  });
}
// Cut the found card out of the full-resolution picture, straightened.
function cropQuad(src, q) {
  const k = q.k;
  const out = document.createElement('canvas');
  out.width = Math.round((q.r - q.l) * k); out.height = Math.round((q.b - q.t) * k);
  const x = out.getContext('2d');
  x.translate(-q.l * k, -q.t * k);
  x.translate(src.width / 2, src.height / 2);
  x.rotate(-q.angle * Math.PI / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
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
