// Wrong-scan reports: the photo the scanner saw, what it guessed, and what the card really was.
// Kept on this device (IndexedDB — photos are too big for localStorage) and, when signed in,
// sent to your account so they can be used to improve the scanner.
'use strict';

const ScanReports = {
  _db: null,
  db() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      const req = indexedDB.open('deck-forge', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('reports', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this._db.catch(() => { this._db = null; });
    return this._db;
  },
  async tx(mode, fn) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction('reports', mode);
      const out = fn(t.objectStore('reports'));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  },
  // kind: 'reported' (tapped "Wrong card?") or 'picked-other' (added a different match than the
  // scanner's first pick — a quiet signal that it got it wrong)
  async save({ kind, photo, res, correct }) {
    const blob = photo ? await toJpeg(photo, 900, 0.82) : null;
    const rec = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), kind,
      guess: (res?.results || []).slice(0, 5).map(c => ({ id: c.id, name: c.name })),
      correctId: correct.id, correctName: correct.name,
      details: { readName: res?.readName || null, number: res?.num?.text || null, confident: !!res?.confident, located: res?.cropped || null, app: document.querySelector('script[src*="scanner.js"]')?.src.split('v=')[1] || '' },
      photo: blob, sent: false,
    };
    await this.tx('readwrite', s => s.put(rec));
    window.Sync?.sendReports();
    return rec;
  },
  async all() { return (await this.tx('readonly', s => s.getAll())) || []; },
  async markSent(id, path) {
    await this.tx('readwrite', s => {
      const g = s.get(id);
      g.onsuccess = () => { if (g.result) s.put({ ...g.result, sent: true, photoPath: path }); };
    });
  },
  async counts() {
    try { const a = await this.all(); return { total: a.length, sent: a.filter(r => r.sent).length }; } catch (e) { return { total: 0, sent: 0 }; }
  },
  // One file with every report and its photo (for sharing when not signed in)
  async download() {
    const list = await this.all();
    const out = [];
    for (const r of list) out.push({ ...r, photo: r.photo ? await blobToDataUrl(r.photo) : null });
    const blob = new Blob([JSON.stringify({ app: 'deck-forge', kind: 'scan-reports', exported: new Date().toISOString(), reports: out })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `deck-forge-scan-reports-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return list.length;
  },
};

function toJpeg(canvas, maxW, q) {
  const s = Math.min(1, maxW / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', q));
}
function blobToDataUrl(blob) {
  return new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
}
