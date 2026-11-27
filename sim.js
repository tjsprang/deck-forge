// Deck Forge simulator + optimizer.
//
// The simulator "goldfishes" a deck: it plays the opening turns of thousands of games against
// no opponent and measures how fast the deck sets up — the question every real deck-builder asks
// when they playtest ("how often can I attack with my main Pokémon on turn 2?").
//
// Modelled: shuffle, opening hand with mulligans, 6 Prize cards (pieces can be prized), going
// first/second (no draw / no Supporter / no attack on the first turn going first), Bench limit,
// no evolving on your first turn or the turn a Pokémon was played, Rare Candy, Pokémon search
// Items (Basic-only vs any, "up to 2", discard costs like Ultra Ball), search Supporters,
// draw Supporters (draw N / until N / shuffle-and-draw / discard-and-draw), one Supporter and
// one Energy attachment per turn, draw/search abilities (Pidgeot ex style), energy acceleration
// from Items and abilities, and Energy types against the attack's actual cost.
//
// The optimizer then tries swapping cards in and out (only cards you own) and keeps changes that
// make the deck set up more reliably, while protecting cards the simulator can't value
// (gust, recovery, switching, Stadiums, Tools, ACE SPEC).
'use strict';

const SIM_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon'];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Card text -> simulation model ----------
function parseSearchSpec(text) {
  const t = text.toLowerCase();
  const idx = t.indexOf('search your deck for');
  if (idx < 0) return null;
  const seg = t.slice(idx + 20).split('.')[0];
  const spec = { n: 1, filter: 'any', type: null, hpMax: null, energy: /energy/.test(seg), pokemon: /pokémon/.test(seg), line: false, cost: 0, bench: /onto your bench/.test(seg + t.slice(idx, idx + 200)) };
  const up = seg.match(/up to (\d+)/);
  if (up) spec.n = parseInt(up[1], 10);
  if (/a basic pokémon, a stage 1 pokémon, and a stage 2/.test(seg)) { spec.line = true; spec.n = 3; }
  else if (/evolution pokémon|stage 1|stage 2/.test(seg)) spec.filter = 'evolution';
  else if (/basic pokémon/.test(seg)) spec.filter = 'basic';
  const ty = SIM_TYPES.find(x => new RegExp(`\\b${x.toLowerCase()} pokémon`).test(seg));
  if (ty) spec.type = ty;
  const ety = SIM_TYPES.find(x => new RegExp(`\\b${x.toLowerCase()} energy`).test(seg));
  if (ety) spec.eType = ety;
  spec.either = spec.energy && spec.pokemon && /\bor\b/.test(seg) && !/\band\b/.test(seg);
  const hp = seg.match(/(\d+) hp or less|with (\d+) hp or less|remaining hp of (\d+) or less/);
  if (hp) spec.hpMax = parseInt(hp[1] || hp[2] || hp[3], 10);
  const cost = t.match(/discard (\d|two|2) (other )?cards? from your hand/);
  if (cost) spec.cost = cost[1] === 'two' ? 2 : parseInt(cost[1], 10) || 2;
  return spec;
}

function parseDrawSpec(text) {
  const t = text.toLowerCase();
  let m;
  // Only draws that are YOURS count ("your opponent draws 3 cards" is not card draw for you)
  const yours = t.split(/(?<=\.)\s+/)
    .map(s => s.replace(/,? and your opponent draws? \d+ cards?/g, ''))
    .filter(s => !(/(they|your opponent) draws?\b/.test(s) && !/you draw|each player draws|player draws/.test(s)) && !/^your opponent /.test(s.trim()))
    .join(' ');
  if ((m = yours.match(/draw cards until you have (\d+) cards/))) return { mode: 'until', n: +m[1] };
  const shuffles = /shuffles? (their|your|his or her) hand (into|and puts it)/.test(yours) || /each player shuffles their hand/.test(yours);
  if (shuffles && /for each of (their|your) remaining prize/.test(yours)) return { mode: 'shuffle', n: 6 };
  // Coin-flip draws ("if heads, you draw 5 ... if tails, you draw 3"): use the average
  const youDraw = [...yours.matchAll(/you draw (\d+) cards/g)].map(x => +x[1]);
  if (youDraw.length > 1) return { mode: shuffles ? 'shuffle' : 'n', n: Math.round(youDraw.reduce((a, b) => a + b, 0) / youDraw.length) };
  if (shuffles && (m = yours.match(/draws? (\d+) cards/))) return { mode: 'shuffle', n: +m[1] };
  if ((m = yours.match(/discard your hand and draw (\d+) cards/))) return { mode: 'discard', n: +m[1] };
  if ((m = yours.match(/draw (\d+) cards/))) return { mode: 'n', n: +m[1] };
  if (/draw a card/.test(yours)) return { mode: 'n', n: 1 };
  return null;
}
// "You can use this card only if ..." (more Prizes left, a Tera Pokémon in play, after a Knock
// Out...) — conservatively treated as no help during setup. Discard costs (Ultra Ball) are modelled.
const lateGameOnly = t => /you can use this card only if (?!you discard)/i.test(t);

function bestAttackOf(card) {
  let best = null, bestV = -1;
  for (const a of card.attacks || []) {
    const v = estimateDamage(a.damage, a.effect) - a.cost.length * 4;
    if (v > bestV) { bestV = v; best = a; }
  }
  return best;
}

function energyReq(card) {
  const a = bestAttackOf(card);
  const req = { total: 0, typed: {} };
  if (!a) return req;
  for (const e of a.cost) { req.total++; if (e !== 'Colorless') req.typed[e] = (req.typed[e] || 0) + 1; }
  return req;
}

function modelCard(card) {
  const m = { name: card.name, card, kind: 'other' };
  if (isPokemon(card)) {
    m.kind = 'pokemon';
    m.basic = isBasicPokemon(card);
    m.stage = stageRank(card);
    m.evolveFrom = card.evolveFrom;
    m.types = card.types || [];
    m.hp = card.hp || 0;
    m.req = energyReq(card);
    for (const ab of card.abilities || []) {
      const t = ab.effect.toLowerCase();
      if (!/once during your turn|when you play this pokémon/.test(t) && !/draw|search/.test(t)) continue;
      const cond = abilityConditions(ab.effect);
      if (cond.unreliable) continue; // e.g. "if any of your Pokémon were Knocked Out last turn"
      m.abCond = cond;
      const onPlay = /when you play this pokémon from your hand/.test(t);
      const draw = parseDrawSpec(t);
      const search = parseSearchSpec(t);
      if (/search your deck for (a|any|up to \d+) cards?\b/.test(t)) m.tutor = { n: (t.match(/up to (\d+) cards/) || [0, 1])[1] * 1, onPlay };
      else if (search && search.pokemon) m.abSearch = { ...search, onPlay };
      else if (draw) m.abDraw = { ...draw, onPlay };
      if (/attach .*energy/.test(t)) m.abAccel = { fromDeck: /from your deck/.test(t), fromDiscard: /from your discard/.test(t) };
    }
  } else if (isTrainer(card)) {
    const t = card.effect || '';
    m.kind = card.trainerType === 'Supporter' ? 'supporter' : card.trainerType === 'Stadium' ? 'stadium' : /tool/i.test(card.trainerType || '') ? 'tool' : 'item';
    if (lateGameOnly(t)) return m; // e.g. Special Red Card, Unfair Stamp: no help setting up
    m.search = parseSearchSpec(t);
    m.draw = parseDrawSpec(t);
    m.candy = card.name === 'Rare Candy' || /skipping the stage 1/i.test(t);
    m.accel = /attach .*energy/i.test(t) && !m.search ? { fromDeck: /from your deck/i.test(t), fromDiscard: /from your discard/i.test(t), n: /up to 2|2 basic/i.test(t) ? 2 : 1 } : null;
  } else if (isEnergy(card)) {
    m.kind = 'energy';
    const basic = isBasicEnergy(card);
    m.eType = basic ? energyTypeOf(card) : null;
    m.eAny = !basic && /every type|any type/i.test(card.effect || '');
    m.eAmount = !basic && /provides? (2|two)/i.test(card.effect || '') ? 2 : 1;
  }
  return m;
}

// Compile deck entries into arrays the simulator can run fast.
function compileDeck(entries, coreName) {
  const byName = new Map();
  for (const e of entries) {
    if (!byName.has(e.card.name)) byName.set(e.card.name, { card: e.card, count: 0, role: e.role });
    byName.get(e.card.name).count += e.count;
  }
  const models = [], list = [], nameIdx = new Map();
  for (const [name, v] of byName) {
    const m = modelCard(v.card);
    m.role = v.role;
    m.idx = models.length;
    nameIdx.set(name, m.idx);
    models.push(m);
    for (let i = 0; i < v.count; i++) list.push(m.idx);
  }
  // Evolution lines
  const lineOf = name => {
    const line = [];
    let cur = nameIdx.has(name) ? models[nameIdx.get(name)] : null;
    while (cur) { line.unshift(cur.idx); cur = cur.evolveFrom && nameIdx.has(cur.evolveFrom) ? models[nameIdx.get(cur.evolveFrom)] : null; }
    return line;
  };
  const coreTop = nameIdx.get(coreName);
  const core = coreTop != null ? lineOf(coreName) : [];
  // Basic of the core line even if the Stage 1 is missing (Rare Candy line)
  if (core.length && !models[core[0]].basic) {
    const s1 = models[core[0]].evolveFrom;
    const basicName = [...byName.values()].map(v => v.card).find(c => c.name === s1)?.evolveFrom;
    if (basicName && nameIdx.has(basicName)) core.unshift(nameIdx.get(basicName));
  }
  const partnerTops = models.filter(m => m.kind === 'pokemon' && m.role === 'partner' && !models.some(x => x.evolveFrom === m.name && x.role === 'partner'));
  const partner = partnerTops.length ? lineOf(partnerTops[0].name) : [];
  const engineTops = models.filter(m => m.kind === 'pokemon' && (m.abDraw || m.tutor || m.abSearch) && m.idx !== coreTop);
  const engines = engineTops.map(m => lineOf(m.name)).filter(l => l.length);
  // Which line / stage is each Pokémon in?
  for (const m of models) { m.lineRole = null; m.lineStage = -1; }
  const mark = (line, role) => line.forEach((i, s) => { if (!models[i].lineRole) { models[i].lineRole = role; models[i].lineStage = s; models[i].line = line; } });
  mark(core, 'core'); mark(partner, 'partner'); engines.forEach(l => mark(l, 'engine'));
  return { models, list, nameIdx, core, partner, engines, coreTop };
}

// ---------- One simulated game ----------
function runGame(D, rng, maxTurn) {
  const M = D.models;
  const deck = D.list.slice();
  const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const x = arr[i]; arr[i] = arr[j]; arr[j] = x; } };
  let mull = 0, hand;
  for (;;) {
    shuffle(deck);
    hand = deck.slice(0, 7);
    if (hand.some(i => M[i].kind === 'pokemon' && M[i].basic)) break;
    if (++mull > 8) return { mull, ready: 99, backup: false, brick: true };
  }
  let lib = deck.slice(7);
  lib.splice(0, 6); // prizes
  const first = rng() < 0.5;
  const play = []; // {i, played, energy: {type: n}, eTotal}
  const discard = [];
  const coreLine = D.core, coreTopIdx = D.coreTop;
  const req = coreTopIdx != null ? M[coreTopIdx].req : { total: 99, typed: {} };
  let readyTurn = 99, backup = false;

  const draw = n => { for (let k = 0; k < n && lib.length; k++) hand.push(lib.pop()); };
  const takeFromHand = i => { const p = hand.indexOf(i); if (p >= 0) hand.splice(p, 1); return p >= 0; };
  const takeFromLib = pred => { for (let p = lib.length - 1; p >= 0; p--) if (pred(M[lib[p]])) return lib.splice(p, 1)[0]; return -1; };
  const countIn = (arr, i) => { let n = 0; for (const x of arr) if (x === i) n++; return n; };
  const inPlayCount = i => play.filter(p => p.i === i).length;

  // What the deck wants next, most important first (card indices).
  const wants = turn => {
    const w = [];
    const coreMons = play.filter(p => M[p.i].lineRole === 'core');
    if (coreLine.length) {
      if (!coreMons.length && !hand.some(i => i === coreLine[0])) w.push(coreLine[0]);
      // Evolution pieces for the most advanced core Pokémon
      const sorted = coreMons.slice().sort((a, b) => M[b.i].lineStage - M[a.i].lineStage);
      for (const p of sorted) {
        const st = M[p.i].lineStage;
        if (st < coreLine.length - 1) {
          const nxt = coreLine[st + 1];
          if (!hand.includes(nxt)) w.push(nxt);
          if (st === 0 && coreLine.length === 3 && D.candyIdx != null && !hand.includes(coreLine[2])) w.push(coreLine[2]);
          if (st === 0 && coreLine.length === 3 && D.candyIdx != null && !hand.includes(D.candyIdx)) w.push(D.candyIdx);
        }
        break;
      }
      // Energy for the attacker
      const target = attachTarget();
      if (target) for (const ty of missingTypes(target)) { const e = D.energyByType[ty]; if (e != null && !hand.includes(e)) w.push(e); }
      if (coreMons.length < 2 && !hand.includes(coreLine[0])) w.push(coreLine[0]);
    }
    for (const line of D.engines) {
      const mons = play.filter(p => line.includes(p.i));
      if (!mons.length) { if (!hand.includes(line[0])) w.push(line[0]); }
      else {
        const st = Math.max(...mons.map(p => line.indexOf(p.i)));
        if (st < line.length - 1 && !hand.includes(line[st + 1])) w.push(line[st + 1]);
      }
    }
    if (D.partner.length) {
      const mons = play.filter(p => D.partner.includes(p.i));
      if (!mons.length) w.push(D.partner[0]);
      else { const st = Math.max(...mons.map(p => D.partner.indexOf(p.i))); if (st < D.partner.length - 1) w.push(D.partner[st + 1]); }
    }
    return w.filter(i => lib.includes(i));
  };
  const missingTypes = p => {
    const out = [];
    for (const [ty, n] of Object.entries(req.typed)) { const have = p.energy[ty] || 0; for (let k = have; k < n; k++) out.push(ty); }
    return out;
  };
  const satisfied = p => {
    if (p.eTotal < req.total) return false;
    let anyLeft = p.energy.Any || 0;
    for (const [ty, n] of Object.entries(req.typed)) {
      const have = p.energy[ty] || 0;
      if (have < n) { if (anyLeft >= n - have) anyLeft -= n - have; else return false; }
    }
    return true;
  };
  function attachTarget() {
    const coreMons = play.filter(p => M[p.i].lineRole === 'core');
    if (!coreMons.length) return null;
    coreMons.sort((a, b) => (M[b.i].lineStage - M[a.i].lineStage) || (b.eTotal - a.eTotal));
    for (const p of coreMons) if (!satisfied(p)) return p;
    return null;
  }
  const benchRoom = () => play.length < 6;
  const playBasics = turn => {
    // Core basics first, then engine/partner basics, then others (keep 1 slot free-ish)
    const order = hand.filter(i => M[i].kind === 'pokemon' && M[i].basic).sort((a, b) => rankBasic(a) - rankBasic(b));
    for (const i of order) {
      if (!benchRoom()) break;
      if (rankBasic(i) >= 3 && play.length >= 4) continue;
      takeFromHand(i);
      play.push({ i, played: turn, energy: {}, eTotal: 0 });
      onPlayAbility(i, turn);
    }
  };
  const rankBasic = i => M[i].lineRole === 'core' ? 0 : M[i].lineRole === 'engine' ? 1 : M[i].lineRole === 'partner' ? 2 : 3;
  const fetch = (spec, turn) => {
    // Grab the most-wanted cards that match the search filter
    let got = 0;
    const w = wants(turn);
    const fits = i => {
      const m = M[i];
      if (m.kind !== 'pokemon') return false;
      if (spec.filter === 'basic' && !m.basic) return false;
      if (spec.filter === 'evolution' && m.basic) return false;
      if (spec.type && !m.types.includes(spec.type)) return false;
      if (spec.hpMax && m.hp > spec.hpMax) return false;
      return true;
    };
    for (const i of w) {
      if (got >= spec.n) break;
      if (!fits(i)) continue;
      const p = lib.indexOf(i);
      if (p < 0) continue;
      lib.splice(p, 1);
      if (spec.bench && M[i].basic && benchRoom()) { play.push({ i, played: turn, energy: {}, eTotal: 0 }); }
      else hand.push(i);
      got++;
    }
    if (spec.line) {
      // Dawn-style: one of each stage
      for (const st of [0, 1, 2]) {
        const i = takeFromLib(m => m.kind === 'pokemon' && m.stage === st && m.lineRole);
        if (i >= 0) hand.push(i);
      }
    }
    // "X or Y" cards (Fighting Gong) give one card; "X and Y" cards (Hilda) give both.
    if (spec.energy && !(spec.either && got > 0)) {
      const t = attachTarget();
      const ty = spec.eType || (t ? missingTypes(t)[0] : null);
      const e = takeFromLib(m => m.kind === 'energy' && (!ty || m.eType === ty) && (!spec.eType || m.eType === spec.eType));
      if (e >= 0) hand.push(e);
    }
    return got;
  };
  // How much a card in hand matters for setting up (used to pick discards for Ultra Ball-style
  // costs). Returns null if paying the cost would mean throwing away something important.
  const handValue = () => {
    const t = attachTarget();
    const stillNeed = {};
    if (t) for (const ty of missingTypes(t)) stillNeed[ty] = (stillNeed[ty] || 0) + 1;
    let energyNeeded = t ? Math.max(0, req.total - t.eTotal) : 1;
    const inPlayNames = new Set(play.map(p => M[p.i].name));
    const coreEvolved = play.some(p => p.i === coreTopIdx);
    const supporters = hand.filter(i => M[i].kind === 'supporter').length;
    const seen = new Map();
    return hand.map(i => {
      const m = M[i];
      const dup = seen.get(i) || 0; seen.set(i, dup + 1);
      let v = 4;
      if (m.kind === 'pokemon') {
        if (m.lineRole === 'core') v = 14 - dup * 3;
        else if (m.lineRole) v = 9 - dup * 3;
        if (m.evolveFrom && inPlayNames.has(m.evolveFrom)) v += 4;
      } else if (m.kind === 'energy') {
        const ty = m.eType;
        if (ty && stillNeed[ty] > 0) { stillNeed[ty]--; energyNeeded--; v = 13; }
        else if (energyNeeded > 0) { energyNeeded--; v = 9; }
        else v = 3;
      } else if (m.candy) v = coreLine.length === 3 && !coreEvolved ? 13 - dup * 4 : 2;
      else if (m.kind === 'supporter') v = supporters <= 1 ? 12 : 7 - dup;
      else if (m.kind === 'item' && m.search) v = 8 - dup;
      else if (m.kind === 'tool' || m.kind === 'stadium') v = 2;
      return { i, v };
    });
  };
  const lowValueCards = n => {
    const scored = handValue().sort((a, b) => a.v - b.v);
    const pick = scored.slice(0, n);
    if (pick.length < n || pick.some(x => x.v > 6)) return null;
    return pick.map(x => x.i);
  };
  const usedAbility = new Set();
  function onPlayAbility(i, turn) {
    const m = M[i];
    if (m.tutor?.onPlay) { for (let k = 0; k < m.tutor.n; k++) { const w = wants(turn); const x = w.length ? lib.indexOf(w[0]) : -1; if (x >= 0) hand.push(lib.splice(x, 1)[0]); } }
    if (m.abSearch?.onPlay) fetch(m.abSearch, turn);
    if (m.abDraw?.onPlay) doDraw(m.abDraw);
  }
  function doDraw(spec) {
    if (spec.mode === 'n') draw(spec.n);
    else if (spec.mode === 'until') draw(Math.max(0, spec.n - hand.length));
    else if (spec.mode === 'shuffle') { lib.push(...hand); hand.length = 0; shuffle(lib); draw(spec.n); }
    else if (spec.mode === 'discard') { discard.push(...hand); hand.length = 0; draw(spec.n); }
  }
  const evolveAll = turn => {
    if (turn < 2) return;
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of play) {
        if (p.played >= turn) continue;
        // Rare Candy: Basic -> Stage 2
        const m = M[p.i];
        if (D.candyIdx != null && m.basic && m.line && m.line.length === 3 && hand.includes(D.candyIdx) && hand.includes(m.line[2])) {
          takeFromHand(D.candyIdx); takeFromHand(m.line[2]); discard.push(D.candyIdx);
          p.i = m.line[2]; p.played = turn; changed = true; onPlayAbility(p.i, turn); continue;
        }
        const evo = hand.find(i => M[i].evolveFrom === m.name);
        if (evo != null) { takeFromHand(evo); p.i = evo; p.played = turn; changed = true; onPlayAbility(evo, turn); }
      }
    }
  };
  // Ability conditions: "if you have Solrock in play", "discard a Basic Fighting Energy",
  // "if this Pokémon has Darkness Energy attached". Pays the discard cost when it can.
  const abilityReady = (p, m) => {
    const c = m.abCond;
    if (!c) return true;
    if (c.needsInPlay && !play.some(q => M[q.i].name === c.needsInPlay)) return false;
    if (c.attachedType && !(p.energy[c.attachedType] > 0)) return false;
    if (c.discardType) {
      const k = hand.findIndex(i => M[i].kind === 'energy' && M[i].eType === c.discardType);
      if (k < 0) return false;
      discard.push(hand.splice(k, 1)[0]);
    }
    return true;
  };
  const useAbilities = turn => {
    for (const p of play) {
      const m = M[p.i];
      if (usedAbility.has(m.name)) continue;
      if ((m.abDraw && !m.abDraw.onPlay) || (m.tutor && !m.tutor.onPlay) || (m.abSearch && !m.abSearch.onPlay)) {
        if (!abilityReady(p, m)) continue;
      }
      if (m.abDraw && !m.abDraw.onPlay) { usedAbility.add(m.name); doDraw(m.abDraw); }
      else if (m.tutor && !m.tutor.onPlay) { usedAbility.add(m.name); const w = wants(turn); const x = w.length ? lib.indexOf(w[0]) : -1; if (x >= 0) hand.push(lib.splice(x, 1)[0]); }
      else if (m.abSearch && !m.abSearch.onPlay) { usedAbility.add(m.name); fetch(m.abSearch, turn); }
    }
  };
  const playItems = turn => {
    let progress = true, guard = 0;
    while (progress && guard++ < 12) {
      progress = false;
      for (const i of hand.slice()) {
        const m = M[i];
        if (m.kind !== 'item' || !hand.includes(i)) continue;
        if (m.search && (m.search.pokemon || m.search.energy)) {
          const w = wants(turn);
          if (!w.length) continue;
          let disc = [];
          if (m.search.cost) {
            // Only pay a discard cost for something that matters (main line or draw engine)
            if (!['core', 'engine'].includes(M[w[0]].lineRole) && M[w[0]].kind !== 'energy') continue;
            takeFromHand(i);
            disc = lowValueCards(m.search.cost);
            hand.push(i);
            if (!disc) continue;
          }
          takeFromHand(i); discard.push(i);
          for (const x of disc) { takeFromHand(x); discard.push(x); }
          fetch(m.search, turn); progress = true;
        } else if (m.accel) {
          const t = attachTarget();
          if (!t) continue;
          const src = m.accel.fromDeck ? lib : m.accel.fromDiscard ? discard : hand;
          let done = 0;
          for (let k = 0; k < m.accel.n; k++) {
            const ty = missingTypes(t)[0];
            const p = src.findIndex(x => M[x].kind === 'energy' && (!ty || M[x].eType === ty || M[x].eAny));
            if (p < 0) break;
            const e = src.splice(p, 1)[0];
            addEnergy(t, M[e]); done++;
          }
          if (done) { takeFromHand(i); discard.push(i); progress = true; }
        } else if (m.draw && !m.candy) {
          takeFromHand(i); discard.push(i); doDraw(m.draw); progress = true;
        }
      }
      if (progress) { playBasics(turn); useAbilities(turn); }
    }
  };
  const addEnergy = (p, em) => {
    const k = em.eAny ? 'Any' : em.eType || 'Colorless';
    p.energy[k] = (p.energy[k] || 0) + em.eAmount;
    p.eTotal += em.eAmount;
  };
  const playSupporter = turn => {
    const sups = [...new Set(hand.filter(i => M[i].kind === 'supporter'))];
    if (!sups.length) return;
    const w = wants(turn);
    let best = null, bestV = 0;
    for (const i of sups) {
      const m = M[i];
      let v = 0;
      if (m.search && (m.search.pokemon || m.search.energy || m.search.line)) v += Math.min(w.length, m.search.line ? 3 : m.search.n + (m.search.energy ? 1 : 0)) * 3;
      if (m.draw) {
        const n = m.draw.mode === 'until' ? m.draw.n - (hand.length - 1) : m.draw.mode === 'n' ? m.draw.n : m.draw.n - (hand.length - 1) * 0.6;
        v += Math.max(0, n) * (w.length ? 1.2 : 0.6);
        if (m.draw.mode === 'discard' && hand.length > 4) v -= 2;
      }
      if (v > bestV) { bestV = v; best = i; }
    }
    if (best == null || bestV < 1) return;
    takeFromHand(best); discard.push(best);
    const m = M[best];
    if (m.search) fetch(m.search, turn);
    if (m.draw) doDraw(m.draw);
  };

  // Setup: active + bench from opening hand
  playBasics(0);

  for (let turn = 1; turn <= maxTurn; turn++) {
    usedAbility.clear();
    if (!(first && turn === 1)) draw(1);
    if (!lib.length && !hand.length) break;
    useAbilities(turn);
    playBasics(turn);
    playItems(turn);
    if (!(first && turn === 1)) { playSupporter(turn); playBasics(turn); useAbilities(turn); playItems(turn); }
    evolveAll(turn);
    useAbilities(turn);
    playItems(turn);
    evolveAll(turn);
    // Energy attachment (one per turn) + ability acceleration
    const t = attachTarget();
    if (t) {
      const ty = missingTypes(t)[0];
      let e = hand.findIndex(i => M[i].kind === 'energy' && ty && (M[i].eType === ty || M[i].eAny));
      if (e < 0) e = hand.findIndex(i => M[i].kind === 'energy' && (!ty || M[i].eAny || t.eTotal + 1 < req.total || Object.keys(req.typed).length === 0));
      if (e >= 0) { addEnergy(t, M[hand[e]]); hand.splice(e, 1); }
    }
    for (const p of play) {
      const m = M[p.i];
      if (!m.abAccel || usedAbility.has(m.name + ':accel')) continue;
      const tgt = attachTarget();
      if (!tgt) break;
      const src = m.abAccel.fromDeck ? lib : m.abAccel.fromDiscard ? discard : hand;
      const ty = missingTypes(tgt)[0];
      const x = src.findIndex(i => M[i].kind === 'energy' && (!ty || M[i].eType === ty));
      if (x >= 0) { addEnergy(tgt, M[src.splice(x, 1)[0]]); usedAbility.add(m.name + ':accel'); }
    }
    // Can the main attacker attack this turn?
    if (readyTurn === 99 && !(first && turn === 1)) {
      if (play.some(p => p.i === coreTopIdx && satisfied(p))) readyTurn = turn;
    }
    if (turn === maxTurn) {
      const tops = play.filter(p => p.i === coreTopIdx || (D.partner.length && p.i === D.partner[D.partner.length - 1]));
      backup = tops.length >= 2;
    }
  }
  return { mull, ready: readyTurn, backup, first };
}

function simulateDeck(entries, coreName, { games = 1000, seed = 7, maxTurn = 4 } = {}) {
  const D = compileDeck(entries, coreName);
  if (D.coreTop == null) return null;
  D.candyIdx = D.models.find(m => m.candy)?.idx ?? null;
  D.energyByType = {};
  for (const m of D.models) if (m.kind === 'energy' && m.eType && D.energyByType[m.eType] == null) D.energyByType[m.eType] = m.idx;
  const rng = mulberry32(seed);
  const res = { games, ready: new Array(Math.max(5, maxTurn + 1)).fill(0), backup: 0, mull: 0, never: 0, sumTurn: 0 };
  for (let g = 0; g < games; g++) {
    const r = runGame(D, rng, maxTurn);
    res.mull += r.mull;
    if (r.ready <= maxTurn) { for (let t = r.ready; t <= maxTurn; t++) res.ready[t]++; res.sumTurn += r.ready; }
    else { res.never++; res.sumTurn += maxTurn + 1.5; }
    if (r.backup) res.backup++;
  }
  const p = n => n / games;
  const out = {
    games,
    byTurn2: p(res.ready[2]), byTurn3: p(res.ready[3]), byTurn4: p(res.ready[4]),
    backupByTurn4: p(res.backup),
    avgFirstAttack: res.sumTurn / games,
    mulligansPerGame: res.mull / games,
    readyCum: res.ready.map(v => v / games), // P(main attacker can attack by turn t)
  };
  out.objective = 0.4 * out.byTurn2 + 0.3 * out.byTurn3 + 0.15 * out.byTurn4 + 0.15 * out.backupByTurn4;
  return out;
}

// ---------- Optimizer ----------
// Hill-climbs card counts using the simulator. Only uses cards you own (and assumed basic Energy).
async function optimizeDeck(ctx, onProgress = () => {}) {
  const { pool, core, opts } = ctx;
  const counts = new Map([...ctx.draft.counts].map(([k, v]) => [k, { ...v }]));
  const total = () => [...counts.values()].reduce((a, v) => a + v.count, 0);
  const toEntries = cm => [...cm].filter(([, v]) => v.count > 0).map(([n, v]) => ({ card: pool.get(n).card, count: v.count, role: v.role }));
  const evalCounts = (cm, games = 500) => simulateDeck(toEntries(cm), core.name, { games, seed: 101 })?.objective ?? 0;

  // Cards the simulator can't value: keep at least what the builder chose (capped).
  const roleTotal = (cm, role) => [...cm].filter(([n]) => pool.get(n).roles.has(role)).reduce((a, [, v]) => a + v.count, 0);
  const minKeep = {};
  for (const [role, cap] of [['gust', 3], ['recovery', 2], ['switch', 2], ['stadium', 1], ['tool', 1], ['aceSpec', 1]]) minKeep[role] = Math.min(cap, roleTotal(counts, role));
  // Same text checks the builder uses, so the optimizer never adds off-type or unsupported cards
  const deckPokemon = new Set([...counts.keys()].filter(n => isPokemon(pool.get(n).card)));
  const tctx = {
    energyTypes: new Set(), pokemonTypes: new Set([...deckPokemon].flatMap(n => pool.get(n).card.types || [])),
    deckPokemon, poolPokemonNames: pool.pokemon().map(g => g.name), families: new Set([...deckPokemon].map(familyOf).filter(Boolean)),
  };
  const usedNames = () => new Set([...counts].filter(([, v]) => v.count > 0).map(([n]) => n));
  const legalRemove = name => {
    const v = counts.get(name);
    if (!v || v.count <= 0) return false;
    const g = pool.get(name);
    for (const r of g.roles) if (minKeep[r] != null && roleTotal(counts, r) - 1 < minKeep[r]) return false;
    // The main attacker's line only ever grows: early Basics get Knocked Out in real games,
    // which a solo play-test can't see.
    if (v.role === 'core' && isPokemon(g.card)) return false;
    if (v.role === 'partner' && isPokemon(g.card) && v.count <= 1) return false; // keep the deck's second attacker
    // Keep the last copy of anything another card needs by name (Solrock's attack needs Lunatone)
    if (v.count === 1) for (const n of usedNames()) if (n !== name && mentions(pool.get(n).card, name)) return false;
    // Don't remove the last pre-evolution of something still in the deck
    if (v.count === 1 && isPokemon(g.card)) {
      for (const n of usedNames()) { const c = pool.get(n).card; if (c.evolveFrom === name) return false; }
      if (name === core.name) return false;
    }
    if (name === core.name && v.count <= 2) return false;
    return true;
  };
  const neededTypes = new Set();
  for (const n of usedNames()) { const c = pool.get(n).card; if (isPokemon(c)) for (const a of c.attacks || []) for (const e of a.cost) if (e !== 'Colorless') neededTypes.add(e); }
  neededTypes.forEach(t => tctx.energyTypes.add(t));
  const energyTotal = () => [...counts].filter(([n]) => isEnergy(pool.get(n).card)).reduce((a, [, v]) => a + v.count, 0);
  const coreCost = energyReq(core.card).total || 2;
  const energyCap = Math.max(energyTotal(), Math.min(14, 5 + coreCost * 2.5));
  const addable = () => {
    const out = [];
    const names = usedNames();
    for (const g of pool.all()) {
      const cur = counts.get(g.name)?.count || 0;
      const cap = isBasicEnergy(g.card) ? 30 : 4;
      if (cur >= Math.min(cap, g.qty)) continue;
      const c = g.card;
      if (isAceSpec(c) && !cur && [...names].some(n => isAceSpec(pool.get(n).card))) continue;
      if (isRadiant(c) && !cur && [...names].some(n => isRadiant(pool.get(n).card))) continue;
      if (isPokemon(c)) {
        if (!isBasicPokemon(c) && !names.has(c.evolveFrom)) continue;
        if (!cur && !['core', 'engine', 'partner'].includes(roleOfLine(c))) continue;
      } else if (isTrainer(c)) {
        if (!['search', 'draw', 'candy', 'accel', 'energySearch', 'trainerSearch', 'switch'].some(r => g.roles.has(r))) continue;
        if (trainerValue(g, tctx) <= 0) continue;
        if (g.roles.has('candy') && ![...names].some(n => stageRank(pool.get(n).card) === 2)) continue;
      } else if (isEnergy(c)) {
        if (isBasicEnergy(c) && !neededTypes.has(energyTypeOf(c))) continue;
        // More Energy always helps the opening turns but floods you later: cap it by attack cost.
        if (energyTotal() >= energyCap) continue;
      }
      out.push(g.name);
    }
    // Assumed basic Energy of needed types
    if (opts.assumeBasicEnergy && energyTotal() < energyCap) for (const ty of neededTypes) {
      if (!BASIC_ENERGY_TYPES.includes(ty)) continue;
      const nm = `Basic ${ty} Energy`;
      if (!pool.get(nm)) { const card = virtualBasicEnergy(ty); pool.byName.set(nm, { name: nm, printings: [{ card, qty: 99 }], qty: 99, card, roles: new Set(), attack: 0, virtual: true }); }
      if (!out.includes(nm)) out.push(nm);
    }
    return out;
  };
  const roleOfLine = c => {
    for (const [n, v] of counts) if (v.count && (pool.get(n).card.evolveFrom === c.name || c.evolveFrom === n)) return v.role;
    return counts.get(c.name)?.role;
  };

  const simOf = cm => simulateDeck(toEntries(cm), core.name, { games: 2000, seed: 202 });
  const beforeSim = simOf(counts);
  const start = beforeSim?.objective ?? 0;
  let base = evalCounts(counts);
  const changes = [];
  const yieldUI = () => new Promise(r => setTimeout(r, 0));
  for (let iter = 0; iter < 12; iter++) {
    onProgress(iter / 12);
    await yieldUI();
    // Score single removals (59 cards) and single additions (61 cards)
    const rem = [...counts.keys()].filter(legalRemove).map(n => {
      const v = counts.get(n); v.count--; const s = evalCounts(counts, 250); v.count++; return { n, s };
    }).sort((a, b) => b.s - a.s).slice(0, 3);
    await yieldUI();
    const add = addable().map(n => {
      const had = counts.get(n);
      if (had) had.count++; else counts.set(n, { count: 1, role: 'opt', reason: '' });
      const s = evalCounts(counts, 250);
      if (had) had.count--; else counts.delete(n);
      return { n, s };
    }).sort((a, b) => b.s - a.s).slice(0, 3);
    // Try the most promising swaps with more games
    let best = null;
    for (const a of add) for (const r of rem) {
      if (a.n === r.n) continue;
      const rv = counts.get(r.n); rv.count--;
      const had = counts.get(a.n);
      if (had) had.count++; else counts.set(a.n, { count: 1, role: 'opt', reason: '' });
      const s = evalCounts(counts, 600);
      if (had) had.count--; else counts.delete(a.n);
      rv.count++;
      if (s > base + 0.006 && (!best || s > best.s)) best = { add: a.n, rem: r.n, s };
    }
    if (!best) break;
    const rv = counts.get(best.rem); rv.count--; if (!rv.count) counts.delete(best.rem);
    const had = counts.get(best.add);
    if (had) had.count++; else counts.set(best.add, { count: 1, role: roleForAdded(pool.get(best.add), counts), reason: 'Added by the setup optimizer' });
    changes.push({ add: best.add, rem: best.rem });
    base = best.s;
  }
  onProgress(1);
  if (total() !== RULES.deckSize) return null; // safety: shouldn't happen
  const afterSim = simOf(counts);
  const finalScore = afterSim?.objective ?? 0;
  // Net the change log (e.g. +1 X, -1 X cancel out)
  const net = new Map();
  for (const c of changes) { net.set(c.add, (net.get(c.add) || 0) + 1); net.set(c.rem, (net.get(c.rem) || 0) - 1); }
  const summary = [...net].filter(([, d]) => d).map(([n, d]) => ({ name: n, delta: d }));
  return { counts, before: start, after: finalScore, beforeSim, afterSim, summary };
}

function roleForAdded(g, counts) {
  const c = g.card;
  if (isEnergy(c)) return 'energy';
  if (isTrainer(c)) return ['candy', 'search', 'draw', 'switch', 'accel', 'energySearch', 'trainerSearch'].find(r => g.roles.has(r)) || 'trainer';
  for (const [n, v] of counts) if (v.count && (c.evolveFrom === n || g.card.name === n)) return v.role;
  return 'extra';
}
