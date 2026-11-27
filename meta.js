// Tournament ("meta") decks from Limitless — recent online Standard events with public deck lists.
// Used for: "you own X of 60" comparisons, matchup simulation, and upgrade suggestions.
'use strict';

const LIMITLESS = 'https://play.limitlesstcg.com/api';

const Meta = {
  key: 'df.meta.v1',
  data: null,

  async load(onProgress = () => {}, { force = false } = {}) {
    if (!force && this.data) return this.data;
    if (!force) {
      try {
        const c = JSON.parse(localStorage.getItem(this.key) || 'null');
        if (c && Date.now() - c.at < 12 * 3600e3) { this.data = c; return c; }
      } catch (e) { /* refetch */ }
    }
    onProgress('Finding recent tournaments…');
    const list = await getJSON(`${LIMITLESS}/tournaments?game=PTCG&format=STANDARD&limit=80`);
    const events = list.filter(t => t.format === 'STANDARD' && t.players >= 32)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 16);
    const arch = new Map();
    const used = [];
    const real = {}; // "a|b" -> { w, l, t } from a's point of view (actual tournament games)
    let lists = 0;
    for (let k = 0; k < events.length; k++) {
      const ev = events[k];
      onProgress(`Reading deck lists from ${ev.name} (${k + 1}/${events.length})…`);
      let standings;
      try { standings = await getJSON(`${LIMITLESS}/tournaments/${ev.id}/standings`); } catch (e) { continue; }
      const withLists = standings.filter(s => s.decklist && s.deck && s.deck.id && s.deck.id !== 'other');
      if (withLists.length < 16) continue;
      used.push({ name: ev.name, date: ev.date, players: ev.players });
      for (const s of withLists) {
        lists++;
        const a = arch.get(s.deck.id) || { id: s.deck.id, name: s.deck.name, count: 0, wins: 0, losses: 0, ties: 0, best: null };
        a.count++;
        a.wins += s.record?.wins || 0; a.losses += s.record?.losses || 0; a.ties += s.record?.ties || 0;
        // Representative list: best finish relative to event size
        const rank = (s.placing || ev.players) / ev.players;
        if (!a.best || rank < a.best.rank) a.best = { rank, placing: s.placing, event: ev.name, players: ev.players, list: s.decklist, player: s.name };
        arch.set(s.deck.id, a);
      }
      // Real head-to-head results between archetypes
      const deckOf = new Map(standings.filter(s => s.deck?.id && s.deck.id !== 'other').map(s => [s.player, s.deck.id]));
      try {
        const pairings = await getJSON(`${LIMITLESS}/tournaments/${ev.id}/pairings`);
        for (const p of pairings) {
          const a = deckOf.get(p.player1), b = deckOf.get(p.player2);
          if (!a || !b || a === b || !p.winner || p.winner === -1) continue;
          const rec = (x, y, res) => { const k = x + '|' + y; real[k] = real[k] || { w: 0, l: 0, t: 0 }; real[k][res]++; };
          if (p.winner === 0) { rec(a, b, 't'); rec(b, a, 't'); }
          else if (p.winner === p.player1) { rec(a, b, 'w'); rec(b, a, 'l'); }
          else if (p.winner === p.player2) { rec(a, b, 'l'); rec(b, a, 'w'); }
        }
      } catch (e) { /* matchup data is a bonus */ }
      if (used.length >= 12) break;
    }
    if (!lists) throw new Error('No recent tournament deck lists were found.');
    const decks = [...arch.values()].filter(a => a.count >= 4).sort((a, b) => b.count - a.count).slice(0, 12).map(a => ({
      id: a.id, name: a.name, count: a.count, share: a.count / lists,
      winRate: (a.wins + a.ties * 0.5) / Math.max(1, a.wins + a.losses + a.ties),
      sample: { placing: a.best.placing, players: a.best.players, event: a.best.event, player: a.best.player },
      list: flattenList(a.best.list),
    }));
    this.data = { at: Date.now(), lists, tournaments: used, decks, real, calibration: null };
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { /* keep in memory */ }
    return this.data;
  },

  // Turn a Limitless list into deck entries with full card data (and prices).
  resolved: new Map(),
  async resolveDeck(deck, onProgress = () => {}) {
    if (this.resolved.has(deck.id)) return this.resolved.get(deck.id);
    await CardDB.loadSets();
    const entries = [];
    let done = 0;
    await mapLimitC(deck.list, 6, async item => {
      const card = await resolveLimitlessCard(item);
      if (card) entries.push({ card, count: item.count });
      onProgress(++done, deck.list.length);
    });
    Prices.save();
    const out = assignRoles(entries, deck.name);
    this.resolved.set(deck.id, out);
    return out;
  },
};

async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
      if (r.status === 404) throw new Error('not found');
    } catch (e) { if (attempt === 2) throw e; }
    await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
  }
  throw new Error('Request failed: ' + url);
}

function flattenList(dl) {
  const out = [];
  for (const [cat, key] of [['Pokemon', 'pokemon'], ['Trainer', 'trainer'], ['Energy', 'energy']]) {
    for (const c of dl[key] || []) out.push({ name: c.name, set: c.set, number: c.number, count: c.count, category: cat });
  }
  return out;
}

// Limitless gives "Dreepy TWM 128"; find that printing in TCGdex (cached by set+number).
const LT_MAP_KEY = 'df.ltmap.v1';
let ltMap = null;
function ltMapGet() { if (!ltMap) { try { ltMap = JSON.parse(localStorage.getItem(LT_MAP_KEY) || '{}'); } catch (e) { ltMap = {}; } } return ltMap; }
function ltMapSave() { try { localStorage.setItem(LT_MAP_KEY, JSON.stringify(ltMap)); } catch (e) { /* ignore */ } }

async function resolveLimitlessCard(item) {
  // Basic Energy: printings are interchangeable, use the built-in card
  const be = item.name.match(/^(?:Basic )?(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal) Energy$/);
  if (item.category === 'Energy' && be) return virtualBasicEnergy(be[1]);
  const key = `${item.set}-${item.number}`;
  const map = ltMapGet();
  if (map[key]) { const r = await fetchCardFull(map[key]); if (r) return r.card; }
  const sameName = c => normName(c.name) === normName(item.name);
  const n = parseInt(item.number, 10);
  for (const s of (CardDB.sets || []).filter(s => (s.tcgOnline || '').toUpperCase() === item.set.toUpperCase())) {
    for (const v of [String(n).padStart(3, '0'), String(n), item.number]) {
      const r = await fetchCardFull(`${s.id}-${v}`);
      if (r && sameName(r.card) && (parseInt(r.card.localId, 10) === n || r.card.localId === item.number)) {
        map[key] = r.card.id; ltMapSave(); return r.card;
      }
    }
  }
  // Fallback: newest Standard-legal printing with that name
  try {
    const cands = await CardDB.searchByName(item.name, { exact: true });
    const pick = cands.find(c => c.legal.standard) || cands[0];
    if (pick) {
      const r = await fetchCardFull(pick.id);
      map[key] = pick.id; ltMapSave();
      return r ? r.card : pick;
    }
  } catch (e) { /* give up on this card */ }
  return null;
}

// Give a tournament list the same roles the builder uses: main attacker line, partner, rest.
// The archetype name ("Talonflame Dusknoir", "Mega Rayquaza") names the real attackers, so those
// are preferred over support Pokémon that merely have a big attack printed.
function assignRoles(entries, archetypeName = '') {
  const byName = new Map(entries.map(e => [e.card.name, e]));
  const tops = entries.filter(e => isPokemon(e.card) && (e.card.attacks || []).length && !entries.some(x => x.card.evolveFrom === e.card.name));
  const lineOf = e => { const l = [e]; let c = e.card; while (c.evolveFrom && byName.has(c.evolveFrom)) { const p = byName.get(c.evolveFrom); l.unshift(p); c = p.card; } return l; };
  // Species words only ("N's Zoroark" -> zoroark; trainer names like "N's" would match every N's Pokémon)
  const words = archetypeName.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !/'s$/.test(w) && !['mega', 'box', 'basic', 'lead', 'festival', 'ex', 'team', 'rocket'].includes(w));
  const named = e => words.some(w => e.card.name.toLowerCase().split(/[\s-]+/).includes(w));
  const scored = tops.map(e => ({ e, s: attackerScore(e.card) * Math.min(1, (e.count + 1) / 3) * (named(e) ? 3 : 1) })).sort((a, b) => b.s - a.s);
  if (!scored.length) return { entries, core: null };
  const core = scored[0].e;
  for (const x of lineOf(core)) x.role = 'core';
  const partner = scored.slice(1).find(x => !lineOf(x.e).some(y => y.role === 'core'));
  if (partner) for (const x of lineOf(partner.e)) if (!x.role) x.role = 'partner';
  for (const e of entries) if (!e.role) e.role = isEnergy(e.card) ? 'energy' : 'other';
  return { entries, core: core.card.name };
}

// Load tournament decks, their full card data, play-test profiles and the matchup calibration.
async function prepareMeta(onProgress = () => {}, n = 10) {
  const m = await Meta.load(onProgress);
  const top = m.decks.slice(0, n);
  for (let i = 0; i < top.length; i++) {
    onProgress(`Loading cards for ${top[i].name} (${i + 1}/${top.length})…`);
    await Meta.resolveDeck(top[i]);
  }
  if (!Meta.profiles || Meta.profiles.length !== top.length) {
    onProgress('Play-testing tournament decks…');
    await new Promise(r => setTimeout(r, 0));
    Meta.profiles = top.map(d => { const r = Meta.resolved.get(d.id); return { id: d.id, name: d.name, share: d.share, profile: r.core ? deckProfile(r.entries, r.core) : null }; });
  }
  if (!m.calibration) {
    onProgress('Checking the simulator against real tournament results…');
    await new Promise(r => setTimeout(r, 0));
    m.calibration = calibrateMatchups(Meta.profiles);
    try { localStorage.setItem(Meta.key, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }
  return { meta: m, profiles: Meta.profiles, k: m.calibration.k, calibration: m.calibration };
}

// Real win rate of archetype a vs b from tournament pairings (null if too few games)
function realMatchup(a, b, minGames = 8) {
  const r = Meta.data?.real?.[a + '|' + b];
  if (!r) return null;
  const n = r.w + r.l + r.t;
  return n >= minGames ? { win: (r.w + r.t * 0.5) / n, games: n } : null;
}

// Simulated prize races are more lopsided than real games (no disruption, misplays, healing...).
// Fit how much to pull simulated win rates toward 50% so they best match real tournament results.
function calibrateMatchups(profiles) {
  const pts = [];
  for (const a of profiles) for (const b of profiles) {
    if (a === b || !a.profile || !b.profile) continue;
    const r = realMatchup(a.id, b.id, 10);
    if (!r) continue;
    pts.push({ sim: matchupWinRate(a.profile, b.profile, 1500), real: r.win, n: r.games });
  }
  if (pts.length < 4) return { k: 0.5, points: pts.length, fitted: false };
  let best = { k: 0.5, err: Infinity };
  for (let k = 0; k <= 1.001; k += 0.05) {
    const err = pts.reduce((s, p) => s + p.n * (0.5 + k * (p.sim - 0.5) - p.real) ** 2, 0);
    if (err < best.err) best = { k, err };
  }
  const n = pts.reduce((s, p) => s + p.n, 0);
  // Error vs. just guessing 50%: tells us whether the simulator adds anything
  const base = pts.reduce((s, p) => s + p.n * (0.5 - p.real) ** 2, 0) / n;
  return { k: +best.k.toFixed(2), points: pts.length, games: n, rmse: Math.sqrt(best.err / n), baselineRmse: Math.sqrt(base), fitted: true };
}
const shrinkWin = (w, k) => 0.5 + k * (w - 0.5);

// How much of a tournament list the user already owns (by card name — reprints count).
function ownershipOf(metaDeck, collectionEntries) {
  const owned = new Map();
  for (const { card, qty } of collectionEntries) owned.set(card.name, (owned.get(card.name) || 0) + qty);
  let have = 0;
  const missing = [];
  for (const c of metaDeck.list) {
    const isBasicE = c.category === 'Energy' && /^(Basic )?\w+ Energy$/.test(c.name);
    const o = isBasicE ? Infinity : (owned.get(c.name) || 0);
    have += Math.min(c.count, o);
    if (o < c.count) missing.push({ ...c, need: c.count - o });
  }
  return { have, total: metaDeck.list.reduce((a, c) => a + c.count, 0), missing };
}
