// Upgrade advisor: "what should I buy to make this deck better?"
//
// Candidate purchases come from recent tournament lists (cards strong players actually use) plus
// extra copies of cards already in the deck. Each candidate is swapped in for the deck's weakest
// cards and judged by play-testing (setup speed) and, when tournament decks are loaded, by the
// matchup simulator. Results are ranked by improvement per dollar, as a step-by-step shopping list.
'use strict';

async function findUpgrades(deck, { metaResolved = [], metaProfiles = [], k = 0.5 } = {}, onProgress = () => {}) {
  const fmt = RULES.formats[deck.format] || RULES.formats.standard;
  const pool = new Pool(Collection.entries(), deck.format);
  const owned = name => /^Basic \w+ Energy$/.test(name) ? 99 : (pool.get(name)?.qty || 0);

  // Card data for every name we might use
  const cardOf = new Map();
  for (const e of deck.entries) if (!cardOf.has(e.card.name)) cardOf.set(e.card.name, e.card);
  for (const g of pool.all()) if (!cardOf.has(g.name)) cardOf.set(g.name, g.card);
  const buyable = new Map(); // name -> {card, price}
  for (const r of metaResolved) for (const e of r.entries) {
    const c = e.card;
    if (c.virtual || !fmt.test(c) || isBasicEnergy(c)) continue;
    const p = Prices.value(Prices.get(c.id));
    const prev = buyable.get(c.name);
    if (!prev || (p != null && (prev.price == null || p < prev.price))) buyable.set(c.name, { card: c, price: p });
    if (!cardOf.has(c.name)) cardOf.set(c.name, c);
  }
  // Extra copies of what the deck already plays
  onProgress('Checking prices…');
  await loadPrices(deck.entries.filter(e => !e.card.virtual).map(e => e.card.id));
  for (const e of deck.entries) {
    if (e.card.virtual || isBasicEnergy(e.card) || buyable.has(e.card.name)) continue;
    buyable.set(e.card.name, { card: e.card, price: Prices.value(Prices.get(e.card.id)) });
  }

  // Working copy of the deck by name
  const counts = new Map();
  for (const e of deck.entries) {
    const v = counts.get(e.card.name) || { count: 0, role: e.role };
    v.count += e.count;
    counts.set(e.card.name, v);
  }
  const toEntries = cm => [...cm].filter(([, v]) => v.count > 0).map(([n, v]) => ({ card: cardOf.get(n), count: v.count, role: v.role }));
  const top = metaProfiles.filter(m => m.profile);
  const evalSetup = (cm, games) => simulateDeck(toEntries(cm), deck.core, { games, seed: 303 })?.objective ?? 0;
  // Matchups count only as much as they've proven trustworthy (calibrated against real results)
  const evalFull = cm => {
    const setup = evalSetup(cm, 500);
    if (!top.length) return { score: setup, setup, win: null };
    const ents = toEntries(cm);
    // Recognise the archetype among all tournament decks (it may be less popular than the top 5)
    const rep = matchupReport(ents, deck.core, top, 500, 500, { k, archetype: matchArchetype(ents, deck.core, metaProfiles) });
    const win = rep ? rep.overall : 0.5;
    return { score: 0.6 * setup + 0.4 * win, setup, win };
  };

  // Protected cards (same rules as the deck optimizer)
  const roleOf = n => { const c = cardOf.get(n); return isTrainer(c) ? trainerRoles(c) : new Set(); };
  const roleTotal = (cm, r) => [...cm].filter(([n, v]) => v.count && roleOf(n).has(r)).reduce((a, [, v]) => a + v.count, 0);
  const minKeep = {};
  for (const [r, cap] of [['gust', 3], ['recovery', 2], ['switch', 2], ['stadium', 1], ['aceSpec', 1]]) minKeep[r] = Math.min(cap, roleTotal(counts, r));
  const bought = new Set(); // never cut something an earlier step told you to buy
  const removable = cm => [...cm].filter(([n, v]) => {
    if (!v.count || bought.has(n)) return false;
    const c = cardOf.get(n);
    if (v.role === 'core' && isPokemon(c)) return false;
    if (isPokemon(c) && v.count === 1 && [...cm].some(([m, w]) => w.count && cardOf.get(m).evolveFrom === n)) return false;
    // Keep the last copy of anything another card in the deck needs by name (Solrock needs Lunatone)
    if (v.count === 1 && [...cm].some(([m, w]) => w.count && m !== n && mentions(cardOf.get(m), n))) return false;
    for (const r of roleOf(n)) if (minKeep[r] != null && roleTotal(cm, r) - 1 < minKeep[r]) return false;
    return true;
  }).map(([n]) => n);

  const deckTypes = () => {
    const pt = new Set(), et = new Set();
    for (const [n, v] of counts) {
      const c = cardOf.get(n);
      if (!v.count || !isPokemon(c)) continue;
      (c.types || []).forEach(t => pt.add(t));
      for (const a of c.attacks || []) for (const e of a.cost) if (e !== 'Colorless') et.add(e);
    }
    return { pt, et };
  };

  // Candidate purchases: single cards, and whole evolution lines for engines/attackers
  const candidates = () => {
    const { pt, et } = deckTypes();
    const deckPokemon = new Set([...counts].filter(([n, v]) => v.count && isPokemon(cardOf.get(n))).map(([n]) => n));
    const ctx = { energyTypes: et, pokemonTypes: pt, deckPokemon, poolPokemonNames: [...cardOf.values()].filter(isPokemon).map(c => c.name), families: new Set([...deckPokemon].map(familyOf).filter(Boolean)) };
    const out = [];
    for (const [name, b] of buyable) {
      const c = b.card;
      const cur = counts.get(name)?.count || 0;
      const cap = isAceSpec(c) ? 1 : 4;
      if (cur >= cap) continue;
      if (isAceSpec(c) && !cur && [...counts].some(([n, v]) => v.count && isAceSpec(cardOf.get(n)))) continue;
      if (isTrainer(c)) {
        const g = { card: c, roles: trainerRoles(c) };
        if (trainerValue(g, ctx) <= 0) continue;
        if (g.roles.has('candy') && ![...deckPokemon].some(n => stageRank(cardOf.get(n)) === 2)) continue;
        out.push({ adds: [[name, Math.min(cap - cur, cur ? 1 : 2)]] });
      } else if (isPokemon(c)) {
        if (cur) { out.push({ adds: [[name, 1]] }); continue; }
        // A new line: include its pre-evolutions (bought or owned)
        const line = [c];
        let x = c;
        while (x.evolveFrom) { const pre = cardOf.get(x.evolveFrom); if (!pre) break; line.unshift(pre); x = pre; }
        if (!isBasicPokemon(line[0])) continue;
        if (line.some(p => !fmt.test(p))) continue;
        const isTopLine = ![...cardOf.values()].some(o => o.evolveFrom === c.name && buyable.has(o.name));
        if (!isTopLine) continue;
        const roles = pokemonRoles(c);
        const need = Object.keys(primaryEnergyNeeds(c));
        const fitsEnergy = need.every(e => et.has(e));
        if (!roles.has('engine') && !(fitsEnergy && attackerScore(c) > 60)) continue;
        const conds = (c.abilities || []).map(a => abilityConditions(a.effect));
        if (conds.some(k => (k.discardType && !et.has(k.discardType)) || (k.attachedType && !et.has(k.attachedType)) || k.unreliable)) continue;
        const plan = line.length === 3 ? [2, 1, 2] : line.length === 2 ? [2, 2] : [2];
        out.push({ adds: line.map((p, i) => [p.name, plan[i]]), role: roles.has('engine') ? 'engine' : 'partner' });
      }
    }
    return out;
  };

  // Only copies beyond what you own (and beyond what earlier steps already bought) cost money
  const costOf = adds => adds.reduce((a, [n, k]) => {
    const cur = counts.get(n)?.count || 0;
    const extra = Math.max(0, cur + k - owned(n)) - Math.max(0, cur - owned(n));
    const price = buyable.get(n)?.price ?? Prices.value(Prices.get(cardOf.get(n)?.id));
    return a + extra * (price ?? 1.5); // unknown price: assume a typical card
  }, 0);
  const apply = (cm, adds, rems, role) => {
    const m = new Map([...cm].map(([k, v]) => [k, { ...v }]));
    for (const [n, k] of adds) { const v = m.get(n) || { count: 0, role: role || roleForAdded({ card: cardOf.get(n), roles: roleOf(n) }, m) }; v.count += k; m.set(n, v); }
    for (const n of rems) { const v = m.get(n); v.count--; }
    return m;
  };

  const baseSim = simulateDeck(toEntries(counts), deck.core, { games: 2000, seed: 404 });
  let base = evalFull(counts);
  const start = { ...base, t2: baseSim?.byTurn2, t3: baseSim?.byTurn3 };
  const steps = [];
  for (let step = 0; step < 6; step++) {
    onProgress(`Testing upgrades… step ${step + 1}`);
    await new Promise(r => setTimeout(r, 0));
    // Weakest cards to make room
    const rem = removable(counts).map(n => {
      const v = counts.get(n); v.count--; const s = evalSetup(counts, 250); v.count++; return { n, s };
    }).sort((a, b) => b.s - a.s);
    // The k least useful cards: one copy each of the weakest names first, then repeats
    const removalsFor = k => {
      const out = [], used = new Map();
      for (let pass = 1; pass <= 4 && out.length < k; pass++) {
        for (const r of rem) {
          if (out.length >= k) break;
          const u = used.get(r.n) || 0;
          if (u < pass && u < counts.get(r.n).count) { out.push(r.n); used.set(r.n, u + 1); }
        }
      }
      return out;
    };
    // Quick screen on setup speed, then full evaluation (with matchups) of the best few
    const cands = candidates().map(c => {
      const k = c.adds.reduce((a, [, n]) => a + n, 0);
      const rems = removalsFor(k);
      if (rems.length < k) return null;
      const cm = apply(counts, c.adds, rems, c.role);
      return { ...c, rems, cm, cost: costOf(c.adds), quick: evalSetup(cm, 300) };
    }).filter(Boolean);
    const quickBase = evalSetup(counts, 300);
    const screened = cands.sort((a, b) => (b.quick - quickBase) / (b.cost + 0.5) - (a.quick - quickBase) / (a.cost + 0.5)).slice(0, 6);
    // Matchup-only improvers (new attackers) don't show up in the setup screen — keep a couple
    for (const c of cands.filter(c => c.role === 'partner').slice(0, 2)) if (!screened.includes(c)) screened.push(c);
    let best = null;
    for (const c of screened) {
      const r = evalFull(c.cm);
      const gain = r.score - base.score;
      const value = gain / (c.cost + 0.5);
      if (gain >= 0.008 && (!best || value > best.value)) best = { ...c, r, gain, value };
    }
    if (!best) break;
    const after = simulateDeck(toEntries(best.cm), deck.core, { games: 2000, seed: 404 });
    // How many copies actually need buying (you may already own spares not in the deck)
    const buyCount = (n, k) => { const cur = counts.get(n)?.count || 0; return Math.max(0, cur + k - owned(n)) - Math.max(0, cur - owned(n)); };
    const addRows = best.adds.map(([n, k]) => ({ name: n, count: k, buy: buyCount(n, k), price: buyable.get(n)?.price ?? null, card: cardOf.get(n) }));
    best.adds.forEach(([n]) => bought.add(n));
    counts.clear(); for (const [k, v] of best.cm) if (v.count > 0) counts.set(k, v);
    base = best.r;
    const remSummary = {};
    best.rems.forEach(n => { remSummary[n] = (remSummary[n] || 0) + 1; });
    steps.push({
      adds: addRows,
      removes: Object.entries(remSummary).map(([name, count]) => ({ name, count })),
      cost: best.cost, t2: after?.byTurn2, t3: after?.byTurn3, win: best.r.win,
    });
  }
  return { start, steps, usedMatchups: top.length > 0, finalEntries: toEntries(counts) };
}
