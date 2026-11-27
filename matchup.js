// Matchup simulator: a prize race between two decks.
//
// Each deck is first play-tested on its own (sim.js) to learn how fast it sets up. Then thousands
// of games are raced: whoever has an attacker ready hits the other side's Active Pokémon (or, with a
// gust card, a Benched one they can Knock Out), Weakness doubles damage, a Knocked Out attacker has
// to be replaced (fast if the deck had a backup built, slower if not), and the first player to take
// 6 Prize cards wins. It's an estimate — no Abilities in combat, healing, or special conditions —
// but it captures speed, damage vs HP, Weakness, Prize trades, gusting and attacker depth.
'use strict';

function deckProfile(entries, coreName, games = 1200) {
  if (!coreName) return null;
  const sim = simulateDeck(entries, coreName, { games, seed: 31, maxTurn: 6 });
  if (!sim) return null;
  const byName = new Map();
  for (const e of entries) byName.set(e.card.name, (byName.get(e.card.name) || 0) + e.count);
  const cards = new Map(entries.map(e => [e.card.name, e.card]));
  const isTop = c => !entries.some(x => x.card.evolveFrom === c.name);
  const mkMon = c => {
    const a = bestAttackOf(c);
    return {
      name: c.name, hp: c.hp || 60, prize: prizeValue(c), type: (c.types || [])[0] || 'Colorless',
      weakness: weaknessOf(c), dmg: a ? estimateDamage(a.damage, a.effect) : 0,
    };
  };
  const attackers = [];
  for (const e of entries) {
    if (!isPokemon(e.card) || !['core', 'partner'].includes(e.role) || !isTop(e.card)) continue;
    if (attackers.some(a => a.name === e.card.name)) continue;
    attackers.push({ ...mkMon(e.card), copies: byName.get(e.card.name), main: e.role === 'core' });
  }
  attackers.sort((a, b) => b.main - a.main || b.dmg - a.dmg);
  if (!attackers.length) return null;
  // Benched Pokémon that sit around (engine pieces, Basics waiting to evolve) — gust targets
  const sitters = [];
  for (const [name, n] of byName) {
    const c = cards.get(name);
    if (!isPokemon(c) || attackers.some(a => a.name === name)) continue;
    sitters.push({ ...mkMon(c), weight: n });
  }
  sitters.sort((a, b) => b.weight - a.weight);
  const coreBasic = entries.find(e => e.role === 'core' && isBasicPokemon(e.card));
  const roles = c => isTrainer(c) ? trainerRoles(c) : new Set();
  const count = role => entries.filter(e => roles(e.card).has(role)).reduce((a, e) => a + e.count, 0);
  const gust = count('gust'), recovery = count('recovery');
  return {
    coreName, sim, attackers, sitters: sitters.slice(0, 3),
    opener: coreBasic ? mkMon(coreBasic.card) : (sitters[0] || { name: 'Basic', hp: 70, prize: 1, type: 'Colorless', dmg: 20 }),
    supply: attackers.reduce((a, x) => a + x.copies, 0) + Math.min(2, recovery * 0.5),
    gustChance: Math.min(0.65, gust * 0.13),
    backupP: sim.backupByTurn4,
  };
}

function sampleReady(prof, rng) {
  const u = rng();
  const cum = prof.sim.readyCum;
  for (let t = 1; t < cum.length; t++) if (cum[t] >= u) return t;
  return cum.length + Math.floor(rng() * 3); // stalled: a few turns late
}

function raceGame(A, B, rng, firstIdx) {
  const mk = prof => ({
    prof, prizes: 6, turns: 0, supply: prof.supply, attackerIdx: 0,
    readyAt: sampleReady(prof, rng),
    active: { ...prof.opener, taken: 0, attacker: false },
    bench: prof.sitters.map(s => ({ ...s, taken: 0, attacker: false })),
  });
  const P = [mk(A), mk(B)];
  const nextAttacker = me => {
    const list = me.prof.attackers;
    // Mostly the main attacker; partner when the main one is gone or as a backup
    const a = list[me.attackerIdx % list.length];
    me.attackerIdx++;
    return { ...a, taken: 0, attacker: true };
  };
  const promote = me => {
    if (me.bench.length) { me.active = me.bench.shift(); return true; }
    if (me.supply > 0) { me.active = { ...me.prof.opener, taken: 0, attacker: false }; return true; }
    return false;
  };
  for (let round = 1; round <= 20; round++) {
    for (const i of [firstIdx, 1 - firstIdx]) {
      const me = P[i], opp = P[1 - i];
      me.turns++;
      // Bring in a ready attacker
      if (!me.active.attacker && me.turns >= me.readyAt && me.supply > 0) {
        if (me.active.taken < me.active.hp) me.bench.push(me.active);
        me.active = nextAttacker(me);
        me.supply--;
      }
      const canAttack = me.active.attacker && me.turns >= me.readyAt && !(round === 1 && i === firstIdx);
      if (!canAttack) continue;
      // Pick a target: a gust onto a Benched Pokémon we can Knock Out for the most Prizes
      const hit = t => me.active.dmg * (t.weakness && t.weakness === me.active.type ? 2 : 1);
      let target = opp.active, onBench = -1;
      if (opp.bench.length && rng() < me.prof.gustChance) {
        let best = -1;
        opp.bench.forEach((t, k) => {
          if (hit(t) >= t.hp - t.taken) {
            const v = t.prize * 10 + (t.attacker ? 5 : 0);
            if (v > best && (v > (hit(opp.active) >= opp.active.hp - opp.active.taken ? opp.active.prize * 10 : 0))) { best = v; onBench = k; }
          }
        });
        if (onBench >= 0) target = opp.bench[onBench];
      }
      target.taken += hit(target);
      if (target.taken >= target.hp) {
        me.prizes -= target.prize;
        if (me.prizes <= 0) return i;
        if (onBench >= 0) opp.bench.splice(onBench, 1);
        else {
          const wasAttacker = target.attacker;
          if (!promote(opp)) return i; // no Pokémon left
          if (wasAttacker) {
            // Replacing a Knocked Out attacker: immediate if a backup was built, else 1-2 turns
            const delay = rng() < opp.prof.backupP ? 0 : 1 + (rng() < 0.4 ? 1 : 0);
            opp.readyAt = opp.turns + 1 + delay;
          }
        }
      }
    }
  }
  return P[0].prizes < P[1].prizes ? 0 : P[1].prizes < P[0].prizes ? 1 : -1;
}

// Win rate of deck A against deck B (each goes first half the time).
function matchupWinRate(A, B, games = 2000, seed = 77) {
  const rng = mulberry32(seed);
  let w = 0;
  for (let g = 0; g < games; g++) {
    const r = raceGame(A, B, rng, g & 1);
    if (r === 0) w++; else if (r === -1) w += 0.5;
  }
  return w / games;
}

// Matchups of one deck against the resolved tournament decks; returns per-archetype and weighted.
//  - If the deck IS a known archetype (same main attacker), real tournament results for that
//    archetype are used, nudged by how much more/less consistent this version is.
//  - Otherwise the prize-race estimate is pulled toward 50% by the calibration factor k, which
//    measures how well the simulator matched real results (k≈0 means "no better than a coin flip").
function matchupReport(entries, coreName, metaProfiles, games = 2000, profileGames = 1200, { k = 0.5, archetype = null } = {}) {
  const me = deckProfile(entries, coreName, profileGames);
  if (!me) return null;
  const consistencyDelta = archetype?.profile ? me.sim.objective - archetype.profile.sim.objective : 0;
  const rows = metaProfiles.filter(m => m.profile).map(m => {
    // The prize race only matters when it's trusted (k > 0) and there's no real data; skip it otherwise
    let simCache;
    const simOf = () => (simCache ??= matchupWinRate(me, m.profile, games));
    if (archetype && archetype.id === m.id) {
      // Mirror match: even, apart from how much more consistent your version is
      return { id: m.id, name: m.name, share: m.share, win: Math.max(0.3, Math.min(0.7, 0.5 + 0.3 * consistencyDelta)), source: 'mirror' };
    }
    const real = archetype && typeof realMatchup === 'function' ? realMatchup(archetype.id, m.id) : null;
    if (real) {
      const win = Math.max(0.05, Math.min(0.95, real.win + 0.3 * consistencyDelta));
      return { id: m.id, name: m.name, share: m.share, win, source: 'real', games: real.games };
    }
    return { id: m.id, name: m.name, share: m.share, win: k > 0 ? shrinkWin(simOf(), k) : 0.5, sim: k > 0 ? simOf() : null, source: 'sim' };
  });
  const wsum = rows.reduce((a, r) => a + r.share, 0) || 1;
  return { rows, overall: rows.reduce((a, r) => a + r.win * r.share, 0) / wsum, archetype: archetype?.name || null, k };
}

// Which tournament archetype is this deck? Same main attacker (or that attacker named in the
// archetype) and mostly the same Pokémon.
function matchArchetype(entries, coreName, metaProfiles) {
  const mine = new Set(entries.filter(e => isPokemon(e.card)).map(e => e.card.name));
  let best = null;
  for (const m of metaProfiles) {
    const r = Meta.resolved.get(m.id);
    if (!r || !m.profile) continue;
    const theirs = new Set(r.entries.filter(e => isPokemon(e.card)).map(e => e.card.name));
    const overlap = [...mine].filter(n => theirs.has(n)).length / Math.max(1, Math.min(mine.size, theirs.size));
    const sameCore = r.core === coreName || m.name.toLowerCase().includes((coreName || '').toLowerCase().replace(/^mega /, '').replace(/ ex$/, ''));
    const s = (sameCore ? 1 : 0) + overlap;
    if (sameCore && overlap >= 0.3 && (!best || s > best.s)) best = { ...m, s };
  }
  return best;
}
