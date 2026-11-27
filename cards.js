// Card database access (TCGdex — every Pokémon TCG card ever printed, with live format legality)
// plus local storage for the user's collection.
'use strict';

const API_GQL = 'https://api.tcgdex.net/v2/graphql';
const API_REST = 'https://api.tcgdex.net/v2/en';

const CARD_FIELDS = `id localId name hp stage suffix types evolveFrom category trainerType energyType
  regulationMark rarity effect retreat image
  legal { standard expanded }
  set { id name cardCount { official } }
  attacks { name cost damage effect }
  abilities { name effect type }
  weaknesses { type value }
  variants { normal reverse holo firstEdition wPromo }
  variants_detailed { type subtype size stamp foil }`;

// ---------- Versions (normal / holo / reverse / 1st Edition / shadowless / stamps / patterns…) ----------
// The database lists every version of every card (14,722 cards surveyed): a finish (normal, holo,
// reverse, lenticular), sometimes a print run (shadowless, unlimited, 1999-2000 copyright, error
// prints), a foil pattern (cosmos, Poké Ball, Master Ball, cracked ice…), stamps (1st Edition,
// prerelease set logo, staff, championships…) and a size (standard or jumbo).
const versionKey = v => [v.type || 'normal', v.subtype || '', v.size === 'jumbo' ? 'jumbo' : '', (v.stamp || []).join('+'), v.foil || ''].join('|');
const titleCase = s => s.replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
const FINISH_NAMES = { normal: 'Normal', holo: 'Holo', reverse: 'Reverse Holo', lenticular: 'Lenticular' };
const SUBTYPE_NAMES = {
  shadowless: 'Shadowless', unlimited: 'Unlimited', '1999-2000-copyright': '1999-2000 copyright', '1999-copyright': '1999 copyright',
  'no-e-reader': 'No e-Reader', 'shadowless-red-cheek': 'Shadowless (red cheeks)', 'blue-border': 'Blue border', 'gold-border': 'Gold border',
  'missing-expansion-symbol': 'Missing set symbol (error)', 'japanese-back': 'Japanese back', glossy: 'Glossy',
};
const FOIL_NAMES = {
  cosmos: 'Cosmos holo', pokeball: 'Poké Ball pattern', masterball: 'Master Ball pattern', energy: 'Energy pattern',
  'cracked-ice': 'Cracked Ice holo', league: 'League holo', loveball: 'Love Ball pattern', friendball: 'Friend Ball pattern',
  quickball: 'Quick Ball pattern', duskball: 'Dusk Ball pattern', gold: 'Gold', tinsel: 'Tinsel holo', rainbow: 'Rainbow',
  'team-rocket': 'Team Rocket pattern', galaxy: 'Galaxy holo', mirror: 'Mirror holo', starlight: 'Starlight', 'player-reward': 'Player Rewards holo',
  'professor-program': 'Professor Program holo',
};
const STAMP_NAMES = {
  '1st-edition': '1st Edition', 'set-logo': 'Set logo stamp (prerelease)', staff: 'Staff stamp', 'pre-release': 'Prerelease stamp',
  'player-rewards-program': 'Player Rewards stamp', '30th-anniversary': '30th Anniversary stamp', '25th-celebration': '25th Celebration stamp',
  'pokemon-center': 'Pokémon Center stamp', mcdonalds: "McDonald's", 'w-promo': 'W promo stamp', 'professor-program': 'Professor Program stamp',
};
function versionLabel(v) {
  const parts = [];
  for (const s of v.stamp || []) if (s === '1st-edition') parts.push('1st Edition');
  if (v.subtype) parts.push(SUBTYPE_NAMES[v.subtype] || titleCase(v.subtype));
  parts.push(FINISH_NAMES[v.type] || titleCase(v.type || 'normal'));
  if (v.foil) parts.push(FOIL_NAMES[v.foil] || titleCase(v.foil));
  for (const s of v.stamp || []) if (s !== '1st-edition') parts.push(STAMP_NAMES[s] || titleCase(s) + ' stamp');
  if (v.size === 'jumbo') parts.push('Jumbo');
  return parts.join(' · ');
}
// Versions from the detailed list, or — for cards the database hasn't detailed yet — from the
// simple flags (normal / holo / reverse / 1st Edition).
function buildVersions(detailed, flags) {
  let list = (detailed || []).filter(Boolean).map(v => ({ type: v.type || 'normal', subtype: v.subtype || null, size: v.size || 'standard', stamp: v.stamp || null, foil: v.foil || null }));
  if (!list.length && flags) {
    if (flags.normal) list.push({ type: 'normal' });
    if (flags.holo) list.push({ type: 'holo' });
    if (flags.reverse) list.push({ type: 'reverse' });
    if (flags.firstEdition) list.push({ type: flags.holo ? 'holo' : 'normal', stamp: ['1st-edition'] });
    if (flags.wPromo) list.push({ type: 'normal', stamp: ['w-promo'] });
  }
  const seen = new Set();
  return list.map(v => ({ key: versionKey(v), label: versionLabel(v), type: v.type, subtype: v.subtype, size: v.size || 'standard', stamp: v.stamp, foil: v.foil }))
    .filter(v => !seen.has(v.key) && seen.add(v.key));
}
const versionOf = (card, key) => (card.versions || []).find(v => v.key === key) || null;

// TCG Pocket (mobile game) cards live in the same database; they are not real paper cards.
function isPocketCard(c) {
  return /\/tcgp\//.test(c.image || '') || /^[AB]\d/.test(c.set?.id || '') || /^P-[A-Z]/.test(c.set?.id || '');
}

async function gql(query, variables, attempt = 0) {
  let res;
  try {
    res = await fetch(API_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, 600 * 2 ** attempt)); return gql(query, variables, attempt + 1); }
    throw new Error('Could not reach the card database. Check your internet connection.');
  }
  if (!res.ok) {
    // Busy server / rate limit: back off and retry
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
      return gql(query, variables, attempt + 1);
    }
    throw new Error('Card database error ' + res.status);
  }
  const json = await res.json();
  if (json.errors && !json.data) throw new Error(json.errors[0].message);
  return json.data;
}

// Card text writes Energy as symbols ("discard a Basic {F} Energy"); spell them out so rules
// like "this only works with Fighting Energy" can be read.
const ENERGY_SYMBOLS = { G: 'Grass', R: 'Fire', W: 'Water', L: 'Lightning', P: 'Psychic', F: 'Fighting', D: 'Darkness', M: 'Metal', Y: 'Fairy', N: 'Dragon', C: 'Colorless' };
const expandSymbols = s => (s || '').replace(/\{([GRWLPFDMYNC])\}/g, (_, k) => ENERGY_SYMBOLS[k]);
function expandCardText(card) {
  card.effect = expandSymbols(card.effect);
  for (const a of card.attacks || []) a.effect = expandSymbols(a.effect);
  for (const a of card.abilities || []) a.effect = expandSymbols(a.effect);
  return card;
}

// Normalise a TCGdex card into the shape the app and engine use.
function normalizeCard(c) {
  return expandCardText({
    id: c.id,
    localId: c.localId,
    name: c.name,
    category: c.category,               // Pokemon | Trainer | Energy
    hp: c.hp || 0,
    stage: c.stage || null,             // Basic | Stage1 | Stage2 | VMAX | VSTAR | ...
    suffix: c.suffix || null,           // ex | EX | V | GX | ...
    types: c.types || [],
    evolveFrom: c.evolveFrom || null,
    trainerType: c.trainerType || null, // Supporter | Item | Stadium | Tool
    energyType: c.energyType || null,   // Normal | Special
    regulationMark: c.regulationMark || null,
    rarity: c.rarity || '',
    effect: c.effect || '',
    retreat: c.retreat ?? 0,
    image: c.image || null,
    legal: { standard: !!c.legal?.standard, expanded: !!c.legal?.expanded },
    setId: c.set?.id || '',
    setName: c.set?.name || '',
    setTotal: c.set?.cardCount?.official || 0,
    // (some database entries contain empty slots in these lists — skip them)
    attacks: (c.attacks || []).filter(Boolean).map(a => ({ name: a.name || '', cost: (a.cost || []).filter(Boolean), damage: a.damage == null ? '' : String(a.damage), effect: a.effect || '' })),
    abilities: (c.abilities || []).filter(Boolean).map(a => ({ name: a.name || '', effect: a.effect || '', type: a.type })),
    weaknesses: (c.weaknesses || []).filter(Boolean),
    versions: buildVersions(c.variants_detailed, c.variants),
  });
}

// Basic Energy art (Crown Zenith printings; Fairy from Sun & Moon). The newest basic Energy
// printings in the database have no scans, and Energy art is the same card in every format.
const ENERGY_ART = {
  Grass: 'swsh/swsh12.5/152', Fire: 'swsh/swsh12.5/153', Water: 'swsh/swsh12.5/154', Lightning: 'swsh/swsh12.5/155',
  Psychic: 'swsh/swsh12.5/156', Fighting: 'swsh/swsh12.5/157', Darkness: 'swsh/swsh12.5/158', Metal: 'swsh/swsh12.5/159',
  Fairy: 'sm/sm1/172',
};

function cardImage(card, size = 'low') {
  if (card.image) return `${card.image}/${size}.webp`;
  if (card.category === 'Energy') {
    const m = card.name.match(/^(?:Basic )?(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy$/);
    const type = m ? m[1] : (!card.effect && card.types?.[0]);
    if (type && ENERGY_ART[type]) return `https://assets.tcgdex.net/en/${ENERGY_ART[type]}/${size}.webp`;
  }
  return null;
}

const CardDB = {
  sets: null,

  loadSets() {
    if (!this._setsP) this._setsP = this._loadSets().catch(e => { this._setsP = null; throw e; });
    return this._setsP;
  },
  async _loadSets() {
    if (this.sets) return this.sets;
    try {
      const cached = JSON.parse(localStorage.getItem('df.sets.v2') || 'null');
      if (cached && Date.now() - cached.at < 7 * 864e5) { this.sets = cached.sets; return this.sets; }
    } catch (e) { /* ignore */ }
    const data = await gql('{ sets { id name tcgOnline releaseDate cardCount { official } } }');
    this.sets = data.sets.filter(s => !/^[AB]\d|^P-[A-Z]/.test(s.id));
    // Newer sets keep their printed code (OBF, PAL, ...) only on the per-set endpoint.
    const recent = this.sets.filter(s => !s.tcgOnline && (s.releaseDate || '') >= '2019-01-01');
    for (let i = 0; i < recent.length; i += 8) {
      await Promise.all(recent.slice(i, i + 8).map(async s => {
        try {
          const r = await fetch(`${API_REST}/sets/${encodeURIComponent(s.id)}`);
          if (r.ok) { const d = await r.json(); if (d.abbreviation?.official) s.tcgOnline = d.abbreviation.official; }
        } catch (e) { /* keep id as code */ }
      }));
    }
    try { localStorage.setItem('df.sets.v2', JSON.stringify({ at: Date.now(), sets: this.sets })); } catch (e) { /* ignore */ }
    return this.sets;
  },

  setCode(setId) {
    const s = (this.sets || []).find(x => x.id === setId);
    return (s && s.tcgOnline) || setId.toUpperCase();
  },

  // Find a set from free text: PTCGL code ("OBF"), TCGdex id ("sv03") or part of the name.
  findSet(text) {
    const t = text.trim().toLowerCase();
    if (!t || !this.sets) return [];
    const exact = this.sets.filter(s => s.id.toLowerCase() === t || (s.tcgOnline || '').toLowerCase() === t);
    if (exact.length) return exact;
    return this.sets.filter(s => s.name.toLowerCase().includes(t));
  },

  async searchByName(name, { standardOnly = false, count = 250, exact = false } = {}) {
    const data = await gql(`query($n: String!, $c: Float) { cards(filters: { name: $n }, pagination: { page: 1, count: $c }) { ${CARD_FIELDS} } }`,
      { n: exact ? 'eq:' + name : name, c: count });
    let cards = (data.cards || []).filter(c => c && !isPocketCard(c)).map(normalizeCard);
    borrowText(cards, cards);
    if (standardOnly) cards = cards.filter(c => c.legal.standard);
    await this.backfill(cards);
    return sortNewestFirst(cards, this.sets);
  },

  // Some new printings in the database have no rules text yet. Copy it from another printing
  // of the same card so the deck engine can still understand what the card does.
  textCache: {},
  async backfill(cards) {
    const missing = [...new Set(cards.filter(c => lacksText(c) || !c.image).map(c => c.name))];
    for (const name of missing) {
      if (!this.textCache[name]) {
        try {
          const data = await gql(`query($n: String!) { cards(filters: { name: $n }, pagination: { page: 1, count: 100 }) { ${CARD_FIELDS} } }`, { n: 'eq:' + name });
          this.textCache[name] = (data.cards || []).filter(c => c && !isPocketCard(c)).map(normalizeCard).filter(c => !lacksText(c) || c.image);
        } catch (e) { this.textCache[name] = []; }
      }
      borrowText(cards.filter(c => c.name === name), this.textCache[name]);
    }
    return cards;
  },

  // Look up by collector number (e.g. 125) and optional set total (e.g. 197) and/or name.
  async searchByNumber(num, { total = null, name = '', setId = '' } = {}) {
    const raw = String(parseInt(num, 10));
    const variants = [...new Set([raw, raw.padStart(3, '0'), String(num)])];
    const results = [];
    if (total && !setId && this.sets) {
      // "125/197": try every set whose printed total is 197, directly by id
      const t = parseInt(total, 10);
      const sets = this.sets.filter(s => s.cardCount?.official === t);
      const found = [];
      await Promise.all(sets.map(async s => {
        for (const v of variants) {
          try { const c = await this.getCard(`${s.id}-${v}`); if (c && parseInt(c.localId, 10) === parseInt(num, 10)) { found.push(c); break; } } catch (e) { /* next */ }
        }
      }));
      const named = name ? found.filter(c => c.name.toLowerCase().includes(name.toLowerCase())) : found;
      if (named.length) { await this.backfill(named); return sortNewestFirst(named, this.sets); }
    }
    if (setId) {
      // Known set: look the card up directly by its id (e.g. sv03-125)
      for (const v of variants) {
        try { const c = await this.getCard(`${setId}-${v}`); if (c && (parseInt(c.localId, 10) === parseInt(num, 10) || c.localId === String(num)) && !results.find(r => r.id === c.id)) results.push(c); } catch (e) { /* next */ }
      }
      await this.backfill(results);
      return results;
    }
    for (const v of variants) {
      const filters = name ? `{ localId: "${v}", name: ${JSON.stringify(name)} }` : `{ localId: "${v}" }`;
      try {
        const data = await gql(`{ cards(filters: ${filters}, pagination: { page: 1, count: 1000 }) { ${CARD_FIELDS} } }`);
        for (const c of data.cards || []) if (c && !isPocketCard(c) && !results.find(r => r.id === c.id)) results.push(normalizeCard(c));
      } catch (e) { /* try next variant */ }
    }
    let out = results;
    if (setId) out = out.filter(c => c.setId === setId);
    await this.backfill(out);
    if (total) {
      const t = parseInt(total, 10);
      const byTotal = out.filter(c => c.setTotal === t);
      if (byTotal.length) out = byTotal;
    }
    return sortNewestFirst(out, this.sets);
  },

  async getCard(id) {
    const data = await gql(`query($id: ID!) { card(id: $id) { ${CARD_FIELDS} } }`, { id });
    return data.card ? normalizeCard(data.card) : null;
  },
};

function lacksText(c) {
  if (c.category === 'Trainer') return !c.effect;
  if (c.category === 'Pokemon') return !c.attacks.length && !c.abilities.length;
  if (c.category === 'Energy') return c.energyType === 'Special' && !c.effect;
  return false;
}
function borrowText(targets, sources) {
  for (const c of targets) {
    if (!c.image) {
      // No scan for this printing yet: show another printing of the same card instead
      const pic = sources.find(s => s.name === c.name && s.image && s.category === c.category);
      if (pic) { c.image = pic.image; c.imageFrom = pic.id; }
    }
    if (!lacksText(c)) continue;
    const src = sources.find(s => s.name === c.name && s.id !== c.id && !lacksText(s) && s.category === c.category);
    if (!src) continue;
    if (c.category === 'Pokemon') { c.attacks = src.attacks; c.abilities = src.abilities; if (!c.hp) c.hp = src.hp; }
    else c.effect = src.effect;
    c.textFrom = src.id;
  }
}

// ---------- Full card + price lookups (REST: the only endpoint that carries prices) ----------
const Prices = {
  key: 'df.prices.v2', // v2: prices per version
  data: null,
  load() { if (!this.data) { try { this.data = JSON.parse(localStorage.getItem(this.key) || '{}'); } catch (e) { this.data = {}; } } return this.data; },
  save() { try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { /* storage full: keep in memory */ } },
  get(id) { const p = this.load()[id]; return p && Date.now() - p.at < 3 * 864e5 ? p : null; },
  set(id, p) { this.load()[id] = { ...p, at: Date.now() }; },
  // Price of one version of a card (falls back to the card's cheapest common version)
  forVersion(id, key) {
    const p = this.get(id);
    if (!p) return null;
    const v = key && p.versions?.[key];
    return v && (v.usd != null || v.eur != null) ? v : p;
  },
  // Euro → dollar rate (European Central Bank, via Frankfurter), refreshed daily. Many rare
  // versions (shadowless, stamped promos, special foils) only have a Cardmarket price in euros;
  // converting keeps every value and total in one currency.
  eurToUsd: 1.08,
  rateDate: null,
  async loadRate() {
    try {
      const c = JSON.parse(localStorage.getItem('df.fx') || 'null');
      if (c && Date.now() - c.at < 864e5) { this.eurToUsd = c.rate; this.rateDate = c.date; return; }
      const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD');
      const j = await r.json();
      if (j?.rates?.USD) {
        this.eurToUsd = j.rates.USD; this.rateDate = j.date;
        localStorage.setItem('df.fx', JSON.stringify({ at: Date.now(), rate: j.rates.USD, date: j.date }));
      }
    } catch (e) { /* keep the approximate default */ }
  },
  // Best single number (US dollars): TCGplayer market price, else the Cardmarket price converted
  value(p) { return p ? (p.usd ?? (p.eur != null ? p.eur * this.eurToUsd : null)) : null; },
  fmt(p, n = 1) {
    if (!p || (p.usd == null && p.eur == null)) return '—';
    const money = x => '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return p.usd != null ? money(p.usd * n) : '≈' + money(p.eur * this.eurToUsd * n);
  },
  // "€3,096.21" for showing where a converted price came from
  fmtEur(p, n = 1) { return p?.eur != null ? '€' + (p.eur * n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''; },
};
function extractPrice(raw) {
  const tp = raw?.pricing?.tcgplayer, cm = raw?.pricing?.cardmarket;
  const market = ['normal', 'holofoil', 'unlimited', '1st-edition', 'reverse-holofoil']
    .map(k => tp?.[k]?.marketPrice ?? tp?.[k]?.midPrice).filter(v => typeof v === 'number' && v > 0);
  // Each version carries its own price listing; pick the right line for that version
  const versions = {};
  for (const v of raw?.variants_detailed || []) {
    if (!v) continue;
    const vp = versionPrice(v, v.pricing);
    if (vp.usd != null || vp.eur != null) versions[versionKey(v)] = vp;
  }
  return {
    usd: market.length ? Math.min(...market) : null,
    eur: typeof cm?.trend === 'number' && cm.trend > 0 ? cm.trend : typeof cm?.avg === 'number' && cm.avg > 0 ? cm.avg : null,
    versions,
  };
}
// TCGplayer lists several prices per product (normal, holofoil, reverse-holofoil, 1st-edition-holofoil,
// unlimited-holofoil…); Cardmarket gives one price plus a separate "-holo" one for reverse holos.
function versionPrice(v, pricing) {
  const tp = pricing?.tcgplayer, cm = pricing?.cardmarket;
  const first = (v.stamp || []).includes('1st-edition');
  const unl = v.subtype === 'unlimited';
  const prefs = v.type === 'reverse' ? ['reverse-holofoil', 'holofoil']
    : v.type === 'holo' ? (first ? ['1st-edition-holofoil', '1st-edition'] : unl ? ['unlimited-holofoil', 'holofoil'] : ['holofoil', 'unlimited-holofoil'])
    : (first ? ['1st-edition-normal', '1st-edition'] : unl ? ['unlimited-normal', 'unlimited', 'normal'] : ['normal', 'unlimited-normal', 'unlimited']);
  let usd = null;
  for (const k of prefs) {
    const p = tp?.[k]?.marketPrice ?? tp?.[k]?.midPrice;
    if (typeof p === 'number' && p > 0) { usd = p; break; }
  }
  const pick = (...vals) => vals.find(x => typeof x === 'number' && x > 0) ?? null;
  const eur = v.type === 'reverse' ? pick(cm?.['trend-holo'], cm?.['avg-holo'], cm?.trend, cm?.avg) : pick(cm?.trend, cm?.avg);
  return { usd, eur };
}
const fullCardCache = new Map();
async function fetchCardFull(id) {
  if (fullCardCache.has(id)) return fullCardCache.get(id);
  const p = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${API_REST}/cards/${encodeURIComponent(id)}`);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const raw = await r.json();
        const card = normalizeCard(raw);
        Prices.set(card.id, extractPrice(raw));
        // Keep the version list on cards already in the collection up to date
        if (Collection.data.cards[card.id] && card.versions.length) Collection.data.cards[card.id].versions = card.versions;
        return { card, raw };
      } catch (e) { await new Promise(res => setTimeout(res, 700 * (attempt + 1))); }
    }
    return null;
  })();
  fullCardCache.set(id, p);
  return p;
}
// Fetch prices for many cards (cached for 3 days), a few at a time.
async function loadPrices(ids, onProgress = () => {}) {
  const need = [...new Set(ids)].filter(id => !Prices.get(id) && !/^virtual-/.test(id));
  let done = 0;
  await mapLimitC(need, 6, async id => { await fetchCardFull(id); onProgress(++done, need.length); });
  Prices.save();
}
async function mapLimitC(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function sortNewestFirst(cards, sets) {
  const date = {};
  (sets || []).forEach(s => { date[s.id] = s.releaseDate || ''; });
  return cards.sort((a, b) => (date[b.setId] || '').localeCompare(date[a.setId] || ''));
}

// ---------- Collection (persisted in localStorage) ----------
const Collection = {
  key: 'df.collection.v1',
  data: { cards: {}, qty: {} },

  load() {
    try {
      const d = JSON.parse(localStorage.getItem(this.key) || 'null');
      if (d && d.cards && d.qty) {
        this.data = d;
        Object.values(d.cards).forEach(expandCardText); // cards saved before symbols were expanded
      }
    } catch (e) { /* start empty */ }
  },
  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); }
    catch (e) { alert('Could not save your collection (browser storage is full or blocked). Export a backup!'); }
  },
  // Copies are counted per version: key "<card id>~<version key>". A bare "<card id>" key means
  // "version not set" (cards added before versions existed, or when you skip choosing).
  keyOf(id, version) { return version ? `${id}~${version}` : id; },
  parseKey(key) { const i = key.indexOf('~'); return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)]; },
  add(card, n = 1, version = '') {
    const key = this.keyOf(card.id, version);
    if (!this.data.cards[card.id] || (card.versions?.length && !this.data.cards[card.id].versions?.length)) this.data.cards[card.id] = card;
    this.data.qty[key] = Math.max(0, (this.data.qty[key] || 0) + n);
    if (!this.data.qty[key]) delete this.data.qty[key];
    if (!this.count(card.id)) delete this.data.cards[card.id];
    this.save();
  },
  setQty(key, n) {
    if (n <= 0) delete this.data.qty[key];
    else this.data.qty[key] = n;
    const [id] = this.parseKey(key);
    if (!this.count(id)) delete this.data.cards[id];
    this.save();
  },
  // Move copies from one version to another (e.g. setting the version of an older entry)
  moveVersion(card, from, to, n = 1) {
    const fk = this.keyOf(card.id, from);
    const k = Math.min(n, this.data.qty[fk] || 0);
    if (!k) return 0;
    this.data.qty[fk] -= k;
    if (!this.data.qty[fk]) delete this.data.qty[fk];
    const tk = this.keyOf(card.id, to);
    this.data.qty[tk] = (this.data.qty[tk] || 0) + k;
    this.save();
    return k;
  },
  // Total copies of a card, all versions together
  count(id) {
    let n = 0;
    for (const [k, q] of Object.entries(this.data.qty)) if (k === id || k.startsWith(id + '~')) n += q;
    return n;
  },
  countVersion(id, version) { return this.data.qty[this.keyOf(id, version)] || 0; },
  versionsOf(id) {
    return Object.entries(this.data.qty).filter(([k]) => k === id || k.startsWith(id + '~')).map(([k, q]) => ({ key: k, version: this.parseKey(k)[1], qty: q }));
  },
  // One entry per card (all versions combined) — what deck building cares about
  entries() {
    const byId = new Map();
    for (const [k, q] of Object.entries(this.data.qty)) {
      const [id] = this.parseKey(k);
      byId.set(id, (byId.get(id) || 0) + q);
    }
    return [...byId].map(([id, qty]) => ({ card: this.data.cards[id], qty })).filter(e => e.card);
  },
  // One entry per card AND version — what value and the Cards tab care about
  versionEntries() {
    return Object.entries(this.data.qty).map(([key, qty]) => {
      const [id, version] = this.parseKey(key);
      return { key, card: this.data.cards[id], version, qty };
    }).filter(e => e.card);
  },
  totalCards() { return Object.values(this.data.qty).reduce((a, b) => a + b, 0); },
  export() { return JSON.stringify({ app: 'deck-forge', version: 2, exported: new Date().toISOString(), ...this.data }, null, 1); },
  import(json, merge) {
    const d = JSON.parse(json);
    if (!d.cards || !d.qty) throw new Error('Not a Deck Forge collection file');
    if (!merge) this.data = { cards: {}, qty: {} };
    for (const key of Object.keys(d.qty)) {
      const [id] = this.parseKey(key);
      if (!d.cards[id]) continue;
      this.data.cards[id] = expandCardText(d.cards[id]);
      this.data.qty[key] = (merge ? (this.data.qty[key] || 0) : 0) + d.qty[key];
    }
    this.save();
  },
};

// ---------- Saved decks ----------
const SavedDecks = {
  key: 'df.decks.v1',
  list() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (e) { return []; } },
  save(deck) {
    const all = this.list().filter(d => d.id !== deck.id);
    all.unshift(deck);
    try { localStorage.setItem(this.key, JSON.stringify(all)); } catch (e) { alert('Could not save deck.'); }
  },
  remove(id) {
    try { localStorage.setItem(this.key, JSON.stringify(this.list().filter(d => d.id !== id))); } catch (e) { /* ignore */ }
  },
};
