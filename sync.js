// Online backup + sync between devices (Supabase — the same accounts as Frisbee Stats).
//
// Safety rules (nothing you've scanned may ever be lost):
//  • Signing in, out or syncing never empties this device: cards stay here.
//  • Before anything from your account replaces what's on this device, a copy of this device's
//    data is saved first (Account → Earlier copies).
//  • Your account keeps a daily snapshot that the app can't change or delete.
//  • Changes from two devices are merged card by card. Only a count that changed on one device
//    and not the other is taken as is; if both changed, the higher count wins.
//  • The first time a device that already has cards signs in, you choose whether to add them.
'use strict';

const SUPABASE_URL = 'https://rjpqplseazvxzakakngh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_gAzJjWvSQmVd4tmyxYLwxg_9GirzS_0';

const strHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const sortedJson = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
const deviceName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows PC' : 'Browser'; };
const cardCount = qty => Object.values(qty || {}).reduce((a, b) => a + b, 0);
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
const when = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------- Copies kept on this device ----------
const LocalBackups = {
  key: 'df.backups.v1',
  max: 6,
  list() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (e) { return []; } },
  add(reason) {
    const qty = { ...Collection.data.qty }, decks = SavedDecks.list();
    if (!cardCount(qty) && !decks.length) return;
    const list = this.list();
    const sig = strHash(sortedJson(qty) + JSON.stringify(decks.map(d => d.id)));
    if (list[0]?.sig === sig) return; // same as the last copy
    // Full card details when they fit; otherwise just ids + counts (details are re-downloaded)
    const cards = JSON.stringify(Collection.data.cards).length < 350000 ? Collection.data.cards : null;
    list.unshift({ at: Date.now(), reason, sig, qty, cards, decks });
    for (let n = list.length; n > 0; n--) {
      try { localStorage.setItem(this.key, JSON.stringify(list.slice(0, Math.min(n, this.max)))); return; }
      catch (e) { if (list[n - 1]) list[n - 1].cards = null; } // storage full: drop details, then oldest copies
    }
  },
};

// ---------- Merging two copies ----------
function mergePayloads(local, cloud, base) {
  const lq = local.collection?.qty || {}, cq = cloud.collection?.qty || {}, bq = base?.qty;
  const qty = {};
  for (const k of new Set([...Object.keys(lq), ...Object.keys(cq)])) {
    const l = lq[k] || 0, c = cq[k] || 0;
    let v;
    if (!bq) v = Math.max(l, c);           // no shared starting point: never drop a card
    else {
      const b = bq[k] || 0;
      v = l === b ? c : c === b ? l : Math.max(l, c);
    }
    if (v > 0) qty[k] = v;
  }
  const cards = {};
  for (const k of Object.keys(qty)) {
    const id = k.split('~')[0];
    if (cards[id]) continue;
    const a = local.collection?.cards?.[id], b = cloud.collection?.cards?.[id];
    cards[id] = (a?.versions?.length || !b) ? (a || b) : b;
  }
  // Decks: one changed and the other didn't → take the change (a deletion counts); both → keep local
  const ld = new Map((local.decks || []).map(d => [d.id, d])), cd = new Map((cloud.decks || []).map(d => [d.id, d]));
  const bd = base?.decks;
  const decks = [];
  for (const id of new Set([...ld.keys(), ...cd.keys()])) {
    const l = ld.get(id), c = cd.get(id);
    const lh = l && strHash(JSON.stringify(l)), ch = c && strHash(JSON.stringify(c)), bh = bd?.[id];
    let keep;
    if (!bd) keep = l || c;
    else if (lh === bh) keep = c;          // unchanged here: whatever the account has (or deleted)
    else if (ch === bh) keep = l;          // unchanged there
    else keep = l || c;
    if (keep) decks.push(keep);
  }
  return {
    v: 1, collection: { cards, qty }, decks,
    history: ValueHistory.merge(local.history, cloud.history),
    scanLog: ScanLog.merge(local.scanLog, cloud.scanLog),
    savedAt: new Date().toISOString(),
  };
}
const syncSig = p => strHash(sortedJson(p.collection?.qty) + JSON.stringify(p.decks || []) + JSON.stringify(p.history?.value || []) + JSON.stringify((p.scanLog || []).map(e => e.id + e.undone)) + Object.keys(p.history?.prices || {}).length);

// ---------- Sync ----------
const Sync = {
  sb: null, user: null, status: 'off', message: '', seq: 0, timer: null, applying: false,
  metaKey: 'df.sync.v1',
  meta() { try { return JSON.parse(localStorage.getItem(this.metaKey) || '{}'); } catch (e) { return {}; } },
  setMeta(m) { try { localStorage.setItem(this.metaKey, JSON.stringify(m)); } catch (e) { /* ignore */ } },

  init() {
    renderAccountButton();
    if (!window.supabase?.createClient) { this.setStatus('nolib'); return; }
    // Keeps the login in this browser and refreshes it automatically
    this.sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    this.sb.auth.onAuthStateChange((event, s) => {
      const changed = (s?.user?.id || null) !== (this.user?.id || null);
      this.user = s?.user || null;
      if (event === 'PASSWORD_RECOVERY') { this.recovering = true; setTimeout(openAccount, 0); }
      if (!changed) return;
      setTimeout(() => { // don't call Supabase from inside this callback
        this.setStatus(this.user ? 'idle' : 'off');
        if (this.user) this.syncNow('sign-in');
      }, 0);
    });
    window.addEventListener('online', () => this.user && this.syncNow('online'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.user && Date.now() - (this.meta().lastOk || 0) > 60000) this.syncNow('return');
    });
  },
  payload() {
    return { v: 1, collection: Collection.data, decks: SavedDecks.list(), history: ValueHistory.load(), scanLog: ScanLog.list(), savedAt: new Date().toISOString() };
  },
  baseOf(p) {
    return { qty: { ...(p.collection?.qty || {}) }, decks: Object.fromEntries((p.decks || []).map(d => [d.id, strHash(JSON.stringify(d))])) };
  },
  markDirty() {
    if (this.applying) return;
    this.seq++;
    const m = this.meta();
    if (!m.dirty) { m.dirty = true; this.setMeta(m); }
    if (this.user) { this.schedule(); this.setStatus('pending'); }
  },
  schedule(ms = 3000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow('change'), ms);
  },
  syncNow(reason) {
    if (!this.sb || !this.user) return Promise.resolve();
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = this._sync(reason).catch(e => this.fail(e)).finally(() => {
      this.busy = null;
      if (this.again) { this.again = false; this.schedule(300); }
    });
    return this.busy;
  },
  async _sync(reason, depth = 0) {
    if (!navigator.onLine) return this.setStatus('offline');
    this.setStatus('syncing');
    const uid = this.user.id, seq = this.seq;
    const { data: row, error } = await this.sb.from('deck_forge_data').select('data, updated_at').eq('user_id', uid).maybeSingle();
    if (error) return this.fail(error);
    const meta = this.meta(), local = this.payload();
    const sameUser = meta.userId === uid && !!meta.syncedAt;

    if (!row) { // first time for this account: upload what's here
      const { data, error: e2 } = await this.sb.from('deck_forge_data').insert({ user_id: uid, data: local, updated_at: new Date().toISOString(), device: deviceName() }).select('updated_at').single();
      if (e2) { if (/duplicate|23505/.test(e2.message + e2.code) && depth < 2) return this._sync(reason, depth + 1); return this.fail(e2); }
      await this.cloudBackup(local, 'first backup');
      return this.done(local, data.updated_at, uid, seq);
    }
    if (sameUser && row.updated_at === meta.syncedAt) {
      if (!meta.dirty) return this.done(null, row.updated_at, uid, seq);
      return this.push(local, row, uid, seq, depth);
    }
    // First sync of this device with this account, and both have cards: ask first
    if (!sameUser && cardCount(local.collection.qty) && syncSig(local) !== syncSig(row.data) && !this.choice) {
      this.pending = { row, uid };
      this.setStatus('choose');
      if (!this.prompted) { this.prompted = true; openAccount(); }
      return;
    }
    const mode = sameUser ? 'merge' : (this.choice || 'merge');
    this.choice = null;
    LocalBackups.add(sameUser ? 'Before changes from your other devices' : 'Before signing in on this device');
    let next;
    if (mode === 'account') {
      // Use the account's copy here (this device's own cards were just saved as an earlier copy)
      next = { ...row.data, history: ValueHistory.merge(local.history, row.data.history), scanLog: ScanLog.merge(local.scanLog, row.data.scanLog) };
    } else next = mergePayloads(local, row.data, sameUser ? meta.base : null);
    this.applyLocal(next);
    if (syncSig(next) === syncSig(row.data)) return this.done(next, row.updated_at, uid, seq);
    return this.push(next, row, uid, seq, depth);
  },
  async push(data, row, uid, seq, depth) {
    this.setStatus('syncing');
    await this.dailyBackup(row.data); // keep a copy of what's about to be replaced
    const { data: upd, error } = await this.sb.from('deck_forge_data')
      .update({ data, updated_at: new Date().toISOString(), device: deviceName() })
      .eq('user_id', uid).eq('updated_at', row.updated_at).select('updated_at');
    if (error) return this.fail(error);
    if (!upd?.length) { // changed on another device meanwhile: merge again
      if (depth < 3) return this._sync('conflict', depth + 1);
      return this.fail(new Error('Your account kept changing on another device — will try again shortly.'));
    }
    return this.done(data, upd[0].updated_at, uid, seq);
  },
  done(data, syncedAt, uid, seq) {
    const m = this.meta();
    m.userId = uid; m.syncedAt = syncedAt; m.lastOk = Date.now();
    if (data) m.base = this.baseOf(data);
    m.dirty = this.seq !== seq; // something changed while syncing: go again
    this.setMeta(m);
    this.setStatus(m.dirty ? 'pending' : 'ok');
    if (m.dirty) this.schedule(1000);
    this.sendReports();
  },
  fail(err) {
    const msg = err?.message || String(err);
    if (/deck_forge_data|does not exist|Could not find the table|PGRST205|42P01/i.test(msg + (err?.code || ''))) return this.setStatus('setup');
    this.message = /Failed to fetch|NetworkError|network/i.test(msg) ? 'No connection — will try again.' : msg;
    this.setStatus('error');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow('retry'), 60000);
  },
  applyLocal(p) {
    this.applying = true;
    try {
      Collection.data = { cards: p.collection?.cards || {}, qty: p.collection?.qty || {} };
      Object.values(Collection.data.cards).forEach(c => c && expandCardText(c));
      Collection.save();
      localStorage.setItem(SavedDecks.key, JSON.stringify(p.decks || []));
      ValueHistory.data = p.history?.value ? p.history : { value: [], prices: {} };
      ValueHistory.save();
      ScanLog.write(p.scanLog || []);
    } finally { this.applying = false; }
    window.onSyncedData?.();
  },
  async dailyBackup(data) {
    const m = this.meta(), day = new Date().toISOString().slice(0, 10);
    if (m.cloudBackupDay === day || !data) return;
    if (await this.cloudBackup(data, 'daily')) { m.cloudBackupDay = day; this.setMeta(m); }
  },
  async cloudBackup(data, reason) {
    const { error } = await this.sb.from('deck_forge_backups').insert({ user_id: this.user.id, data, reason });
    return !error;
  },
  // Wrong-scan reports: photo to private storage, details to a table
  async sendReports() {
    if (!this.sb || !this.user || this.sending || this.status === 'setup') return;
    this.sending = true;
    try {
      for (const r of await ScanReports.all()) {
        if (r.sent) continue;
        let path = null;
        if (r.photo) {
          path = `${this.user.id}/${r.id}.jpg`;
          const up = await this.sb.storage.from('deck-forge-scans').upload(path, r.photo, { contentType: 'image/jpeg', upsert: true });
          if (up.error) break;
        }
        const { error } = await this.sb.from('deck_forge_scan_reports').insert({ guess: r.guess, correct_id: r.correctId, correct_name: r.correctName, photo_path: path, details: { ...r.details, kind: r.kind, at: r.at } });
        if (error) break;
        await ScanReports.markSent(r.id, path);
      }
    } catch (e) { /* try again next sync */ }
    this.sending = false;
  },
  setStatus(s) {
    this.status = s;
    renderAccountButton();
    if ($('#accountDlg')?.open) renderAccount();
  },
};
// Every change to the collection, saved decks, history or scan log is backed up shortly after
{
  const save = Collection.save.bind(Collection);
  Collection.save = function () { save(); Sync.markDirty(); };
  const dsave = SavedDecks.save.bind(SavedDecks), dremove = SavedDecks.remove.bind(SavedDecks);
  SavedDecks.save = d => { if (!d.savedAt) d.savedAt = new Date().toISOString(); dsave(d); Sync.markDirty(); };
  SavedDecks.remove = id => { dremove(id); Sync.markDirty(); };
}
window.Sync = Sync;

// ---------- Account window ----------
function renderAccountButton() {
  const b = $('#accountBtn');
  if (!b) return;
  const s = Sync.status;
  b.dataset.state = !Sync.user ? 'out' : s === 'ok' || s === 'idle' ? 'ok' : s === 'syncing' || s === 'pending' ? 'busy' : 'warn';
  b.title = !Sync.user ? 'Back up your cards (sign in)' : { ok: 'Backed up', idle: 'Signed in', syncing: 'Backing up…', pending: 'Backing up…', offline: 'Offline — will back up later', error: 'Backup problem', setup: 'Online backup not set up yet', choose: 'Choose what to back up' }[s] || 'Account';
}
function openAccount() {
  const d = $('#accountDlg');
  renderAccount();
  if (!d.open) d.showModal();
}
async function renderAccount() {
  const box = $('#acctBody');
  const user = Sync.user, s = Sync.status, m = Sync.meta();
  const reports = await ScanReports.counts();
  const local = LocalBackups.list();
  const localList = local.length ? `<ul class="acct-list">${local.map((b, i) => `<li><span><b>${cardCount(b.qty)} cards</b>${b.decks?.length ? `, ${b.decks.length} decks` : ''}<small>${esc(when(b.at))} · ${esc(b.reason)}</small></span><button class="small" data-acct="restore-local" data-i="${i}">Restore</button></li>`).join('')}</ul>` : '<p class="hint">None yet — one is saved automatically before your account ever changes what’s on this device.</p>';
  const reportsBlock = `<h3 class="sub">Wrong-scan reports</h3>
    <p class="hint">${reports.total ? `${reports.total} saved on this device${user ? ` · ${reports.sent} sent to your account` : ''}.` : 'None yet. When the scanner gets a card wrong, tap “Wrong card?” on the result.'} They help improve the scanner.</p>
    ${reports.total ? '<button class="small" data-acct="reports">Download reports</button>' : ''}`;
  if (!Sync.sb) {
    box.innerHTML = `<h2>Online backup</h2><p class="msg err">Couldn’t load the sign-in service — check your internet connection and reopen the app.</p>
      <p class="hint">Your cards are safe on this device. You can also use <b>Export</b> on the Cards tab to save a backup file.</p>
      <h3 class="sub">Earlier copies on this device</h3>${localList}${reportsBlock}`;
    return;
  }
  if (Sync.recovering) {
    box.innerHTML = `<h2>Choose a new password</h2><form id="acctPwForm" class="acct-form">
      <input id="acctNewPw" type="password" autocomplete="new-password" placeholder="New password (6+ characters)" minlength="6" required>
      <button class="primary">Save password</button></form><p id="acctMsg" class="hint"></p>`;
    return;
  }
  if (!user) {
    box.innerHTML = `<h2>Back up your cards</h2>
      <p>Sign in to keep an online copy of your collection, decks and value history, and to use them on your phone and computer. It’s the same account as Frisbee Stats.</p>
      <form id="acctForm" class="acct-form">
        <input id="acctEmail" type="email" autocomplete="email" placeholder="Email" required>
        <input id="acctPw" type="password" autocomplete="current-password" placeholder="Password" minlength="6" required>
        <div class="row"><button class="primary" data-mode="in">Sign in</button><button data-mode="up">Create account</button></div>
        <button type="button" class="linkish" data-acct="forgot">Forgot password?</button>
      </form>
      <p id="acctMsg" class="hint"></p>
      <p class="hint">Not signed in: your ${cardCount(Collection.data.qty)} cards are saved in this browser only.</p>
      <h3 class="sub">Earlier copies on this device</h3>${localList}${reportsBlock}`;
    return;
  }
  const statusLine = {
    ok: `✓ Backed up ${m.lastOk ? ago(m.lastOk) : ''}`, idle: 'Signed in', syncing: '<span class="spinner"></span>Backing up…', pending: '<span class="spinner"></span>Backing up…',
    offline: 'Offline — changes will be backed up when you’re connected.', error: `Backup problem: ${esc(Sync.message)}`,
    setup: 'Online backup isn’t switched on yet: the database setup (019_deck_forge.sql) needs to be run in Supabase. Your cards are safe on this device.',
    choose: '', nolib: '',
  }[s] || '';
  const choose = s === 'choose' ? `<div class="acct-choose">
      <p><b>This device already has ${cardCount(Collection.data.qty)} cards.</b> Your account has ${cardCount(Sync.pending?.row?.data?.collection?.qty)}. What should happen?</p>
      <button class="primary" data-acct="choose-merge">Add this device’s cards to my account</button>
      <button data-acct="choose-account">Use my account’s cards here</button>
      <p class="hint">Either way nothing is lost: this device’s cards are saved as an earlier copy first, which you can restore below.</p></div>` : '';
  box.innerHTML = `<h2>Online backup</h2>
    <p>Signed in as <b>${esc(user.email)}</b></p>
    ${choose}
    ${statusLine ? `<p class="acct-status ${s}">${statusLine}</p>` : ''}
    <div class="row"><button class="small" data-acct="sync" ${s === 'choose' || s === 'setup' ? 'disabled' : ''}>Back up now</button><button class="small" data-acct="signout">Sign out</button></div>
    <h3 class="sub">Earlier copies in your account</h3><div id="acctCloud"><p class="hint"><span class="spinner"></span>Loading…</p></div>
    <h3 class="sub">Earlier copies on this device</h3>${localList}
    ${reportsBlock}`;
  loadCloudBackups();
}
async function loadCloudBackups() {
  const el = $('#acctCloud');
  if (!el || !Sync.user) return;
  const { data, error } = await Sync.sb.from('deck_forge_backups').select('id, reason, created_at, qty:data->collection->qty').order('created_at', { ascending: false }).limit(20);
  if (!$('#acctCloud')) return;
  if (error) { el.innerHTML = `<p class="hint">${Sync.status === 'setup' ? 'Available once online backup is set up.' : 'Couldn’t load them right now.'}</p>`; return; }
  el.innerHTML = data.length ? `<ul class="acct-list">${data.map(b => `<li><span><b>${cardCount(b.qty)} cards</b><small>${esc(when(b.created_at))} · ${esc(b.reason === 'daily' ? 'daily copy' : b.reason || '')}</small></span><button class="small" data-acct="restore-cloud" data-id="${b.id}">Restore</button></li>`).join('')}</ul><p class="hint">A copy is kept each day you make changes. They can’t be deleted from the app.</p>`
    : '<p class="hint">The first one is saved the first time your account’s copy changes.</p>';
}
// Restore an earlier copy: what's here now is saved first, then the copy replaces it
async function restoreCopy(p, label) {
  if (!confirm(`Replace the cards and decks on this device with ${label}?\n\nWhat’s here now is saved as an earlier copy first, so you can switch back.`)) return;
  LocalBackups.add('Before restoring an earlier copy');
  const cards = { ...Collection.data.cards, ...(p.cards || {}) };
  const missing = [...new Set(Object.keys(p.qty).map(k => k.split('~')[0]))].filter(id => !cards[id]);
  if (missing.length) {
    toast(`Downloading details for ${missing.length} cards…`);
    for (const id of missing) { try { const c = await CardDB.getCard(id); if (c) cards[id] = c; } catch (e) { /* keep going */ } }
  }
  const keep = {};
  for (const k of Object.keys(p.qty)) if (cards[k.split('~')[0]]) keep[k.split('~')[0]] = cards[k.split('~')[0]];
  Collection.data = { cards: keep, qty: { ...p.qty } };
  Collection.save();
  localStorage.setItem(SavedDecks.key, JSON.stringify(p.decks || []));
  Sync.markDirty();
  window.onSyncedData?.();
  toast('Earlier copy restored');
  renderAccount();
}

$('#accountBtn')?.addEventListener('click', openAccount);
$('#accountDlg')?.addEventListener('click', async e => {
  if (e.target.id === 'accountDlg') return $('#accountDlg').close();
  const b = e.target.closest('[data-acct]');
  if (!b) return;
  const act = b.dataset.acct;
  const msg = (t, err) => { const el = $('#acctMsg'); if (el) { el.textContent = t; el.classList.toggle('err', !!err); } };
  if (act === 'close') return $('#accountDlg').close();
  if (act === 'sync') return Sync.syncNow('button');
  if (act === 'signout') {
    if (!confirm('Sign out on this device?\n\nYour cards stay on this device — they just stop being backed up until you sign in again.')) return;
    try { await Sync.busy; } catch (err) { /* anything unsent stays on this device */ }
    await Sync.sb.auth.signOut();
    return renderAccount();
  }
  if (act === 'choose-merge' || act === 'choose-account') {
    Sync.choice = act === 'choose-merge' ? 'merge' : 'account';
    Sync.pending = null;
    return Sync.syncNow('choice');
  }
  if (act === 'forgot') {
    const email = $('#acctEmail').value.trim();
    if (!email) return msg('Type your email above first.', true);
    const { error } = await Sync.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    return msg(error ? error.message : 'If that email has an account, a reset link is on its way.', !!error);
  }
  if (act === 'reports') { const n = await ScanReports.download(); return toast(`Downloaded ${n} reports`); }
  if (act === 'restore-local') {
    const c = LocalBackups.list()[+b.dataset.i];
    if (c) restoreCopy(c, `the copy from ${when(c.at)} (${cardCount(c.qty)} cards)`);
    return;
  }
  if (act === 'restore-cloud') {
    b.disabled = true;
    const { data, error } = await Sync.sb.from('deck_forge_backups').select('data, created_at').eq('id', b.dataset.id).single();
    b.disabled = false;
    if (error) return toast('Couldn’t load that copy: ' + error.message);
    return restoreCopy({ qty: data.data.collection?.qty || {}, cards: data.data.collection?.cards, decks: data.data.decks }, `the copy from ${when(data.created_at)} (${cardCount(data.data.collection?.qty)} cards)`);
  }
});
$('#accountDlg')?.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = (t, err) => { const el = $('#acctMsg'); if (el) { el.textContent = t; el.classList.toggle('err', !!err); } };
  if (e.target.id === 'acctPwForm') {
    const { error } = await Sync.sb.auth.updateUser({ password: $('#acctNewPw').value });
    if (error) return msg(error.message, true);
    Sync.recovering = false; toast('Password saved'); return renderAccount();
  }
  const mode = e.submitter?.dataset.mode || 'in';
  const email = $('#acctEmail').value.trim(), password = $('#acctPw').value;
  e.submitter && (e.submitter.disabled = true);
  msg('');
  const { data, error } = mode === 'up'
    ? await Sync.sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
    : await Sync.sb.auth.signInWithPassword({ email, password });
  if (e.submitter) e.submitter.disabled = false;
  if (error) return msg(/not confirmed/i.test(error.message) ? 'Your email isn’t confirmed yet — open the link in the confirmation email, then sign in.' : error.message, true);
  if (mode === 'up' && !data.session) msg('Check your email for a confirmation link, then sign in here.');
});

Sync.init();
