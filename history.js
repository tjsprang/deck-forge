// Value over time + scan history. Both are small, kept in localStorage and included in the
// online backup (sync.js merges them between devices).
'use strict';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

// ---------- Collection value, one point a day ----------
// value: [[day, totalCents, cardCount, recordedAt], ...] oldest first
// prices: { "<collection key>": [[day, cents], ...] } — a point only when the price changed
const ValueHistory = {
  key: 'df.history.v1',
  data: null,
  load() {
    if (!this.data) {
      try { this.data = JSON.parse(localStorage.getItem(this.key) || 'null'); } catch (e) { this.data = null; }
      if (!this.data || !Array.isArray(this.data.value)) this.data = { value: [], prices: {} };
    }
    return this.data;
  },
  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { /* storage full: keep in memory */ }
    window.Sync?.markDirty();
  },
  // Record today's value. Only when (nearly) every card has a price, or a missing price would
  // look like a crash in value.
  record(entries) {
    if (!entries.length) return false;
    const priceOf = e => Prices.value(Prices.forVersion(e.card.id, e.version));
    const fresh = entries.filter(e => e.card.virtual || Prices.get(e.card.id));
    if (fresh.length < entries.length * 0.97) return false;
    const d = this.load(), day = today();
    let total = 0, count = 0;
    for (const e of entries) {
      const p = priceOf(e);
      count += e.qty;
      if (p == null) continue;
      total += p * e.qty;
      const cents = Math.round(p * 100);
      const pts = d.prices[e.key] || (d.prices[e.key] = []);
      const last = pts[pts.length - 1];
      if (last && last[0] === day) last[1] = cents;
      else if (!last || last[1] !== cents) pts.push([day, cents]);
    }
    const point = [day, Math.round(total * 100), count, Date.now()];
    const last = d.value[d.value.length - 1];
    if (last && last[0] === day) {
      if (last[1] === point[1] && last[2] === point[2]) return false; // nothing new
      d.value[d.value.length - 1] = point;
    } else d.value.push(point);
    this.prune();
    this.save();
    return true;
  },
  prune() {
    const d = this.data, cutoff = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    d.value = d.value.filter(p => p[0] >= cutoff);
    const owned = new Set(Object.keys(Collection.data.qty));
    for (const k of Object.keys(d.prices)) {
      if (!owned.has(k)) { delete d.prices[k]; continue; }
      // keep one point from before the cutoff so older changes still have a starting price
      const pts = d.prices[k];
      while (pts.length > 1 && pts[1][0] < cutoff) pts.shift();
    }
  },
  // Price of a collection entry on (or just before) a given day
  priceOn(key, day) {
    const pts = this.load().prices[key];
    if (!pts?.length) return null;
    let v = null;
    for (const [d, c] of pts) { if (d <= day) v = c; else break; }
    return v;
  },
  // Biggest changes in value since `days` ago (uses the oldest known price if newer than that)
  movers(entries, days) {
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const out = [];
    for (const e of entries) {
      const pts = this.load().prices[e.key];
      if (!pts?.length) continue;
      const now = Prices.value(Prices.forVersion(e.card.id, e.version));
      if (now == null) continue;
      const then = (this.priceOn(e.key, since) ?? pts[0][1]) / 100;
      const change = now - then;
      if (Math.abs(change) < 0.01) continue;
      out.push({ e, then, now, change, total: change * e.qty, pct: then ? change / then : null });
    }
    return {
      up: out.filter(x => x.change > 0).sort((a, b) => b.total - a.total).slice(0, 5),
      down: out.filter(x => x.change < 0).sort((a, b) => a.total - b.total).slice(0, 5),
    };
  },
  // Combine two copies (from two devices): every day from both; for the same day, the later reading
  merge(a, b) {
    const out = { value: [], prices: {} };
    const days = new Map();
    for (const p of [...(a?.value || []), ...(b?.value || [])]) if (!days.has(p[0]) || (p[3] || 0) > (days.get(p[0])[3] || 0)) days.set(p[0], p);
    out.value = [...days.values()].sort((x, y) => x[0].localeCompare(y[0]));
    for (const k of new Set([...Object.keys(a?.prices || {}), ...Object.keys(b?.prices || {})])) {
      const m = new Map();
      for (const p of [...(a?.prices?.[k] || []), ...(b?.prices?.[k] || [])]) m.set(p[0], p);
      out.prices[k] = [...m.values()].sort((x, y) => x[0].localeCompare(y[0]));
    }
    return out;
  },
};

// ---------- Cards added from scans (last 30), with undo ----------
const ScanLog = {
  key: 'df.scanlog.v1',
  max: 30,
  list() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (e) { return []; } },
  write(list) {
    try { localStorage.setItem(this.key, JSON.stringify(list.slice(0, this.max))); } catch (e) { /* ignore */ }
    window.Sync?.markDirty();
  },
  add(card, version, n) {
    const list = this.list();
    list.unshift({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(),
      key: Collection.keyOf(card.id, version), cardId: card.id, name: card.name, setName: card.setName,
      number: card.localId + (card.setTotal ? '/' + card.setTotal : ''), version, n, img: cardImage(card) || '', undone: false,
    });
    this.write(list);
  },
  // Take the copies back out of the collection (only as many as are still there)
  undo(id) {
    const list = this.list(), e = list.find(x => x.id === id);
    if (!e || e.undone) return 0;
    const have = Collection.data.qty[e.key] || 0;
    const k = Math.min(e.n, have);
    if (k) Collection.setQty(e.key, have - k);
    e.undone = true; e.undoneN = k;
    this.write(list);
    return k;
  },
  redo(id) {
    const list = this.list(), e = list.find(x => x.id === id);
    if (!e || !e.undone) return false;
    const card = Collection.data.cards[e.cardId] || lastResults.find(c => c.id === e.cardId);
    if (!card) return false;
    this.quiet = true; // not a new scan
    try { Collection.add(card, e.undoneN ?? e.n, e.version); } finally { this.quiet = false; }
    e.undone = false;
    this.write(list);
    return true;
  },
  merge(a, b) {
    const m = new Map();
    for (const e of [...(a || []), ...(b || [])]) {
      const x = m.get(e.id);
      // an undo on either device wins
      if (!x || (e.undone && !x.undone)) m.set(e.id, e);
    }
    return [...m.values()].sort((x, y) => y.at - x.at).slice(0, this.max);
  },
};
