// Deck Forge engine: Pokémon TCG deck rules, card-role analysis, and the deck generator.
//
// How competitive 60-card decks are put together (what this engine imitates):
//  * ~12-20 Pokémon, ~30-38 Trainers, ~8-12 Energy.
//  * One main attacker line (e.g. 3-2-3 / 4-1-3 Stage 2 with Rare Candy, 4-3 Stage 1, 3-4 Basic ex),
//    usually a partner attacker, and a "draw engine" Pokémon (ability that draws or searches).
//  * Consistency first: lots of Pokémon search Items (Ultra Ball, Poffin, type "Gong" cards), 7-10 draw
//    Supporters (Lillie's Determination, Hilda, Dawn...), 2-3 gust cards (Boss's Orders, Prime Catcher),
//    switching, recovery (Night Stretcher), a Stadium and some Tools, one ACE SPEC.
//  * Card roles are read from the card text, so new sets work without code changes.
//  * Energy only of the types the attacks need; fewer if the deck has energy acceleration.
//  * Prize trade: ex / V cards give up 2 Prizes (Mega ex / VMAX / Tag Team 3), so a strong
//    single-prize attacker can be as valuable as a big ex.
'use strict';

const RULES = {
  deckSize: 60,
  maxCopies: 4,
  formats: {
    standard: { label: 'Standard', test: c => c.legal.standard },
    expanded: { label: 'Expanded', test: c => c.legal.expanded },
    unlimited: { label: 'Unlimited', test: () => true },
  },
};

// ---------- Card facts ----------
const isPokemon = c => c.category === 'Pokemon';
const isTrainer = c => c.category === 'Trainer';
const isEnergy = c => c.category === 'Energy';
const isBasicEnergy = c => isEnergy(c) && (c.energyType === 'Normal' || /^(Basic )?\w+ Energy$/.test(c.name) && !c.effect);
const isBasicPokemon = c => isPokemon(c) && (c.stage === 'Basic' || (!c.evolveFrom && !/Stage|VMAX|VSTAR|BREAK|Mega|LEGEND|V-UNION/i.test(c.stage || '')));
const isAceSpec = c => /ACE SPEC/i.test(c.rarity) || /ace ?spec/i.test(c.trainerType || '');
const isRadiant = c => /^Radiant /.test(c.name);
const isPrismStar = c => /◇|Prism Star/.test(c.name);
const energyTypeOf = c => {
  const m = c.name.match(/^(?:Basic )?(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon)\b/);
  return m ? m[1] : (c.types && c.types[0]) || null;
};

function prizeValue(c) {
  if (!isPokemon(c)) return 0;
  const s = (c.suffix || '').toLowerCase();
  if (/v-union|vmax/i.test(c.stage || '') || /VMAX|V-UNION/.test(c.name)) return 3;
  if (/^Mega /.test(c.name) && s === 'ex') return 3;
  if (/&/.test(c.name) && s === 'gx') return 3;
  if (['ex', 'gx', 'v', 'vstar', 'vmax'].includes(s) || /\b(ex|EX|GX|V|VSTAR)$/.test(c.name) || /VSTAR/.test(c.stage || '')) return 2;
  return 1;
}

// Expected damage of an attack, reading the attack text for "×" and "+" attacks
// (e.g. "50× for each of your Benched Pokémon" is ~200 in a real game, "Flip 2 coins" ~50).
function estimateDamage(d, effect = '') {
  const t = (effect || '').toLowerCase();
  if (!d) {
    // Damage-counter attacks print no damage number ("put 2 damage counters ... for each card in your hand")
    const m = t.match(/put (\d+) damage counters? on (?:1 of )?your opponent's/);
    if (!m) return 0;
    const per = +m[1] * 10;
    if (/for each card in your hand/.test(t)) return per * 6;
    if (/for each/.test(t)) return per * 3;
    return per;
  }
  const n = parseInt(String(d).replace(/[^0-9]/g, ''), 10) || 0;
  if (/[×x]/.test(d)) {
    let m;
    if ((m = t.match(/flip (\d+) coins/))) return n * +m[1] / 2;
    if (/until you get tails/.test(t)) return n;
    if (/for each of your benched pokémon|for each pokémon on your bench|for each of your pokémon in play/.test(t)) return n * 4;
    if (/for each of your opponent's benched|for each of your opponent's pokémon/.test(t)) return n * 3;
    if (/for each energy attached|for each .*energy attached/.test(t)) return n * 3;
    if (/for each prize card/.test(t)) return n * 3;
    if (/for each damage counter/.test(t)) return n * 5;
    if (/for each .*in your discard pile/.test(t)) return n * 5;
    if (/for each card in your (opponent's )?hand/.test(t)) return n * 5;
    return n * 2.5;
  }
  if (/\+/.test(d)) {
    const more = t.match(/(\d+) more damage/);
    const extra = more ? +more[1] : n * 0.5;
    let k;
    // Coin attacks first: "flip until you get tails, 50 more for each heads" averages 1 heads
    if (/until you get tails/.test(t)) return n + extra;
    if ((k = t.match(/flip (\d+) coins/))) return n + extra * +k[1] / 2;
    if (/flip a coin/.test(t)) return n + extra * 0.5;
    if (/for each/.test(t)) return n + extra * 3;
    return n + extra * 0.6; // conditional bonus, often met
  }
  if (/-/.test(d)) return n * 0.85;
  return n;
}
const parseDamage = d => estimateDamage(d, '');

const stageRank = c => {
  const s = (c.stage || '').toLowerCase();
  if (s.includes('stage2')) return 2;
  if (s.includes('stage1') || s === 'vmax' || s === 'vstar' || s === 'break' || s === 'mega') return isBasicPokemon(c) ? 0 : 1;
  return isBasicPokemon(c) ? 0 : 1;
};

// ---------- Role analysis (reads the card text) ----------
function cardText(c) {
  return [c.effect, ...(c.abilities || []).map(a => a.effect), ...(c.attacks || []).map(a => a.effect)].join(' ').toLowerCase();
}

// ---------- Synergy (reads which cards name each other) ----------
// e.g. Lunatone's ability needs Solrock in play; "Ethan's Adventure" finds "Ethan's Pokémon";
// a Tool that boosts "Charizard ex" belongs in a Charizard deck.
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionCache = new Map();
function mentions(card, name) {
  if (!name || name === card.name || name.length < 4 || /^(Basic )?\w+ Energy$/.test(name)) return false;
  const key = card.id + '|' + name;
  if (mentionCache.has(key)) return mentionCache.get(key);
  const text = [card.effect, ...(card.abilities || []).map(a => a.effect), ...(card.attacks || []).map(a => a.effect)].join(' ');
  const hit = new RegExp(`(^|[^\\w'])${escRe(name)}(?![\\w-]| ex| V| GX| EX| VMAX| VSTAR)`).test(text);
  mentionCache.set(key, hit);
  return hit;
}
// "Ethan's Typhlosion" -> "Ethan's"
const familyOf = name => (name.match(/^((?:Team )?[A-Z][\w.]*'s) /) || [])[1] || null;
// "Search your deck for up to 2 Ethan's Pokémon" -> "Ethan's"
const familySupported = card => ((card.effect || '') + ' ' + (card.abilities || []).map(a => a.effect).join(' ')).match(/((?:Team )?[A-Z][\w.]*'s) Pokémon/)?.[1] || null;
const weaknessOf = c => (c.weaknesses || [])[0]?.type || null;

function trainerRoles(c) {
  const t = (c.effect || '').toLowerCase();
  const r = new Set();
  const name = c.name.toLowerCase();
  const searchSeg = (t.split('search your deck for')[1] || '').split('.')[0];
  const searchesPokemon = /pokémon/.test(searchSeg);
  // "draw" = Supporters that refill your hand or dig for what you need (draw or search)
  if (c.trainerType === 'Supporter' && (/draw (\d+|a card|cards|until)|draws? (\d+|cards)/.test(t) || searchSeg)) r.add('draw');
  if (/switch (in )?1 of your opponent's benched|opponent's benched pokémon .*(active|switch)|your opponent switches/.test(t)) r.add('gust');
  if (searchesPokemon && c.trainerType !== 'Supporter') r.add('search');
  if (name === 'rare candy' || /skipping the stage 1|evolves? .* stage 2 pokémon .* from your hand/.test(t)) r.add('candy');
  if (/switch your active pokémon with 1 of your benched/.test(t)) r.add('switch');
  if (/(from your discard pile|discard pile) (in|on)to your (deck|hand)|put .* from your discard pile into your (hand|deck)/.test(t) && /pokémon|energy/.test(t)) r.add('recovery');
  if (/attach .*energy.* (from your discard pile|from your deck|from your hand) to|attach (up to )?\d+ basic .* energy/.test(t)) r.add('accel');
  if (/energy/.test(searchSeg) && c.trainerType !== 'Supporter') r.add('energySearch');
  if (/(item|tool|trainer|supporter)/.test(searchSeg) && c.trainerType !== 'Supporter') r.add('trainerSearch');
  if (/heal/.test(t)) r.add('heal');
  if (/shuffle (his or her|their|your opponent's) hand|opponent .* shuffles .* hand/.test(t)) r.add('disrupt');
  if (/attacks? .* do(es)? \d+ more damage|damage .* increased|\+\d+ damage/.test(t)) r.add('damage');
  if (c.trainerType === 'Stadium') r.add('stadium');
  if (/tool/i.test(c.trainerType || '')) r.add('tool');
  if (isAceSpec(c)) r.add('aceSpec');
  return r;
}

// What an ability needs before it works:
//  needsInPlay  - "if you have Solrock in play"
//  discardType  - "discard a Basic Fighting Energy card from your hand"
//  attachedType - "if this Pokémon has any Darkness Energy attached"
//  unreliable   - only after a Knock Out, only in the Active Spot, only going second, etc.
function abilityConditions(text) {
  const t = text || '';
  const c = {};
  let m;
  if ((m = t.match(/if you have ([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)*) in play/))) c.needsInPlay = m[1];
  // Costs paid with a specific Energy from your hand (discarding it, or attaching it first)
  if ((m = t.match(/(?:discard|attach) an? (?:Basic )?(\w+) Energy card from your hand/i)) && BASIC_ENERGY_TYPES.includes(m[1])) c.discardType = m[1];
  if ((m = t.match(/has any (\w+) Energy attached/i)) && BASIC_ENERGY_TYPES.includes(m[1])) c.attachedType = m[1];
  if (/knocked out during your opponent's last turn|if this pokémon is in the active spot|if you go second|if your opponent has \d+ or (fewer|less) prize|if you have \d+ or (fewer|less) prize|during your first turn/i.test(t)) c.unreliable = true;
  return c;
}

function pokemonRoles(c) {
  const r = new Set();
  for (const a of c.abilities || []) {
    const t = a.effect.toLowerCase();
    const cond = abilityConditions(a.effect);
    if (!cond.unreliable && /draw (\d+|a card|cards|until)/.test(t)) r.add('engine');
    if (!cond.unreliable && /search your deck for/.test(t)) r.add('engine');
    if (/attach .*energy/.test(t)) r.add('accel');
    if (/switch|retreat cost/.test(t)) r.add('utility');
    if (/damage counter|prevent all damage|heal/.test(t)) r.add('utility');
  }
  if ((c.attacks || []).some(a => /search your deck for .*pokémon|put .* basic pokémon .* onto your bench/.test(a.effect.toLowerCase()))) r.add('starter');
  if ((c.attacks || []).some(a => /attach .*energy/.test(a.effect.toLowerCase()))) r.add('accel');
  return r;
}

// How strong a Pokémon is as an attacker (0-~150).
function attackerScore(c) {
  if (!isPokemon(c) || !(c.attacks || []).length) return 0;
  let best = 0;
  for (const a of c.attacks) {
    const dmg = estimateDamage(a.damage, a.effect);
    const cost = Math.max(1, a.cost.length);
    let v = dmg * (1 - 0.06 * (cost - 1)) + (dmg / cost) * 0.6;
    const t = a.effect.toLowerCase();
    if (/benched pokémon/.test(t) && dmg) v += 10;          // spread / snipe
    if (/damage counters on your opponent's/.test(t)) v += 15; // e.g. Phantom Dive style spread
    if (/can't use this attack during your next turn|discard (all|\d+) energy/.test(t)) v -= dmg * 0.12;
    if (/flip a coin/.test(t) && !/[×x+]/.test(a.damage)) v *= 0.75;
    if (/this pokémon also does \d+ damage to itself/.test(t)) v *= 0.92;
    best = Math.max(best, v);
  }
  // Durability matters, and so does the prize cost of the card.
  best += c.hp * 0.12;
  const prizes = prizeValue(c);
  best = best / (prizes === 1 ? 0.9 : prizes === 2 ? 1.12 : 1.35);
  // Evolved cards are slower to set up.
  best *= [1, 0.97, 0.92][stageRank(c)] || 1;
  return Math.round(best);
}

function primaryEnergyNeeds(c) {
  // Energy types needed by this Pokémon's attacks (Colorless excluded), weighted.
  const need = {};
  for (const a of c.attacks || []) for (const e of a.cost) if (e !== 'Colorless') need[e] = (need[e] || 0) + 1;
  return need;
}

// ---------- Deck validation ----------
function validateDeck(entries, format = 'standard', lookup = () => null) {
  // entries: [{card, count}]
  const issues = [];
  const total = entries.reduce((a, e) => a + e.count, 0);
  if (total !== RULES.deckSize) issues.push({ level: 'error', msg: `Deck has ${total} cards — it must be exactly 60.` });
  const byName = {};
  for (const e of entries) if (!isBasicEnergy(e.card)) byName[e.card.name] = (byName[e.card.name] || 0) + e.count;
  for (const [n, k] of Object.entries(byName)) if (k > 4) issues.push({ level: 'error', msg: `${k} copies of "${n}" — max 4 cards with the same name.` });
  if (!entries.some(e => isBasicPokemon(e.card))) issues.push({ level: 'error', msg: 'A deck needs at least one Basic Pokémon.' });
  const ace = entries.filter(e => isAceSpec(e.card)).reduce((a, e) => a + e.count, 0);
  if (ace > 1) issues.push({ level: 'error', msg: `${ace} ACE SPEC cards — only 1 is allowed per deck.` });
  const rad = entries.filter(e => isRadiant(e.card)).reduce((a, e) => a + e.count, 0);
  if (rad > 1) issues.push({ level: 'error', msg: `${rad} Radiant Pokémon — only 1 is allowed per deck.` });
  for (const e of entries) if (isPrismStar(e.card) && e.count > 1) issues.push({ level: 'error', msg: `Prism Star cards are limited to 1 copy ("${e.card.name}").` });
  const fmt = RULES.formats[format];
  for (const e of entries) if (fmt && !fmt.test(e.card) && !e.card.virtual) issues.push({ level: 'error', msg: `"${e.card.name}" (${e.card.setName}) is not legal in ${fmt.label}.` });
  // Evolution sanity
  const names = new Set(entries.map(e => e.card.name));
  const hasCandy = entries.some(e => e.card.name === 'Rare Candy');
  for (const e of entries) {
    const c = e.card;
    if (isPokemon(c) && c.evolveFrom && !names.has(c.evolveFrom)) {
      // A Stage 2 can skip its Stage 1 with Rare Candy, but its Basic must be in the deck.
      const stage1 = lookup(c.evolveFrom);
      const basicName = stage1 && stage1.evolveFrom;
      const viaCandy = stageRank(c) === 2 && hasCandy && basicName && names.has(basicName);
      if (!viaCandy) issues.push({ level: 'error', msg: `"${c.name}" evolves from "${c.evolveFrom}", which isn't in the deck — it can never be played.` });
    }
    if (c.name === 'Rare Candy' && !entries.some(x => isPokemon(x.card) && stageRank(x.card) === 2)) {
      issues.push({ level: 'warn', msg: 'Rare Candy does nothing without a Stage 2 Pokémon in the deck.' });
    }
  }
  return issues;
}

// ---------- Probability helpers ----------
function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}
// P(at least one of `hits` cards in a `draw`-card hand from a `deck`-card deck)
const pAtLeastOne = (hits, draw = 7, deck = 60) => 1 - comb(deck - hits, draw) / comb(deck, draw);

// ---------- Deck generator ----------
const BASIC_ENERGY_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];

function virtualBasicEnergy(type) {
  return {
    id: `virtual-energy-${type}`, name: `Basic ${type} Energy`, category: 'Energy', energyType: 'Normal',
    types: [type], legal: { standard: true, expanded: true }, setId: 'SVE', setName: 'Basic Energy',
    localId: '', attacks: [], abilities: [], effect: '', image: null, virtual: true, rarity: 'Common',
  };
}

class Pool {
  // Groups the collection by card name (different printings of the same card count together).
  constructor(entries, format) {
    const fmt = RULES.formats[format] || RULES.formats.standard;
    this.byName = new Map();
    for (const { card, qty } of entries) {
      if (!fmt.test(card)) continue;
      const g = this.byName.get(card.name) || { name: card.name, printings: [], qty: 0 };
      g.printings.push({ card, qty });
      g.qty += qty;
      this.byName.set(card.name, g);
    }
    for (const g of this.byName.values()) {
      g.printings.sort((a, b) => b.qty - a.qty);
      g.card = g.printings[0].card;
      g.roles = isTrainer(g.card) ? trainerRoles(g.card) : isPokemon(g.card) ? pokemonRoles(g.card) : new Set();
      g.attack = attackerScore(g.card);
    }
  }
  get(name) { return this.byName.get(name); }
  all() { return [...this.byName.values()]; }
  pokemon() { return this.all().filter(g => isPokemon(g.card)); }
  trainers() { return this.all().filter(g => isTrainer(g.card)); }
  energies() { return this.all().filter(g => isEnergy(g.card)); }
}

class DeckDraft {
  constructor(pool, opts) {
    this.pool = pool;
    this.opts = opts;
    this.counts = new Map(); // name -> {count, role, reason}
  }
  total() { let n = 0; for (const v of this.counts.values()) n += v.count; return n; }
  count(name) { return this.counts.get(name)?.count || 0; }
  has(name) { return this.count(name) > 0; }
  aceCount() { let n = 0; for (const [name, v] of this.counts) { const g = this.pool.get(name); if (g && isAceSpec(g.card)) n += v.count; } return n; }
  radiantCount() { let n = 0; for (const [name, v] of this.counts) if (isRadiant({ name })) n += v.count; return n; }

  // Add up to n copies of a named card, respecting ownership and deck rules. Returns copies added.
  add(name, n, role, reason) {
    const g = this.pool.get(name);
    if (!g || n <= 0) return 0;
    const cur = this.count(name);
    const basicE = isBasicEnergy(g.card);
    let cap = basicE ? 59 : RULES.maxCopies;
    if (isAceSpec(g.card)) cap = Math.min(cap, 1 - this.aceCount() + cur);
    if (isRadiant(g.card)) cap = Math.min(cap, 1 - this.radiantCount() + cur);
    if (isPrismStar(g.card)) cap = Math.min(cap, 1);
    cap = Math.min(cap, g.qty, cur + (RULES.deckSize - this.total()));
    const k = Math.max(0, Math.min(n, cap - cur));
    if (!k) return 0;
    const prev = this.counts.get(name);
    this.counts.set(name, { count: cur + k, role: prev?.role || role, reason: prev?.reason || reason });
    return k;
  }
  addVirtualEnergy(type, n) {
    const name = `Basic ${type} Energy`;
    if (!this.pool.get(name)) {
      const card = virtualBasicEnergy(type);
      this.pool.byName.set(name, { name, printings: [{ card, qty: 99 }], qty: 99, card, roles: new Set(), attack: 0, virtual: true });
    }
    return this.add(name, n, 'energy', `${type} Energy for your attackers`);
  }
  remove(name, n) {
    const v = this.counts.get(name);
    if (!v) return 0;
    const k = Math.min(n, v.count);
    v.count -= k;
    if (!v.count) this.counts.delete(name);
    return k;
  }
}

// Find the evolution line (Basic -> ... -> card) using names available in the pool.
function evolutionLine(pool, g) {
  const line = [g];
  let cur = g.card;
  let guard = 0;
  while (cur.evolveFrom && guard++ < 3) {
    const pre = pool.get(cur.evolveFrom) || pool.all().find(x => isPokemon(x.card) && x.name === cur.evolveFrom);
    if (!pre) { line.unshift({ missing: cur.evolveFrom }); break; }
    line.unshift(pre);
    cur = pre.card;
  }
  return line; // index 0 = basic (or {missing})
}

function lineBuildable(pool, g, hasCandy) {
  const line = evolutionLine(pool, g);
  const missing = line.filter(x => x.missing);
  if (!missing.length) return { ok: true, line };
  // Stage 2 with missing Stage 1 is OK if we have Rare Candy and the Basic.
  if (stageRank(g.card) === 2 && hasCandy && missing.length === 1 && line[0].missing && false) return { ok: false, line };
  if (stageRank(g.card) === 2 && hasCandy && missing.length === 1 && !line[0].missing) return { ok: true, line, skipStage1: true };
  return { ok: false, line };
}

// Tier lists of what each role is worth inside a Trainer category (higher = better).
function trainerValue(g, ctx) {
  const c = g.card;
  const t = (c.effect || '').toLowerCase();
  let v = 10;
  const m = t.match(/draw (\d+) cards/);
  if (m) v += parseInt(m[1], 10) * 2;
  if (/until you have (\d+)/.test(t)) v += 9;
  if (g.roles.has('search')) {
    if (/basic pokémon/.test(t) && !/evolution|stage/.test(t)) v += ctx.basicsHeavy ? 8 : 4;
    else v += 9;
    if (/up to 2|up to 3/.test(t)) v += 4;
  }
  if (g.roles.has('gust')) v += 8;
  if (g.roles.has('accel')) {
    const types = BASIC_ENERGY_TYPES.filter(e => t.includes(e.toLowerCase()));
    v += types.length === 0 || types.some(e => ctx.energyTypes.has(e)) ? 10 : -20;
  }
  if (g.roles.has('damage')) v += 4;
  if (g.roles.has('disrupt')) v += 4;
  if (/coin/.test(t)) v -= 5;
  // Cards that only work for a type we don't play (e.g. "Fighting Gong" in a Psychic deck).
  const ours = new Set([...ctx.pokemonTypes, ...ctx.energyTypes]);
  const typeMention = BASIC_ENERGY_TYPES.filter(e => new RegExp(`\\b${e.toLowerCase()} (pokémon|energy)\\b`).test(t));
  if (typeMention.length && !typeMention.some(e => ours.has(e))) v -= 25;
  else if (typeMention.length) v += 4;
  // Named-card support: great if it names something we play, useless if it doesn't.
  if (ctx.deckPokemon) {
    const named = ctx.poolPokemonNames.filter(n => mentions(c, n));
    if (named.length) v += named.some(n => ctx.deckPokemon.has(n)) ? 18 : -25;
    const fam = familySupported(c);
    if (fam) v += ctx.families.has(fam) ? 15 : -25;
  }
  return v;
}

function buildAroundCore(pool, core, opts) {
  const draft = new DeckDraft(pool, opts);
  const notes = [];
  const hasCandy = !!pool.get('Rare Candy');
  const corePrizes = prizeValue(core.card);

  // 1) Main attacker line
  const { line, skipStage1 } = lineBuildable(pool, core, hasCandy);
  const top = stageRank(core.card);
  const plans = top === 2 ? (hasCandy ? [4, 2, 3] : [4, 3, 3]) : top === 1 ? [4, 3] : [corePrizes > 1 ? 3 : 4];
  const realLine = line.filter(x => !x.missing);
  if (top === 2 && skipStage1) plans.splice(1, 1);
  realLine.forEach((g, i) => {
    const want = plans[i] ?? 2;
    const got = draft.add(g.name, want, 'core', i === realLine.length - 1 ? 'Main attacker' : `Evolves into ${realLine[i + 1].name}`);
    if (got < want) notes.push({ type: 'short', msg: `You own ${g.qty} ${g.name} — ${want} is recommended for a reliable line.`, name: g.name, want, have: g.qty });
  });
  if (top === 2 && skipStage1) notes.push({ type: 'short', msg: `No ${core.card.evolveFrom} in your collection — relying on Rare Candy to evolve.` });

  const energyTypes = new Set(Object.keys(primaryEnergyNeeds(core.card)));
  const pokemonTypes = new Set(core.card.types || []);

  // 2) Partner attacker: shares energy, or attacks with Colorless energy only.
  const partners = pool.pokemon()
    .filter(g => g.name !== core.name && g.attack > 0 && !draft.has(g.name))
    .filter(g => lineBuildable(pool, g, hasCandy).ok)
    .map(g => {
      const need = Object.keys(primaryEnergyNeeds(g.card));
      const fits = need.length === 0 || need.every(e => energyTypes.has(e));
      const partial = need.some(e => energyTypes.has(e));
      let s = g.attack * (fits ? 1 : partial ? 0.6 : 0.25);
      if (stageRank(g.card) > 0) s *= 0.85;
      if (prizeValue(g.card) === 1 && corePrizes > 1) s *= 1.1; // single-prize partners balance the prize trade
      // Synergy: cards that name each other, or share a trainer family (Ethan's, Team Rocket's...)
      const coreNames = realLine.map(x => x.name);
      if (coreNames.some(n => mentions(g.card, n)) || mentions(core.card, g.name)) s *= 1.35;
      if (familyOf(g.name) && familyOf(g.name) === familyOf(core.name)) s *= 1.2;
      // Weakness spread: a partner with a different Weakness covers bad matchups
      const wc = weaknessOf(core.card), wp = weaknessOf(g.card);
      if (wc && wp) s *= wc === wp ? 0.93 : 1.08;
      return { g, s, fits };
    })
    .sort((a, b) => b.s - a.s);
  const partner = partners.find(p => p.fits && p.s > core.attack * 0.45) || null;
  if (partner) {
    const pl = evolutionLine(pool, partner.g).filter(x => !x.missing);
    const pPlan = pl.length === 3 ? [2, 1, 2] : pl.length === 2 ? [2, 2] : [2];
    pl.forEach((g, i) => draft.add(g.name, pPlan[i] ?? 1, 'partner', i === pl.length - 1 ? `Second attacker (${partner.fits ? 'same Energy' : 'flexible'})` : `Evolves into ${pl[i + 1].name}`));
    for (const e of Object.keys(primaryEnergyNeeds(partner.g.card))) energyTypes.add(e);
    (partner.g.card.types || []).forEach(t => pokemonTypes.add(t));
  }

  // 3) Draw / search engine Pokémon (e.g. Pidgeot ex, Bibarel, Kirlia, Dudunsparce)
  const engines = pool.pokemon()
    .filter(g => g.roles.has('engine') && !draft.has(g.name) && lineBuildable(pool, g, hasCandy).ok)
    .map(g => {
      const t = cardText(g.card);
      let s = 20;
      if (/search your deck for (a|any) card/.test(t)) s += 25;
      if (/draw cards until you have (\d+)/.test(t)) s += 15 + parseInt(t.match(/until you have (\d+)/)[1], 10);
      if (/once during your turn/.test(t)) s += 5;
      if (prizeValue(g.card) > 1) s -= 6;
      if (stageRank(g.card) === 2) s -= 4;
      // Conditions: the engine must actually be able to run in this deck
      for (const ab of g.card.abilities || []) {
        const cond = abilityConditions(ab.effect);
        if (cond.discardType && !energyTypes.has(cond.discardType)) s -= 40;  // e.g. Lunatone needs Fighting Energy
        if (cond.attachedType && !energyTypes.has(cond.attachedType)) s -= 40;
        if (cond.needsInPlay && !pool.get(cond.needsInPlay)) s -= 40;          // partner card not owned
      }
      return { g, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  if (engines.length) {
    const eg = engines[0].g;
    const el = evolutionLine(pool, eg).filter(x => !x.missing);
    const ePlan = el.length === 3 ? [2, 1, 2] : el.length === 2 ? [3, 2] : [2];
    el.forEach((g, i) => draft.add(g.name, ePlan[i] ?? 1, 'engine', i === el.length - 1 ? 'Draw/search engine — keeps your hand full' : `Evolves into ${el[i + 1].name}`));
  }

  // 4) Accel / utility Pokémon that match the deck (1 copy each, max 2)
  const utilities = pool.pokemon()
    .filter(g => !draft.has(g.name) && isBasicPokemon(g.card) && (g.roles.has('accel') || g.roles.has('utility') || g.roles.has('starter')))
    .map(g => {
      const t = cardText(g.card);
      let s = 10;
      if (g.roles.has('accel')) s += [...energyTypes].some(e => t.includes(e.toLowerCase())) ? 15 : -10;
      if (g.roles.has('starter')) s += 6;
      if (prizeValue(g.card) > 1) s -= 5;
      if (isRadiant(g.card)) s += 3;
      for (const ab of g.card.abilities || []) {
        const cond = abilityConditions(ab.effect);
        if ((cond.discardType && !energyTypes.has(cond.discardType)) || (cond.attachedType && !energyTypes.has(cond.attachedType))) s -= 30; // e.g. Munkidori needs Darkness Energy
        if (cond.unreliable) s -= 4;
      }
      return { g, s };
    }).filter(x => x.s > 8).sort((a, b) => b.s - a.s).slice(0, 2);
  for (const u of utilities) draft.add(u.g.name, u.g.roles.has('accel') ? 2 : 1, 'utility', u.g.roles.has('accel') ? 'Energy acceleration' : u.g.roles.has('starter') ? 'Good opening Pokémon (sets up your Bench)' : 'Utility ability');

  // 4b) Named partners: a Pokémon in the deck whose text needs another Pokémon you own
  // (e.g. Lunatone "if you have Solrock in play") gets that Pokémon added.
  let synergyAdds = 0;
  for (const [name] of [...draft.counts]) {
    const c = pool.get(name).card;
    if (!isPokemon(c) || synergyAdds >= 2) continue;
    for (const g of pool.pokemon()) {
      if (draft.has(g.name) || !isBasicPokemon(g.card) || synergyAdds >= 2) continue;
      if (mentions(c, g.name)) { draft.add(g.name, 2, 'utility', `Works with ${c.name}`); synergyAdds++; }
    }
  }

  // 5) Trainers by role
  const pokemonCount = () => [...draft.counts].filter(([n]) => isPokemon(pool.get(n).card)).reduce((a, [, v]) => a + v.count, 0);
  const basicsCount = () => [...draft.counts].filter(([n]) => isBasicPokemon(pool.get(n).card)).reduce((a, [, v]) => a + v.count, 0);
  const deckPokemon = new Set([...draft.counts.keys()].filter(n => isPokemon(pool.get(n).card)));
  const ctx = {
    energyTypes, pokemonTypes, basicsHeavy: basicsCount() >= pokemonCount() * 0.55,
    deckPokemon, poolPokemonNames: pool.pokemon().map(g => g.name),
    families: new Set([...deckPokemon].map(familyOf).filter(Boolean)),
  };
  const roleTargets = [
    ['candy', top === 2 || draft.has('Rare Candy') ? 4 : 0, 'Lets Basics evolve straight to Stage 2'],
    ['search', 7, 'Finds your Pokémon'],
    ['draw', 9, 'Supporter that draws or searches'],
    ['gust', 3, 'Drags up your opponent\'s Benched Pokémon to take Prizes'],
    ['switch', 3, 'Gets out of the Active Spot'],
    ['accel', 3, 'Energy acceleration'],
    ['recovery', 2, 'Gets back Pokémon/Energy from the discard pile'],
    ['trainerSearch', 2, 'Finds the Item or Tool you need'],
    ['energySearch', 1, 'Finds Energy'],
    ['stadium', 2, 'Stadium'],
    ['tool', 3, 'Pokémon Tool'],
    ['aceSpec', 1, 'ACE SPEC (best one you own)'],
  ];
  const trainers = pool.trainers();
  const roleShort = [];
  for (const [role, target, why] of roleTargets) {
    if (!target) continue;
    let have = [...draft.counts].filter(([n]) => pool.get(n).roles.has(role)).reduce((a, [, v]) => a + v.count, 0);
    const opts2 = trainers.filter(g => g.roles.has(role)).map(g => ({ g, v: trainerValue(g, ctx) })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    for (const { g } of opts2) {
      if (have >= target) break;
      const perCard = role === 'draw' ? (/until you have|draw [4-9]/.test(g.card.effect.toLowerCase()) ? 4 : 3) : role === 'stadium' || role === 'tool' ? 2 : 4;
      have += draft.add(g.name, Math.min(perCard, target - have), role, why);
    }
    if (have < target && ['search', 'draw', 'gust', 'switch', 'candy'].includes(role)) roleShort.push({ role, have, target });
  }

  // 6) Energy
  const needs = {};
  const attackers = [...draft.counts].filter(([, v]) => v.role === 'core' || v.role === 'partner').map(([n]) => pool.get(n).card);
  let totalCost = 0, costCount = 0;
  for (const c of attackers) {
    for (const [e, k] of Object.entries(primaryEnergyNeeds(c))) needs[e] = (needs[e] || 0) + k * (c.name === core.name ? 2 : 1);
    for (const a of c.attacks) { totalCost += a.cost.length; costCount++; }
  }
  const avgCost = costCount ? totalCost / costCount : 2;
  const accelCount = [...draft.counts].filter(([n]) => pool.get(n).roles.has('accel')).reduce((a, [, v]) => a + v.count, 0);
  let energyTarget = Math.round(Math.min(14, Math.max(6, 4 + avgCost * 2.4 + (accelCount ? 1 : 0))));
  if (!Object.keys(needs).length) energyTarget = Math.min(energyTarget, 8); // colorless decks
  // Special energy that fits (e.g. Double Turbo / Jet / Reversal) — up to 3
  const specials = pool.energies().filter(g => !isBasicEnergy(g.card)).map(g => {
    const t = (g.card.effect || '').toLowerCase();
    let s = 5;
    if (/every type|provides? .*(2|two)/.test(t)) s += 8;
    if (/switch|move/.test(t)) s += 3;
    if (/only be attached to|can't be attached/.test(t)) {
      const ok = [...pokemonTypes].some(ty => t.includes(ty.toLowerCase()));
      s += ok ? 4 : -20;
    }
    if (/attacks .* do \d+ less damage/.test(t)) s -= 2;
    return { g, s };
  }).filter(x => x.s > 4).sort((a, b) => b.s - a.s);
  let energyIn = 0;
  for (const { g } of specials) { if (energyIn >= 3) break; energyIn += draft.add(g.name, Math.min(2, 3 - energyIn), 'energy', 'Special Energy'); }
  const typeList = Object.keys(needs).length ? Object.entries(needs).sort((a, b) => b[1] - a[1]) : [[(core.card.types || [])[0] || 'Colorless', 1]];
  const weightSum = typeList.reduce((a, [, w]) => a + w, 0);
  const basicTarget = Math.max(0, energyTarget - energyIn);
  let allocated = 0;
  typeList.forEach(([type, w], i) => {
    const want = i === typeList.length - 1 ? basicTarget - allocated : Math.round(basicTarget * w / weightSum);
    allocated += want;
    if (type === 'Colorless' || type === 'Dragon') {
      // Colorless/Dragon attackers: use any basic energy the user owns most of
      const owned = pool.energies().filter(g => isBasicEnergy(g.card)).sort((a, b) => b.qty - a.qty)[0];
      if (owned) { draft.add(owned.name, want, 'energy', 'Energy for Colorless costs'); return; }
      return;
    }
    const ownedName = pool.all().find(g => isBasicEnergy(g.card) && energyTypeOf(g.card) === type)?.name;
    let got = ownedName ? draft.add(ownedName, want, 'energy', `${type} Energy for your attackers`) : 0;
    if (got < want && opts.assumeBasicEnergy) got += draft.addVirtualEnergy(type, want - got);
    if (got < want) notes.push({ type: 'short', msg: `Only ${got} ${type} Energy available — ${want} recommended.` });
  });

  // 7) Fill to 60 — never with cards that can't work here (an evolution without its
  // pre-evolution, Rare Candy without a Stage 2).
  const hasStage2 = () => [...draft.counts].some(([n]) => isPokemon(pool.get(n).card) && stageRank(pool.get(n).card) === 2);
  const usable = g => {
    if (g.roles.has('candy') && !hasStage2()) return false;
    if (isPokemon(g.card) && !isBasicPokemon(g.card) && !draft.has(g.card.evolveFrom)) return false;
    return true;
  };
  const fillers = [];
  // More copies of key pieces first
  for (const [name, v] of draft.counts) {
    const g = pool.get(name);
    if (v.role === 'core' && isPokemon(g.card)) fillers.push({ name, n: 4, p: 90 });
    if (['search', 'draw'].includes(v.role)) fillers.push({ name, n: 4, p: 80 });
    if (['gust', 'switch', 'recovery'].includes(v.role)) fillers.push({ name, n: 3, p: 55 });
  }
  // Other good trainers not yet included
  for (const g of trainers) {
    if (draft.has(g.name)) continue;
    const v = trainerValue(g, ctx);
    if (g.roles.has('stadium') || g.roles.has('tool')) fillers.push({ name: g.name, n: 1, p: 30 + v / 4, role: [...g.roles][0] || 'trainer' });
    else if (g.roles.size) fillers.push({ name: g.name, n: 2, p: 35 + v / 3, role: [...g.roles][0] });
    else if (v > 0) fillers.push({ name: g.name, n: 1, p: 15 + v / 4, role: 'trainer' });
  }
  // Partner/extra attackers of matching type
  for (const p of partners.slice(0, 6)) if (p.fits && !draft.has(p.g.name) && isBasicPokemon(p.g.card)) fillers.push({ name: p.g.name, n: 2, p: 25 + p.s / 10, role: 'partner' });
  fillers.sort((a, b) => b.p - a.p);
  for (const f of fillers) {
    if (draft.total() >= 60) break;
    if (!usable(pool.get(f.name))) continue;
    const cur = draft.count(f.name);
    draft.add(f.name, Math.max(0, f.n - cur), f.role || draft.counts.get(f.name)?.role || 'extra', 'Extra consistency');
  }
  // Still short: more basic energy (cheap and safe), then anything legal.
  if (draft.total() < 60) {
    const mainType = typeList[0][0];
    const ownedName = pool.all().find(g => isBasicEnergy(g.card) && energyTypeOf(g.card) === mainType)?.name;
    const extraE = Math.min(4, 60 - draft.total());
    let got = ownedName ? draft.add(ownedName, extraE, 'energy', `${mainType} Energy`) : 0;
    if (got < extraE && opts.assumeBasicEnergy && BASIC_ENERGY_TYPES.includes(mainType)) draft.addVirtualEnergy(mainType, extraE - got);
  }
  if (draft.total() < 60) {
    const rest = pool.all().filter(g => !isBasicEnergy(g.card))
      .map(g => ({ g, s: isTrainer(g.card) ? trainerValue(g, ctx) : isPokemon(g.card) ? (g.attack / 4 + ((g.card.types || []).some(t => pokemonTypes.has(t)) ? 15 : 0)) : 0 }))
      .sort((a, b) => b.s - a.s);
    for (const { g } of rest) { if (draft.total() >= 60) break; if (usable(g)) draft.add(g.name, 2, 'filler', 'Filler — best remaining card you own'); }
  }

  // 8) Trim if over 60 (shouldn't happen, but keep it safe)
  while (draft.total() > 60) {
    const order = ['filler', 'extra', 'trainer', 'tool', 'stadium', 'utility'];
    let done = false;
    for (const r of order) {
      const hit = [...draft.counts].find(([, v]) => v.role === r);
      if (hit) { draft.remove(hit[0], 1); done = true; break; }
    }
    if (!done) break;
  }

  return finishDeck(draft, core, partner?.g, notes, roleShort, opts);
}

function finishDeck(draft, core, partner, notes, roleShort, opts) {
  const pool = draft.pool;
  const entries = [];
  for (const [name, v] of draft.counts) {
    const g = pool.get(name);
    // Spread copies across the printings you own (most-owned first)
    let left = v.count;
    for (const p of g.printings) {
      if (!left) break;
      const k = Math.min(left, p.qty);
      entries.push({ card: p.card, count: k, role: v.role, reason: v.reason });
      left -= k;
    }
  }
  const order = { core: 0, partner: 1, engine: 2, utility: 3 };
  entries.sort((a, b) => {
    const ca = a.card.category, cb = b.card.category;
    const cat = { Pokemon: 0, Trainer: 1, Energy: 2 };
    if (ca !== cb) return cat[ca] - cat[cb];
    if (ca === 'Pokemon') return (order[a.role] ?? 5) - (order[b.role] ?? 5) || stageRank(a.card) - stageRank(b.card) || a.card.name.localeCompare(b.card.name);
    if (ca === 'Trainer') {
      const tt = { Supporter: 0, Item: 1, Tool: 2, 'Pokémon Tool': 2, Stadium: 3 };
      return (tt[a.card.trainerType] ?? 2) - (tt[b.card.trainerType] ?? 2) || b.count - a.count || a.card.name.localeCompare(b.card.name);
    }
    return b.count - a.count;
  });

  // Name from the final list (the optimizer may have changed the second attacker)
  const partnerNames = entries.filter(e => e.role === 'partner' && isPokemon(e.card) && !entries.some(x => x.card.evolveFrom === e.card.name)).map(e => e.card.name);
  const pName = partner && partnerNames.includes(partner.name) ? partner.name : partnerNames[0];
  const name = pName ? `${core.name} / ${pName}` : core.name;
  const deck = {
    id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, core: core.name, format: opts.format, entries,
    coreAttack: core.attack, coreQty: core.qty, notes: notes.map(n => n.msg), roleShort, created: new Date().toISOString(),
  };
  // Builder context for the optimizer (not saved with the deck)
  Object.defineProperty(deck, '_ctx', { value: { pool, core, partner, draft, notes, roleShort, opts }, enumerable: false });
  refreshDeck(deck, n => pool.get(n)?.card, { games: 1200 });
  return deck;
}

// Recompute everything derived from the card list (after building, optimizing or a manual edit).
function refreshDeck(deck, lookup = () => null, { games = 2000 } = {}) {
  deck.entries = deck.entries.filter(e => e.count > 0);
  deck.stats = deckStats(deck.entries);
  deck.issues = validateDeck(deck.entries, deck.format, lookup);
  // Simulate even mid-edit (e.g. 59 cards) so the numbers react as you change counts
  deck.sim = typeof simulateDeck === 'function' && deck.stats.total >= 40 ? simulateDeck(deck.entries, deck.core, { games, seed: 5 }) : null;
  deck.score = scoreDeck({ attack: deck.coreAttack ?? 80, qty: deck.coreQty ?? 4 }, deck.stats, deck.issues, deck.sim);
  deck.advice = buildAdvice(deck);
  return deck;
}

function deckStats(entries, pool) {
  const sum = f => entries.filter(e => f(e.card, e)).reduce((a, e) => a + e.count, 0);
  const roleOf = c => (pool?.get(c.name)?.roles) || (isTrainer(c) ? trainerRoles(c) : isPokemon(c) ? pokemonRoles(c) : new Set());
  const total = sum(() => true);
  const pokemon = sum(isPokemon), trainers = sum(isTrainer), energy = sum(isEnergy);
  const basics = sum(isBasicPokemon);
  const search = sum(c => isTrainer(c) && roleOf(c).has('search'));
  const draw = sum(c => isTrainer(c) && roleOf(c).has('draw'));
  const gust = sum(c => isTrainer(c) && roleOf(c).has('gust'));
  const switching = sum(c => isTrainer(c) && roleOf(c).has('switch'));
  const supporters = sum(c => c.trainerType === 'Supporter');
  const outs = search + draw; // cards that dig for what you need
  const prizesAvg = pokemon ? entries.filter(e => isPokemon(e.card)).reduce((a, e) => a + prizeValue(e.card) * e.count, 0) / pokemon : 0;
  return {
    total, pokemon, trainers, energy, basics, search, draw, gust, switching, supporters, prizesAvg,
    mulligan: total === 60 ? 1 - pAtLeastOne(basics) : null,
    openWithOut: total === 60 ? pAtLeastOne(outs + basics * 0) : null,
    openWithSupporter: total === 60 ? pAtLeastOne(supporters) : null,
    virtualEnergy: entries.filter(e => e.card.virtual).reduce((a, e) => a + e.count, 0),
  };
}

function scoreDeck(core, s, issues, sim) {
  // 0-100. Power (main attacker), consistency, structure, legality.
  // Consistency comes from play-testing when the simulator ran; otherwise from card counts.
  const power = (45 * core.attack / (core.attack + 110)) * Math.min(1, (core.qty + 1) / 4);
  const cons = sim
    ? 30 * Math.min(1, sim.objective / 0.8) + Math.min(5, s.gust * 2) + Math.min(3, s.switching * 1.5)
    : Math.min(12, s.search * 1.6) + Math.min(12, s.draw * 1.4) + Math.min(5, s.gust * 2) + Math.min(4, s.switching * 1.5) + (s.basics >= 8 ? 5 : s.basics * 0.6);
  let structure = 15;
  if (s.energy < 6 || s.energy > 15) structure -= 5;
  if (s.pokemon > 24) structure -= 5;
  if (s.trainers < 26) structure -= Math.min(8, (26 - s.trainers) * 0.5);
  const errors = issues.filter(i => i.level === 'error').length;
  const total = power + cons + structure - errors * 10 - issues.filter(i => i.level === 'warn').length * 2;
  return Math.max(0, Math.min(100, Math.round(total)));
}

const ROLE_HINTS = {
  search: 'Pokémon search Items such as Ultra Ball, Buddy-Buddy Poffin or a type-specific search card',
  draw: 'draw Supporters such as Lillie\'s Determination, Hilda, Dawn or Carmine',
  gust: 'gust cards such as Boss\'s Orders or Prime Catcher',
  switch: 'switching cards such as Switch or Switch Cart',
  candy: 'more Rare Candy (Stage 2 decks usually play 3-4)',
};

function buildAdvice(deck) {
  const s = deck.stats, entries = deck.entries, sim = deck.sim;
  const out = [];
  const pct = v => Math.round(v * 100) + '%';
  if (deck.optimizer?.summary?.length) {
    const ch = deck.optimizer.summary.map(x => `${x.delta > 0 ? '+' : '−'}${Math.abs(x.delta)} ${x.name}`).join(', ');
    const o = deck.optimizer;
    out.push({ level: 'good', msg: `Tuned by play-testing: ${ch}. Main attacker ready by turn 2: ${pct(o.t2[0])} → ${pct(o.t2[1])}; by turn 3: ${pct(o.t3[0])} → ${pct(o.t3[1])}.` });
  }
  if (sim) {
    if (sim.byTurn2 < 0.35) out.push({ level: 'warn', msg: `The main attacker is ready on turn 2 in only ${pct(sim.byTurn2)} of games. More search cards, or more copies of the line, would speed it up.` });
    if (sim.byTurn4 < 0.7) out.push({ level: 'warn', msg: `In ${pct(1 - sim.byTurn4)} of games the main attacker still can't attack by turn 4 — the deck stalls too often.` });
    if (sim.backupByTurn4 < 0.3) out.push({ level: 'info', msg: `A second attacker is set up by turn 4 in only ${pct(sim.backupByTurn4)} of games — once the first one is Knocked Out you may have nothing ready.` });
  }
  for (const msg of deck.notes || []) out.push({ level: 'warn', msg });
  const ROLE_NAMES = { candy: 'Rare Candy', search: 'Pokémon search Items', draw: 'draw/search Supporters', gust: 'gust cards', switch: 'switching cards' };
  for (const r of deck.roleShort || []) out.push({ level: 'warn', msg: `Only ${r.have} ${ROLE_NAMES[r.role] || r.role} (aim for ${r.target}). Pick up ${ROLE_HINTS[r.role]}.` });
  // Weakness spread across the attackers
  const attackers = entries.filter(e => isPokemon(e.card) && ['core', 'partner'].includes(e.role) && !entries.some(x => x.card.evolveFrom === e.card.name));
  const weak = [...new Set(attackers.map(e => weaknessOf(e.card)).filter(Boolean))];
  if (attackers.length > 1 && weak.length === 1) out.push({ level: 'info', msg: `All your attackers are weak to ${weak[0]} — ${weak[0]} decks will be a tough matchup.` });
  if (s.basics < 8) out.push({ level: 'warn', msg: `Only ${s.basics} Basic Pokémon — you'll mulligan ${(s.mulligan * 100 || 0).toFixed(0)}% of games. Aim for 8-12.` });
  if (s.virtualEnergy) out.push({ level: 'info', msg: `Includes ${s.virtualEnergy} basic Energy you haven't logged — basic Energy is easy to get, so it's assumed.` });
  if (s.prizesAvg > 1.6) out.push({ level: 'info', msg: 'Mostly multi-Prize Pokémon: your opponent needs fewer KOs. Single-Prize attackers help the prize trade.' });
  if (s.trainers < 28) out.push({ level: 'info', msg: `${s.trainers} Trainers is light — competitive decks play 30+ for consistency.` });
  const filler = entries.filter(e => e.role === 'filler').reduce((a, e) => a + e.count, 0);
  if (filler) out.push({ level: 'warn', msg: `${filler} cards are filler because your collection ran out of better options.` });
  if (!out.some(a => a.level !== 'info' && a.level !== 'good')) out.push({ level: 'good', msg: 'Solid structure. Test it and tune the counts to your play style.' });
  return out;
}

// Main entry: generate the best few decks from a collection.
function generateDecks(collectionEntries, opts = {}) {
  opts = { format: 'standard', assumeBasicEnergy: true, focus: '', count: 3, ...opts };
  const pool = new Pool(collectionEntries, opts.format);
  const hasCandy = !!pool.get('Rare Candy');
  let candidates = pool.pokemon()
    .filter(g => g.attack > 0 && lineBuildable(pool, g, hasCandy).ok)
    .filter(g => !(isRadiant(g.card)))
    // A main attacker you own 1 copy of rarely gets going — weight by copies owned.
    .map(g => ({ g, rank: g.attack * Math.min(1, (g.qty + 1) / 4) }))
    .sort((a, b) => b.rank - a.rank)
    .map(x => x.g);
  if (opts.focus) {
    const f = candidates.filter(g => g.name.toLowerCase().includes(opts.focus.toLowerCase()));
    if (f.length) candidates = f;
  }
  if (opts.energyType) {
    const f = candidates.filter(g => (g.card.types || []).includes(opts.energyType));
    if (f.length) candidates = f;
  }
  if (!candidates.length) return { decks: [], pool, reason: pool.pokemon().length ? 'None of your Pokémon have a complete evolution line in this format.' : 'No Pokémon legal in this format in your collection yet.' };
  // Avoid building around the middle of the same evolution line twice
  const inLines = new Set(), cores = new Set();
  const decks = [];
  for (const g of candidates.slice(0, 12)) {
    const lineNames = evolutionLine(pool, g).filter(x => !x.missing).map(x => x.name);
    if (inLines.has(g.name) || lineNames.some(n => cores.has(n))) continue;
    lineNames.forEach(n => inLines.add(n));
    cores.add(g.name);
    decks.push(buildAroundCore(pool, g, opts));
  }
  decks.sort((a, b) => b.score - a.score);
  // De-duplicate decks with the same name
  // (same pair of attackers in either order counts as the same deck)
  const key = d => d.name.split(' / ').sort().join('|');
  const uniq = [];
  for (const d of decks) if (!uniq.find(u => key(u) === key(d))) uniq.push(d);
  return { decks: uniq.slice(0, opts.count), pool };
}

// ---------- Rotation ----------
// Standard rotates every spring, removing the oldest regulation mark. The 2026 rotation removed G
// (announced Jan 9 2026, in effect Apr 10 2026). The next one is NOT announced yet; following the
// pattern it is expected to remove H around April 2027. Update this when it's announced.
const NEXT_ROTATION = { marks: ['H'], when: 'around April 2027', confirmed: false };

function rotationReport(entries, collectionEntries = []) {
  const rotating = entries.filter(e => !e.card.virtual && NEXT_ROTATION.marks.includes(e.card.regulationMark) && e.card.legal?.standard);
  if (!rotating.length) return { count: 0, cards: [] };
  // Replacements: cards you own with a newer mark that do the same job
  const safe = collectionEntries.filter(({ card }) => card.legal?.standard && !NEXT_ROTATION.marks.includes(card.regulationMark));
  const inDeck = new Set(entries.map(e => e.card.name));
  const cards = [];
  const seen = new Set();
  for (const e of rotating) {
    if (seen.has(e.card.name)) continue;
    seen.add(e.card.name);
    const count = rotating.filter(x => x.card.name === e.card.name).reduce((a, x) => a + x.count, 0);
    // A reprint with a newer mark keeps the card legal
    const reprint = safe.find(({ card }) => card.name === e.card.name);
    let replacements = [];
    if (!reprint) {
      if (isTrainer(e.card)) {
        // Match on the card's main job (Prime Catcher is a gust card first, a switch second)
        const order = ['gust', 'candy', 'search', 'draw', 'accel', 'energySearch', 'trainerSearch', 'recovery', 'switch', 'disrupt', 'heal', 'damage', 'stadium', 'tool'];
        const main = c => order.find(r => trainerRoles(c).has(r));
        const job = main(e.card);
        replacements = job ? safe.filter(({ card }) => isTrainer(card) && card.name !== e.card.name && main(card) === job) : [];
      } else if (isPokemon(e.card) && ['core', 'partner'].includes(e.role)) {
        // Attackers only: a same-type attacker of the same stage that hits about as hard
        const power = attackerScore(e.card);
        replacements = safe.filter(({ card }) => isPokemon(card) && card.name !== e.card.name && (card.types || [])[0] === (e.card.types || [])[0] && stageRank(card) === stageRank(e.card) && attackerScore(card) >= power * 0.7)
          .sort((a, b) => attackerScore(b.card) - attackerScore(a.card));
      } else if (isEnergy(e.card)) {
        replacements = safe.filter(({ card }) => isEnergy(card) && !isBasicEnergy(card));
      }
    }
    const names = [...new Set(replacements.map(r => r.card.name))].filter(n => !inDeck.has(n) || isTrainer(e.card)).slice(0, 3);
    cards.push({ name: e.card.name, count, reprint: !!reprint, replacements: names });
  }
  return { count: rotating.reduce((a, e) => a + e.count, 0), cards };
}

// Smarter entry point: build candidate decks, then play-test each one and let the optimizer
// tune the card counts. Async so the page stays responsive.
async function generateDecksSmart(collectionEntries, opts = {}, onProgress = () => {}) {
  const want = opts.count || 3;
  const res = generateDecks(collectionEntries, { ...opts, count: want + 1 });
  if (!res.decks.length || typeof optimizeDeck !== 'function') return { ...res, decks: res.decks.slice(0, want) };
  const out = [];
  for (let i = 0; i < res.decks.length; i++) {
    const d = res.decks[i];
    const ctx = d._ctx;
    onProgress(`Play-testing deck ${i + 1} of ${res.decks.length}: ${d.name}…`, i / res.decks.length);
    const opt = await optimizeDeck(ctx, p => onProgress(`Play-testing deck ${i + 1} of ${res.decks.length}: ${d.name}… ${Math.round(p * 100)}%`, (i + p) / res.decks.length));
    let deck = d;
    if (opt && opt.summary.length && opt.after > opt.before + 0.01) {
      const draft = new DeckDraft(ctx.pool, ctx.opts);
      draft.counts = opt.counts;
      deck = finishDeck(draft, ctx.core, ctx.partner, ctx.notes, ctx.roleShort, ctx.opts);
      deck.optimizer = {
        summary: opt.summary,
        t2: [opt.beforeSim.byTurn2, opt.afterSim.byTurn2], t3: [opt.beforeSim.byTurn3, opt.afterSim.byTurn3],
      };
    }
    refreshDeck(deck, n => ctx.pool.get(n)?.card, { games: 3000 });
    out.push(deck);
  }
  out.sort((a, b) => b.score - a.score);
  return { decks: dedupeDecks(out).slice(0, want), pool: res.pool };
}

// Two decks built around mostly the same Pokémon are really one deck: keep the better one.
function dedupeDecks(decks) {
  const pokeNames = d => new Set(d.entries.filter(e => isPokemon(e.card) && ['core', 'partner'].includes(e.role)).map(e => e.card.name));
  const kept = [];
  for (const d of decks) {
    const a = pokeNames(d);
    const dup = kept.some(k => {
      const b = pokeNames(k);
      const inter = [...a].filter(n => b.has(n)).length;
      return inter / Math.min(a.size, b.size || 1) >= 0.6;
    });
    if (!dup) kept.push(d);
  }
  return kept;
}

// PTCGL / Limitless text export
function exportDeckText(deck, setCode) {
  const groups = { Pokemon: [], Trainer: [], Energy: [] };
  for (const e of deck.entries) groups[e.card.category]?.push(e);
  const line = e => e.card.virtual ? `${e.count} Basic ${e.card.types[0]} Energy SVE` : `${e.count} ${e.card.name} ${setCode(e.card.setId)} ${parseInt(e.card.localId, 10) || e.card.localId}`;
  const sum = arr => arr.reduce((a, e) => a + e.count, 0);
  return [
    `Pokémon: ${sum(groups.Pokemon)}`, ...groups.Pokemon.map(line), '',
    `Trainer: ${sum(groups.Trainer)}`, ...groups.Trainer.map(line), '',
    `Energy: ${sum(groups.Energy)}`, ...groups.Energy.map(line), '',
    `Total Cards: ${sum(deck.entries)}`,
  ].join('\n');
}

if (typeof module !== 'undefined') module.exports = { RULES, generateDecks, validateDeck, deckStats, attackerScore, prizeValue, trainerRoles, pokemonRoles, exportDeckText, isBasicPokemon, isBasicEnergy, pAtLeastOne };
