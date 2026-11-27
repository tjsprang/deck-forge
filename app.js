'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const TYPE_COLORS = { Grass: '#3fa34d', Fire: '#e8562a', Water: '#2f86d6', Lightning: '#e6b800', Psychic: '#9b4dca', Fighting: '#b5652b', Darkness: '#3d4459', Metal: '#8a94a6', Fairy: '#e46fb0', Dragon: '#b08d22', Colorless: '#a7a29a' };

let lastResults = [];
let currentDecks = [];
let activeDeck = 0;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function setStatus(el, html, isErr) { el.innerHTML = html; el.classList.toggle('err', !!isErr); }
const spin = text => `<span class="spinner"></span>${esc(text)}`;

// ---------- Tabs ----------
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  showTab(b.dataset.tab);
});
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
  if (name === 'collection') renderCollection();
  if (name === 'build') refreshFocusList();
  if (name === 'saved') renderSaved();
  if (name === 'meta') renderMeta();
  if (name !== 'add') stopCamera();
  try { localStorage.setItem('df.tab', name); } catch (e) { /* ignore */ }
}

// ---------- Card tiles ----------
function badges(card) {
  const b = [];
  if (card.legal.standard) b.push('<span class="badge std">Standard</span>');
  else if (card.legal.expanded) b.push('<span class="badge exp">Expanded</span>');
  if (card.regulationMark) b.push(`<span class="badge">${esc(card.regulationMark)}</span>`);
  if (card.category === 'Trainer' && card.trainerType) b.push(`<span class="badge">${esc(card.trainerType)}</span>`);
  if (card.category === 'Pokemon' && card.stage) b.push(`<span class="badge">${esc(card.stage.replace('Stage', 'Stage '))}</span>`);
  return `<div class="badges">${b.join('')}</div>`;
}

function cardTile(card, mode) {
  const owned = Collection.data.qty[card.id] || 0;
  const img = cardImage(card);
  const imgHtml = img ? `<img loading="lazy" src="${esc(img)}" alt="${esc(card.name)}">` : `<div class="noimg">${esc(card.name)}<br>(no image)</div>`;
  const actions = mode === 'collection'
    ? `<button data-act="dec" aria-label="Remove one">−</button><span class="qty">${owned}</span><button data-act="inc" aria-label="Add one">+</button>`
    : `<button data-act="add1">+1</button><button data-act="add4">+4</button>${owned ? `<button data-act="dec" title="Remove one">−</button>` : ''}`;
  return `<div class="card" data-id="${esc(card.id)}">
    <div class="img" data-act="zoom">${imgHtml}${owned && mode !== 'collection' ? `<span class="owned">×${owned}</span>` : ''}</div>
    <div class="meta"><div class="name">${esc(card.name)}</div>
      <div class="set">${esc(card.setName)} · ${esc(card.localId)}${card.setTotal ? '/' + card.setTotal : ''}</div>${badges(card)}</div>
    <div class="actions">${actions}</div></div>`;
}

function findCard(id) { return Collection.data.cards[id] || lastResults.find(c => c.id === id) || null; }

function onGridClick(e, mode) {
  const btn = e.target.closest('[data-act]');
  const tile = e.target.closest('.card');
  if (!btn || !tile) return;
  const card = findCard(tile.dataset.id);
  if (!card) return;
  const act = btn.dataset.act;
  if (act === 'zoom') return openCard(card);
  if (act === 'add1' || act === 'inc') Collection.add(card, 1);
  if (act === 'add4') Collection.add(card, 4);
  if (act === 'dec') Collection.add(card, -1);
  if (act !== 'zoom') {
    updateCount();
    if (mode === 'collection') renderCollection();
    else { tile.outerHTML = cardTile(card, 'results'); if (act.startsWith('add')) toast(`Added ${act === 'add4' ? 4 : 1}× ${card.name}`); }
  }
}
$('#results').addEventListener('click', e => onGridClick(e, 'results'));
$('#collGrid').addEventListener('click', e => onGridClick(e, 'collection'));

function showResults(cards, label) {
  lastResults = cards;
  setStatus($('#resultsStatus'), cards.length ? `${cards.length} ${label}` : `No cards found${label ? ' — ' + esc(label) : ''}.`);
  $('#results').innerHTML = cards.map(c => cardTile(c, 'results')).join('');
}

function updateCount() { $('#collCount').textContent = Collection.totalCards(); }

// ---------- Card detail modal ----------
function openCard(card) {
  const img = cardImage(card, 'high');
  $('#modalImg').src = img || '';
  $('#modalImg').hidden = !img;
  const atk = (card.attacks || []).map(a => `<div class="atk"><b>${esc(a.name)}</b> ${a.damage ? '— ' + esc(a.damage) : ''}<br><small>${esc(a.cost.join(', ') || 'Free')}</small>${a.effect ? `<div>${esc(a.effect)}</div>` : ''}</div>`).join('');
  const abil = (card.abilities || []).map(a => `<div class="atk"><b>${esc(a.type || 'Ability')}: ${esc(a.name)}</b><div>${esc(a.effect)}</div></div>`).join('');
  const prizes = prizeValue(card);
  $('#modalInfo').innerHTML = `<h3>${esc(card.name)}</h3>
    <div class="set">${esc(card.setName)} (${esc(CardDB.setCode(card.setId))}) · ${esc(card.localId)} · ${esc(card.rarity)}</div>${badges(card)}
    ${card.hp ? `<p>HP ${card.hp} · ${esc((card.types || []).join('/'))} · Retreat ${card.retreat}${prizes > 1 ? ` · gives up <b>${prizes} Prizes</b>` : ''}</p>` : ''}
    ${card.evolveFrom ? `<p>Evolves from <b>${esc(card.evolveFrom)}</b></p>` : ''}
    ${abil}${atk}${card.effect ? `<p>${esc(card.effect)}</p>` : ''}
    <p><b>You own: ${Collection.data.qty[card.id] || 0}</b></p>`;
  $('#cardModal').showModal();
}
$('#cardModal').addEventListener('click', e => { if (e.target.id === 'cardModal') $('#cardModal').close(); });

// ---------- Search ----------
// One search box that understands:
//   "arcanine"            every printing of a card name
//   "arcanine 109"        that card with collector number 109 (any set)
//   "arcanine 109/123"    ...and a set of 123 cards (exactly one printing, usually)
//   "109/123"             any card numbered 109 in a 123-card set
//   "OBF 125", "sv03 125" a set code (or set name) plus number
//   "TG05", "SWSH050"     letter-prefixed numbers work too
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim().replace(/\s+/g, ' ');
  if (!q) return;
  const standardOnly = $('#standardOnly').checked;
  const status = $('#resultsStatus');
  setStatus(status, spin(`Searching for "${q}"…`));
  $('#results').innerHTML = '';
  try {
    await CardDB.loadSets();
    const { cards, label } = await smartSearch(q);
    const shown = standardOnly ? cards.filter(c => c.legal.standard) : cards;
    showResults(shown, label + (standardOnly && shown.length < cards.length ? ' (Standard-legal only)' : ''));
    if (!shown.length) setStatus(status, `No cards found for "${esc(q)}". Check the spelling, or try just the name or just the number (e.g. 109/123).`, true);
  } catch (err) { setStatus(status, 'Search failed: ' + esc(err.message), true); }
});

// Example chips under the search box fill it in and search
document.querySelector('.search-tips').addEventListener('click', e => {
  const b = e.target.closest('[data-eg]');
  if (!b) return;
  $('#searchInput').value = b.dataset.eg;
  $('#searchForm').requestSubmit();
});

async function smartSearch(q) {
  const num = '([A-Za-z]{0,5}\\d{1,3}[a-z]?)';
  const plural = n => n === 1 ? '' : 's';
  let m;
  // "109/123"
  if ((m = q.match(/^#?(\d{1,3})\s*\/\s*(\d{1,3})$/))) {
    const cards = await CardDB.searchByNumber(m[1], { total: m[2] });
    return { cards, label: `card${plural(cards.length)} numbered ${m[1]}/${m[2]}` };
  }
  // "<something> 109" or "<something> 109/123"
  if ((m = q.match(new RegExp(`^(.+?)\\s+#?${num}(?:\\s*/\\s*(\\d{1,3}))?$`)))) {
    const [, prefix, number, total] = m;
    const p = prefix.toLowerCase();
    // A set code or set id ("OBF", "sv03")
    const exactSets = (CardDB.sets || []).filter(s => s.id.toLowerCase() === p || (s.tcgOnline || '').toLowerCase() === p);
    if (exactSets.length) return setLookup(exactSets, number, prefix);
    // Otherwise a card name: all its printings, filtered to that number (and set size)
    const byName = await CardDB.searchByName(prefix);
    const hits = byName.filter(c => sameNumber(c.localId, number) && (!total || c.setTotal === +total));
    if (hits.length) return { cards: hits, label: `${prefix} numbered ${number}${total ? '/' + total : ''}` };
    // Maybe it was a set name ("Obsidian Flames 125")
    const namedSets = CardDB.findSet(prefix);
    if (namedSets.length && namedSets.length <= 5) {
      const r = await setLookup(namedSets, number, prefix);
      if (r.cards.length) return r;
    }
    // Name found but not that number: show the name's printings so the right one can be picked
    if (byName.length) return { cards: byName, label: `printings of "${prefix}" — none numbered ${number}${total ? '/' + total : ''}, showing all` };
    return { cards: [], label: '' };
  }
  // Just a number
  if ((m = q.match(new RegExp(`^#?${num}$`))) && /\d/.test(q)) {
    const cards = await CardDB.searchByNumber(m[1]);
    return { cards, label: `card${plural(cards.length)} numbered ${m[1]} — add the name or set size to narrow it down` };
  }
  // Just a name
  const cards = await CardDB.searchByName(q);
  return { cards, label: `printing${plural(cards.length)} matching "${q}" (newest first)` };
}
async function setLookup(sets, number, prefix) {
  const cards = [];
  for (const s of sets.slice(0, 5)) cards.push(...await CardDB.searchByNumber(number.replace(/^\D+(?=\d)/, '') || number, { setId: s.id }));
  return { cards, label: `${prefix.toUpperCase()} ${number}` };
}

// ---------- Scanner (camera / photo + OCR) ----------
let stream = null;
let tesseractReady = null;
function loadTesseract() {
  if (tesseractReady) return tesseractReady;
  tesseractReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { tesseractReady = null; reject(new Error('Could not load the text reader (needs internet).')); };
    document.head.appendChild(s);
  });
  return tesseractReady;
}

// Start downloading the card list + text reader as soon as someone heads for the scanner.
const warmScanner = () => { Scanner.loadIndex().catch(() => {}); Scanner.getWorkers().catch(() => {}); };
$('#photoInput').closest('label').addEventListener('click', warmScanner);
$('#cameraBtn').addEventListener('click', warmScanner);
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { setStatus($('#resultsStatus'), 'Camera not available here. Camera access needs https or localhost — or use Upload photo.', true); return false; }
  try {
    if (!stream) {
      // Ask for a high-resolution stream: the collector number is tiny text
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1440 } } });
      const track = stream.getVideoTracks()[0];
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* not supported */ }
      $('#video').srcObject = stream;
      await $('#video').play();
    }
    $('#scanner').hidden = false;
    showLive();
    placeGuide();
    loadTesseract().catch(() => {});
    return true;
  } catch (err) { setStatus($('#resultsStatus'), 'Camera blocked: ' + esc(err.message), true); return false; }
}
$('#cameraBtn').addEventListener('click', () => {
  stopBulk();
  $('#results').innerHTML = ''; setStatus($('#resultsStatus'), '');
  startCamera().then(ok => { if (ok) $('#scanner').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
});
function stopCamera() { stopBulk(); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; $('#scanner').hidden = true; }
$('#stopCamBtn').addEventListener('click', stopCamera);

// The viewfinder is a portrait box the camera picture fills (object-fit: cover). The card frame
// is card-shaped (63 × 88 mm) and as wide as the viewfinder allows, so the card fills the
// picture — the bigger it is, the more readable the tiny collector number. What's inside the
// frame on screen is exactly what gets analysed.
const CARD_RATIO = 88 / 63;
function viewGuide() {
  const wrap = $('#videoWrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  let gw = W * 0.9, gh = gw * CARD_RATIO;
  if (gh > H * 0.94) { gh = H * 0.94; gw = gh / CARD_RATIO; }
  return { x: (W - gw) / 2, y: (H - gh) / 2, w: gw, h: gh, W, H };
}
function placeGuide() {
  const g = viewGuide();
  if (!g.W) return;
  Object.assign(document.querySelector('.card-guide').style, {
    left: (g.x / g.W * 100) + '%', top: (g.y / g.H * 100) + '%', width: (g.w / g.W * 100) + '%', height: (g.h / g.H * 100) + '%',
  });
}
window.addEventListener('resize', placeGuide);
// Where the on-screen frame sits in the camera's own pixels (cover scaling crops the picture)
function guideInVideo(vw, vh) {
  const g = viewGuide();
  const s = Math.max(g.W / vw, g.H / vh);
  const ox = (g.W - vw * s) / 2, oy = (g.H - vh * s) / 2;
  return { x: (g.x - ox) / s, y: (g.y - oy) / s, w: g.w / s, h: g.h / s };
}
// One camera frame: the whole picture (to freeze on screen) and the card frame (to analyse)
function grabFrame() {
  const v = $('#video');
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return null;
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  full.getContext('2d').drawImage(v, 0, 0);
  const r = guideInVideo(w, h);
  const m = 0.03; // small margin so the edge finder can tighten onto the card
  const sx = Math.max(0, r.x - r.w * m), sy = Math.max(0, r.y - r.h * m);
  const sw = Math.min(w - sx, r.w * (1 + 2 * m)), sh = Math.min(h - sy, r.h * (1 + 2 * m));
  const crop = document.createElement('canvas');
  crop.width = Math.round(sw); crop.height = Math.round(sh);
  crop.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
  return { full, crop };
}
function captureFrame() { return grabFrame()?.crop || null; } // used by bulk scan

// How sharp a frame is (variance of the Laplacian): motion blur and focus hunting score low
function sharpness(canvas) {
  const W = 240, H = Math.round(W * canvas.height / canvas.width);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(canvas, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  let sum = 0, sq = 0, n = 0;
  for (let yy = 1; yy < H - 1; yy++) for (let xx = 1; xx < W - 1; xx++) {
    const k = yy * W + xx;
    const l = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - W] - g[k + W];
    sum += l; sq += l * l; n++;
  }
  return sq / n - (sum / n) ** 2;
}

// Capture: grab a short burst, keep the sharpest frame, freeze it on screen (the card can be put
// down), then analyse it step by step.
$('#captureBtn').addEventListener('click', async () => {
  const shots = [];
  for (let i = 0; i < 4; i++) { const f = grabFrame(); if (f) shots.push(f); await sleep(110); }
  if (!shots.length) return;
  let best = shots[0], bestS = -1;
  for (const s of shots) { const v = sharpness(s.crop); if (v > bestS) { bestS = v; best = s; } }
  showFrozen(best.full);
  try { navigator.vibrate?.(30); } catch (e) { /* ignore */ }
  await recognizeCard(best.crop, { steps: true });
  $('#scanAgainBtn').hidden = false;
});
$('#scanAgainBtn').addEventListener('click', () => { if (stream) showLive(); else startCamera(); $('#results').innerHTML = ''; setStatus($('#resultsStatus'), ''); });

function showFrozen(canvasFull, { photo = false } = {}) {
  const snap = $('#snapshot');
  snap.width = canvasFull.width; snap.height = canvasFull.height;
  snap.getContext('2d').drawImage(canvasFull, 0, 0);
  snap.hidden = false;
  $('#video').pause();
  $('#videoWrap').classList.toggle('photo', photo);
  $('#captureBtn').hidden = true;
  $('#scanAgainBtn').hidden = true;
  $('#scanTip').hidden = true;
  resetSteps(true);
}
function showLive() {
  $('#snapshot').hidden = true;
  $('#videoWrap').classList.remove('photo');
  if (stream) $('#video').play().catch(() => {});
  $('#captureBtn').hidden = !!bulk?.running;
  $('#scanAgainBtn').hidden = true;
  $('#scanTip').hidden = false;
  resetSteps(false);
}
function resetSteps(show) {
  const ol = $('#scanSteps');
  ol.hidden = !show;
  ol.querySelectorAll('li').forEach(li => { li.className = ''; li.querySelector('small').textContent = ''; });
}
function setStep(key, state, detail) {
  const li = document.querySelector(`#scanSteps li[data-step="${key}"]`);
  if (!li) return;
  // Everything before an active step is finished
  if (state === 'active') {
    let p = li.previousElementSibling;
    while (p) { if (!p.className) p.className = 'done'; p = p.previousElementSibling; }
  }
  li.className = state;
  if (detail != null) li.querySelector('small').textContent = detail;
}

// ---------- Bulk scan: keep scanning, auto-add sure matches, queue unsure ones ----------
let bulk = null;
$('#bulkBtn').addEventListener('click', async () => {
  warmScanner();
  if (!(await startCamera())) return;
  if (bulk?.running) return;
  bulk = { running: true, added: [], review: [], lastSig: null };
  $('#bulkPanel').hidden = false;
  $('#bulkStatus').hidden = false;
  $('#captureBtn').hidden = true;
  renderBulk();
  bulkLoop();
});
function stopBulk() {
  if (!bulk) return;
  bulk.running = false;
  $('#bulkStatus').hidden = true;
  $('#captureBtn').hidden = false;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function frameIsEmpty(c) {
  // Nothing in front of the camera: a flat, low-detail frame
  const s = document.createElement('canvas'); s.width = 32; s.height = 44;
  const x = s.getContext('2d', { willReadFrequently: true });
  x.drawImage(c, 0, 0, 32, 44);
  const d = x.getImageData(0, 0, 32, 44).data;
  let sum = 0, sq = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += g; sq += g * g; n++; }
  const sd = Math.sqrt(sq / n - (sum / n) ** 2);
  return sd < 18;
}
async function bulkLoop() {
  const status = msg => { $('#bulkStatus').textContent = msg; };
  status('Hold up the first card inside the frame…');
  while (bulk?.running && stream) {
    await sleep(450);
    const frame = captureFrame();
    if (!frame) continue;
    if (frameIsEmpty(frame)) { bulk.lastSig = null; status('Ready — show the next card'); continue; }
    const sig = signature(frame);
    // Same card still in view? Wait for the next one (a card counts once until it's swapped)
    if (bulk.lastSig && visualSimilarity(sig, bulk.lastSig) > 0.72) { status('Got it — swap to the next card'); continue; }
    // Wait for the image to settle (the card is still moving)
    await sleep(250);
    const frame2 = captureFrame();
    if (!frame2 || visualSimilarity(signature(frame2), sig) < 0.75) continue;
    status('Reading card…');
    try {
      const res = await Scanner.identify(frame2, s => status(s));
      bulk.lastSig = signature(frame2);
      if (!res.results.length) { status('Couldn’t read that one — tilt away from glare or swap cards'); continue; }
      if (res.confident) {
        const card = res.results[0];
        Collection.add(card, 1);
        bulk.added.unshift({ card, at: Date.now() });
        updateCount();
        status(`Added ${card.name} (${card.setName}) — next card`);
        try { navigator.vibrate?.(60); } catch (e) { /* ignore */ }
      } else {
        const thumb = document.createElement('canvas');
        thumb.width = 120; thumb.height = Math.round(120 * frame2.height / frame2.width);
        thumb.getContext('2d').drawImage(frame2, 0, 0, thumb.width, thumb.height);
        bulk.review.push({ id: 'r' + Date.now(), photo: thumb.toDataURL('image/jpeg', 0.7), options: res.results.slice(0, 5) });
        status('Not sure about that one — added to the review pile. Next card');
      }
      renderBulk();
    } catch (err) { status('Scan error: ' + err.message); await sleep(1500); }
  }
}
function renderBulk() {
  if (!bulk) return;
  $('#bulkCounts').textContent = `${bulk.added.length} added · ${bulk.review.length} to review`;
  $('#bulkAdded').innerHTML = bulk.added.length ? bulk.added.slice(0, 40).map((a, i) => `<span class="chip">${esc(a.card.name)} <small>${esc(CardDB.setCode(a.card.setId))} ${esc(a.card.localId)}</small><button data-undo="${i}" title="Undo">×</button></span>`).join('') : '<span class="hint">Nothing yet.</span>';
  $('#bulkReview').innerHTML = bulk.review.length ? bulk.review.map(r => `<div class="review-item" data-r="${r.id}">
      <img class="photo" src="${r.photo}" alt="Your photo">
      <div class="opts">${r.options.map((c, k) => `<button class="opt" data-pick="${k}" title="${esc(c.name)} · ${esc(c.setName)}">${cardImage(c) ? `<img src="${esc(cardImage(c))}" alt="">` : ''}<span>${esc(c.name)}<br><small>${esc(c.setName)} ${esc(c.localId)}</small></span></button>`).join('')}
        <button data-skip="1">None of these</button></div></div>`).join('') : '<span class="hint">Nothing to review.</span>';
}
$('#bulkPanel').addEventListener('click', e => {
  const undo = e.target.closest('[data-undo]');
  if (undo) {
    const a = bulk.added.splice(+undo.dataset.undo, 1)[0];
    if (a) { Collection.add(a.card, -1); updateCount(); toast(`Removed ${a.card.name}`); }
    return renderBulk();
  }
  const item = e.target.closest('.review-item');
  if (!item) return;
  const idx = bulk.review.findIndex(r => r.id === item.dataset.r);
  if (idx < 0) return;
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const card = bulk.review[idx].options[+pick.dataset.pick];
    Collection.add(card, 1); updateCount();
    bulk.added.unshift({ card, at: Date.now() });
    toast(`Added ${card.name}`);
  }
  if (pick || e.target.closest('[data-skip]')) { bulk.review.splice(idx, 1); renderBulk(); }
});
$('#photoInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = async () => {
    const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = img.width * scale; c.height = img.height * scale;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    // Same step-by-step view as the camera, showing the uploaded photo
    stopBulk();
    $('#scanner').hidden = false;
    showFrozen(c, { photo: true });
    await recognizeCard(c, { steps: true });
    $('#scanAgainBtn').hidden = false;
  };
  img.src = URL.createObjectURL(f);
  e.target.value = '';
});

async function recognizeCard(canvas, { steps = false } = {}) {
  const status = $('#resultsStatus');
  setStatus(status, steps ? '' : spin('Reading card…'));
  $('#results').innerHTML = '';
  try {
    const res = await Scanner.identify(canvas, (text, info) => {
      if (steps && info?.step && info.step !== 'prep') setStep(info.step, info.state, info.detail);
      else if (steps && info?.step === 'prep') setStep('name', 'active', 'Getting ready…');
      else setStatus(status, spin(text));
    });
    const what = [res.readName && `name "${res.readName}"`, res.num && `number ${res.num.text}`].filter(Boolean).join(', ') || 'nothing clear';
    if (!res.results.length) {
      if (steps) setStep('done', 'fail', 'Couldn’t identify this card');
      return setStatus(status, `Couldn't identify the card (read ${esc(what)}). Try again with the card filling the frame and no glare on the number — or type it in the search box, e.g. "Raikou 033/103".`, true);
    }
    lastResults = res.results;
    const n = res.results.length;
    setStatus(status, (res.confident ? '<b>Best match first.</b> ' : `${n} possible printings, most likely first. `) + `Read ${esc(what)}. Tap +1 on the right one.`);
    $('#results').innerHTML = res.results.map(c => cardTile(c, 'results')).join('');
    if (res.confident) $('#results .card')?.classList.add('best');
    if (steps) setTimeout(() => $('#resultsStatus').scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
  } catch (err) {
    if (steps) setStep('done', 'fail', err.message);
    setStatus(status, esc(err.message), true);
  }
}

// ---------- Collection view ----------
['collFilter', 'collCategory', 'collLegal', 'collSort'].forEach(id => $('#' + id).addEventListener('input', renderCollection));
function renderCollection() {
  const q = $('#collFilter').value.trim().toLowerCase();
  const cat = $('#collCategory').value, leg = $('#collLegal').value, sort = $('#collSort').value;
  let list = Collection.entries();
  const total = list.reduce((a, e) => a + e.qty, 0);
  if (q) list = list.filter(e => e.card.name.toLowerCase().includes(q) || e.card.setName.toLowerCase().includes(q));
  if (cat) list = list.filter(e => e.card.category === cat);
  if (leg) list = list.filter(e => e.card.legal[leg]);
  const typeKey = e => (e.card.category === 'Pokemon' ? '0' + (e.card.types[0] || '') : e.card.category === 'Trainer' ? '1' + e.card.trainerType : '2');
  list.sort((a, b) => sort === 'qty' ? b.qty - a.qty || a.card.name.localeCompare(b.card.name)
    : sort === 'set' ? a.card.setName.localeCompare(b.card.setName) || (parseInt(a.card.localId) - parseInt(b.card.localId))
    : sort === 'type' ? typeKey(a).localeCompare(typeKey(b)) || a.card.name.localeCompare(b.card.name)
    : a.card.name.localeCompare(b.card.name));
  const counts = { Pokemon: 0, Trainer: 0, Energy: 0 };
  Collection.entries().forEach(e => { counts[e.card.category] = (counts[e.card.category] || 0) + e.qty; });
  const std = Collection.entries().filter(e => e.card.legal.standard).reduce((a, e) => a + e.qty, 0);
  setStatus($('#collSummary'), total ? `${total} cards (${Collection.entries().length} unique) · ${counts.Pokemon} Pokémon · ${counts.Trainer} Trainers · ${counts.Energy} Energy · ${std} Standard-legal${list.length !== Collection.entries().length ? ` · showing ${list.length}` : ''}` : '');
  $('#collGrid').innerHTML = list.length ? list.map(e => cardTile(e.card, 'collection')).join('')
    : `<div class="empty">${total ? 'No cards match these filters.' : 'Your collection is empty. Add cards from the <b>Add cards</b> tab, or click <b>Load sample</b> to try the deck builder.'}</div>`;
}

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([Collection.export()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `deck-forge-collection-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#importInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const merge = Collection.totalCards() > 0 && confirm('Merge with your current collection?\nOK = merge, Cancel = replace');
    Collection.import(await f.text(), merge);
    updateCount(); renderCollection(); toast('Collection imported');
  } catch (err) { alert('Import failed: ' + err.message); }
  e.target.value = '';
});

$('#sampleBtn').addEventListener('click', async () => {
  if (Collection.totalCards() && !confirm('Add the sample cards to your current collection?')) return;
  const btn = $('#sampleBtn');
  btn.disabled = true;
  let done = 0;
  const missing = [];
  const queue = [...SAMPLE_COLLECTION];
  await CardDB.loadSets();
  async function worker() {
    while (queue.length) {
      const [name, qty] = queue.shift();
      try {
        const cards = await CardDB.searchByName(name, { standardOnly: true, exact: true });
        const card = cards.find(c => c.name === name) || cards.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (card) Collection.add(card, qty); else missing.push(name);
      } catch (e) { missing.push(name); }
      done++;
      setStatus($('#collSummary'), spin(`Loading sample collection… ${done}/${SAMPLE_COLLECTION.length}`));
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  btn.disabled = false;
  updateCount(); renderCollection();
  toast(missing.length ? `Sample loaded (${missing.length} not found: ${missing.join(', ')})` : 'Sample collection loaded');
});

// ---------- Build ----------
function refreshFocusList() {
  const names = [...new Set(Collection.entries().filter(e => e.card.category === 'Pokemon' && (e.card.attacks || []).length).map(e => e.card.name))].sort();
  $('#focusList').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

$('#generateBtn').addEventListener('click', () => {
  const entries = Collection.entries();
  if (!entries.length) return setStatus($('#buildStatus'), 'Add some cards to your collection first (or load the sample collection).', true);
  const btn = $('#generateBtn');
  btn.disabled = true;
  setStatus($('#buildStatus'), spin('Analysing your cards…'));
  setTimeout(async () => {
    try {
      const t0 = performance.now();
      const res = await generateDecksSmart(entries, { format: $('#fmt').value, focus: $('#focus').value.trim(), energyType: $('#etype').value, assumeBasicEnergy: $('#assumeEnergy').checked },
        msg => setStatus($('#buildStatus'), spin(msg)));
      currentDecks = res.decks;
      activeDeck = 0;
      if (!res.decks.length) { setStatus($('#buildStatus'), esc(res.reason), true); $('#deckTabs').innerHTML = ''; $('#deckView').innerHTML = ''; return; }
      const legalCount = res.pool.all().filter(g => !g.virtual).reduce((a, g) => a + g.qty, 0);
      const games = res.decks.reduce((a, d) => a + (d.sim?.games || 0), 0);
      setStatus($('#buildStatus'), `Analysed ${legalCount} ${RULES.formats[$('#fmt').value].label}-legal cards, built ${res.decks.length} deck${res.decks.length > 1 ? 's' : ''} and play-tested them (${games.toLocaleString()}+ simulated openings, ${((performance.now() - t0) / 1000).toFixed(1)}s). Best first.`);
      renderDeckTabs();
    } catch (err) {
      console.error(err);
      setStatus($('#buildStatus'), 'Something went wrong building decks: ' + esc(err.message), true);
    } finally { btn.disabled = false; }
  }, 30);
});

function renderDeckTabs() {
  $('#deckTabs').innerHTML = currentDecks.map((d, i) => `<button data-i="${i}" class="${i === activeDeck ? 'active' : ''}"><span class="dt-name">${esc(d.name)}</span><span class="dt-score">Score ${d.score}/100 · ${d.stats.total} cards</span></button>`).join('');
  renderDeck(currentDecks[activeDeck], $('#deckView'), { editable: true });
}
$('#deckTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  activeDeck = +b.dataset.i;
  renderDeckTabs();
});

function scoreColor(s) { return s >= 75 ? 'var(--good)' : s >= 50 ? 'var(--warn)' : 'var(--bad)'; }

function recompute(deck) {
  // Re-checks rules and re-runs the play-test simulation after a manual edit
  refreshDeck(deck, name => {
    const hit = deck.entries.find(e => e.card.name === name) || Collection.entries().find(e => e.card.name === name);
    return hit ? hit.card : null;
  }, { games: 1500 });
}

function renderDeck(deck, host, { editable, saved } = {}) {
  const groups = [['Pokemon', 'Pokémon'], ['Trainer', 'Trainers'], ['Energy', 'Energy']];
  const s = deck.stats;
  const pct = n => s.total ? (n / s.total) * 100 : 0;
  const rows = cat => deck.entries.map((e, i) => ({ e, i })).filter(x => x.e.card.category === cat).map(({ e, i }) => {
    const img = cardImage(e.card);
    const roleTag = ['core', 'partner', 'engine'].includes(e.role) ? `<span class="role ${e.role}">${e.role === 'core' ? 'Main' : e.role}</span>` : '';
    const own = Collection.data.qty[e.card.id];
    return `<div class="deck-row" data-i="${i}">
      <span class="n">${e.count}</span>
      ${img ? `<img loading="lazy" src="${esc(img)}" alt="" data-zoom="${i}">` : `<span class="thumb"></span>`}
      <div class="info"><div class="nm">${esc(e.card.name)}</div><div class="why">${roleTag}${esc(e.reason || '')}${e.card.virtual ? ' (not logged)' : ` · ${esc(CardDB.setCode(e.card.setId))} ${esc(e.card.localId)}${own != null ? ` · own ${own}` : ''}`}</div></div>
      ${editable ? `<div class="edit"><button data-d="-1" aria-label="One fewer">−</button><button data-d="1" aria-label="One more">+</button></div>` : '<span></span>'}
    </div>`;
  }).join('');
  const sum = cat => deck.entries.filter(e => e.card.category === cat).reduce((a, e) => a + e.count, 0);
  const issuesHtml = [...deck.issues.map(i => ({ level: i.level, msg: i.msg })), ...(deck.advice || [])]
    .map(a => `<li class="${a.level}">${esc(a.msg)}</li>`).join('');
  const typeCounts = {};
  deck.entries.filter(e => e.card.category === 'Pokemon').forEach(e => { const t = e.card.types[0] || 'Colorless'; typeCounts[t] = (typeCounts[t] || 0) + e.count; });
  const p = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
  host.innerHTML = `<div class="deck">
    <div>
      <div class="deck-head">
        <div class="score-ring" style="--p:${deck.score};--c:${scoreColor(deck.score)}"><span>${deck.score}</span></div>
        <div><h2>${esc(deck.name)}</h2><div class="set">${esc(RULES.formats[deck.format]?.label || deck.format)} · ${s.total}/60 cards${deck.issues.some(i => i.level === 'error') ? ' · <b style="color:var(--bad)">not tournament-legal yet</b>' : ' · <b style="color:var(--good)">legal</b>'}</div></div>
        <span class="spacer"></span>
        ${saved ? `<button data-act="delete">Delete</button>` : `<button class="primary" data-act="save">Save deck</button>`}
        <button data-act="copy">Copy list</button>
      </div>
      ${groups.map(([cat, label]) => `<div class="deck-group"><h3>${label} (${sum(cat)})</h3><div class="deck-list">${rows(cat) || '<span class="hint">None</span>'}</div></div>`).join('')}
    </div>
    <div class="side">
      ${deck.sim ? `<div class="panel"><h2>Play-test results</h2>
        <p class="hint" style="margin:0 0 10px">${deck.sim.games.toLocaleString()} simulated openings: how often <b>${esc(deck.core)}</b> can attack.</p>
        ${[['Turn 2', deck.sim.byTurn2], ['Turn 3', deck.sim.byTurn3], ['Turn 4', deck.sim.byTurn4]].map(([l, v]) => `
          <div class="simrow"><span>${l}</span><div class="simbar"><i style="width:${(v * 100).toFixed(0)}%;background:${v >= 0.6 ? 'var(--good)' : v >= 0.35 ? 'var(--warn)' : 'var(--bad)'}"></i></div><b>${p(v)}</b></div>`).join('')}
        <div class="stat-grid" style="margin-top:10px">
          <div class="stat"><b>${deck.sim.avgFirstAttack.toFixed(1)}</b><small>Average first attack turn</small></div>
          <div class="stat"><b>${p(deck.sim.backupByTurn4)}</b><small>Second attacker ready by turn 4</small></div>
        </div></div>` : ''}
      <div class="panel"><h2>Deck stats</h2>
        <div class="bar"><i style="width:${pct(s.pokemon)}%;background:var(--accent)"></i><i style="width:${pct(s.trainers)}%;background:var(--accent-2)"></i><i style="width:${pct(s.energy)}%;background:var(--warn)"></i></div>
        <div class="legend"><span style="--c:var(--accent)">${s.pokemon} Pokémon</span><span style="--c:var(--accent-2)">${s.trainers} Trainers</span><span style="--c:var(--warn)">${s.energy} Energy</span></div>
        <div class="stat-grid" style="margin-top:12px">
          <div class="stat"><b>${p(s.mulligan)}</b><small>Mulligan chance (${s.basics} Basics)</small></div>
          <div class="stat"><b>${p(s.openWithSupporter)}</b><small>Supporter in opening hand</small></div>
          <div class="stat"><b>${s.search}</b><small>Pokémon search cards</small></div>
          <div class="stat"><b>${s.draw}</b><small>Draw/search Supporters</small></div>
          <div class="stat"><b>${s.gust}</b><small>Gust cards</small></div>
          <div class="stat"><b>${s.prizesAvg.toFixed(1)}</b><small>Avg Prizes per Pokémon</small></div>
        </div>
        <div class="legend" style="margin-top:10px">${Object.entries(typeCounts).map(([t, n]) => `<span style="--c:${TYPE_COLORS[t] || '#999'}">${n} ${esc(t)}</span>`).join('')}</div>
      </div>
      ${rotationPanel(deck)}
      ${matchupPanel(deck)}
      ${upgradePanel(deck)}
      <div class="panel"><h2>Notes &amp; advice</h2><ul class="advice">${issuesHtml}</ul></div>
      <div class="panel"><h2>Export (Pokémon TCG Live format)</h2><textarea class="export" readonly>${esc(exportDeckText(deck, id => CardDB.setCode(id)))}</textarea></div>
    </div></div>`;

  host.onclick = e => {
    const z = e.target.closest('[data-zoom]');
    if (z) return openCard(deck.entries[+z.dataset.zoom].card);
    const d = e.target.closest('button[data-d]');
    if (d) {
      const e2 = deck.entries[+d.closest('.deck-row').dataset.i];
      const delta = +d.dataset.d;
      const owned = e2.card.virtual ? 99 : (Collection.data.qty[e2.card.id] || 0);
      if (delta > 0 && e2.count >= owned) return toast(`You only own ${owned} of this printing.`);
      e2.count += delta;
      deckExtras.delete(deck); // matchups/upgrades no longer match the edited list
      recompute(deck);
      renderDeck(deck, host, { editable, saved });
      if (!saved) renderDeckTabsHeaderOnly();
      if (saved) SavedDecks.save(deck);
      return;
    }
    const a = e.target.closest('button[data-act]');
    if (!a) return;
    const rerender = () => renderDeck(deck, host, { editable, saved });
    if (a.dataset.act === 'matchups') return runMatchups(deck, rerender);
    if (a.dataset.act === 'upgrades') return runUpgrades(deck, rerender);
    if (a.dataset.act === 'copy-shopping') {
      const up = deckExtras.get(deck)?.upgrades;
      const lines = (up?.steps || []).flatMap(s => s.adds.filter(x => x.buy > 0).map(x => `${x.buy} ${x.name}`));
      navigator.clipboard?.writeText(lines.join('\n')).then(() => toast('Shopping list copied'), () => toast('Copy failed'));
      return;
    }
    if (a.dataset.act === 'copy') {
      navigator.clipboard?.writeText(exportDeckText(deck, id => CardDB.setCode(id))).then(() => toast('Deck list copied — paste it into Pokémon TCG Live'), () => toast('Copy failed — select the export text instead'));
    }
    if (a.dataset.act === 'save') {
      const name = prompt('Deck name', deck.name);
      if (name == null) return;
      SavedDecks.save({ ...deck, name: name || deck.name, id: deck.id, saved: new Date().toISOString() });
      toast('Deck saved');
    }
    if (a.dataset.act === 'delete' && confirm(`Delete "${deck.name}"?`)) {
      SavedDecks.remove(deck.id);
      host.innerHTML = '';
      renderSaved();
    }
  };
}
// ---------- Deck extras: rotation, matchups, upgrades ----------
const deckExtras = new WeakMap(); // deck -> { matchups, upgrades, busy }
const extrasOf = deck => { if (!deckExtras.has(deck)) deckExtras.set(deck, {}); return deckExtras.get(deck); };
const pctS = v => v == null ? '—' : Math.round(v * 100) + '%';

function rotationPanel(deck) {
  if (deck.format !== 'standard') return '';
  const r = rotationReport(deck.entries, Collection.entries());
  if (!r.count) return '';
  const rows = r.cards.map(c => `<li><b>${c.count}× ${esc(c.name)}</b>${c.reprint ? ' — you own a newer printing, swap to that one' : c.replacements.length ? ` — replacements you own: ${c.replacements.map(esc).join(', ')}` : ' — no replacement in your collection yet'}</li>`).join('');
  return `<div class="panel rot"><h2>Rotation warning</h2>
    <p class="hint" style="margin:0 0 8px">${r.count} card${r.count > 1 ? 's' : ''} with the <b>${NEXT_ROTATION.marks.join('/')}</b> regulation mark ${NEXT_ROTATION.confirmed ? 'leave' : 'are <b>expected</b> to leave'} Standard ${esc(NEXT_ROTATION.when)}${NEXT_ROTATION.confirmed ? '' : ' (not announced yet — usually announced in January)'}.</p>
    <ul class="advice">${rows}</ul></div>`;
}

function matchupPanel(deck) {
  const x = extrasOf(deck);
  if (deck.format !== 'standard') return '';
  if (x.busy === 'matchups') return `<div class="panel"><h2>Matchups</h2><p class="hint">${spin(x.progress || 'Working…')}</p></div>`;
  const m = x.matchups;
  if (!m) return `<div class="panel"><h2>Matchups</h2><p class="hint" style="margin:0 0 10px">How this deck does against the most-played decks in recent online tournaments.</p><button data-act="matchups">Check matchups</button></div>`;
  if (m.error) return `<div class="panel"><h2>Matchups</h2><p class="hint" style="color:var(--bad)">${esc(m.error)}</p><button data-act="matchups">Try again</button></div>`;
  const real = m.rows.filter(r => r.source === 'real');
  const head = m.archetype
    ? `This plays like <b>${esc(m.archetype)}</b>, so these use <b>real tournament results</b> for that deck (adjusted for how consistent your version is).`
    : m.k < 0.15
      ? `Your deck doesn't match a tournament archetype, and the simulator's matchup guesses haven't matched real results well (checked on ${m.calGames || 'recent'} games), so there's <b>no reliable estimate</b> — treat these as roughly even.`
      : `Estimated by simulation, calibrated against real tournament results.`;
  const rows = m.rows.map(r => `<div class="simrow mrow"><span title="${esc(r.name)}">${esc(r.name)}</span><div class="simbar"><i style="width:${Math.round(r.win * 100)}%;background:${r.win >= 0.55 ? 'var(--good)' : r.win >= 0.45 ? 'var(--warn)' : 'var(--bad)'}"></i></div><b>${pctS(r.win)}</b><small>${r.source === 'real' ? r.games + ' games' : r.source === 'mirror' ? 'mirror' : m.k < 0.15 ? 'no data' : 'est.'}</small></div>`).join('');
  return `<div class="panel"><h2>Matchups</h2><p class="hint" style="margin:0 0 8px">${head}</p>${rows}
    <p class="hint">Overall vs the field: <b>${pctS(m.overall)}</b>${real.length ? '' : ''} · share-weighted</p></div>`;
}

async function runMatchups(deck, rerender) {
  const x = extrasOf(deck);
  x.busy = 'matchups'; x.progress = 'Loading tournament decks…'; rerender();
  try {
    const prep = await prepareMeta(msg => { x.progress = msg; rerender(); });
    x.progress = 'Simulating matchups…'; rerender();
    await new Promise(r => setTimeout(r, 0));
    const archetype = matchArchetype(deck.entries, deck.core, prep.profiles);
    const rep = matchupReport(deck.entries, deck.core, prep.profiles, 2000, 1200, { k: prep.k, archetype });
    x.matchups = rep ? { ...rep, calGames: prep.calibration.games } : { error: 'Could not simulate this deck.' };
  } catch (err) { x.matchups = { error: 'Could not load tournament data: ' + err.message }; }
  x.busy = null; rerender();
}

function upgradePanel(deck) {
  const x = extrasOf(deck);
  if (deck.format === 'unlimited') return '';
  if (x.busy === 'upgrades') return `<div class="panel"><h2>Upgrade advisor</h2><p class="hint">${spin(x.progress || 'Working…')}</p></div>`;
  const u = x.upgrades;
  if (!u) return `<div class="panel"><h2>Upgrade advisor</h2><p class="hint" style="margin:0 0 10px">The cheapest cards to buy that would make this deck better, tested by play-testing (cards from recent tournament lists, plus more copies of what you play).</p><button data-act="upgrades">Find upgrades</button></div>`;
  if (u.error) return `<div class="panel"><h2>Upgrade advisor</h2><p class="hint" style="color:var(--bad)">${esc(u.error)}</p><button data-act="upgrades">Try again</button></div>`;
  if (!u.steps.length) return `<div class="panel"><h2>Upgrade advisor</h2><p class="hint">No purchase from recent tournament lists made a measurable difference to this deck. It's already about as good as these cards can make it.</p></div>`;
  let total = 0;
  const rows = u.steps.map((s, i) => {
    total += s.cost;
    const buys = s.adds.map(a => `${a.buy ? `<b>Buy ${a.buy}× ${esc(a.name)}</b>` : `+${a.count} ${esc(a.name)} <small>(you own spares)</small>`}${a.buy && a.price != null ? ` <small>${Prices.fmt({ usd: a.price }, 1)} ea</small>` : ''}`).join('<br>');
    const cuts = s.removes.map(r => `−${r.count} ${esc(r.name)}`).join(', ');
    return `<li class="good"><div>${i + 1}. ${buys}</div><small>Cut: ${cuts}</small><div><small>Turn 2: ${pctS(s.t2)} · Turn 3: ${pctS(s.t3)}${s.win != null ? ` · vs field: ${pctS(s.win)}` : ''} · step $${s.cost.toFixed(2)} · total $${total.toFixed(2)}</small></div></li>`;
  }).join('');
  return `<div class="panel"><h2>Upgrade advisor</h2>
    <p class="hint" style="margin:0 0 8px">Now: turn 2 ${pctS(u.start.t2)}, turn 3 ${pctS(u.start.t3)}${u.start.win != null ? `, vs field ${pctS(u.start.win)}` : ''}. Best value first — each step builds on the one before.</p>
    <ul class="advice">${rows}</ul>
    <p class="hint">Prices are TCGplayer market prices (cheapest printing) and change daily.${u.usedMatchups ? '' : ' Tournament data was unavailable, so only setup speed was used.'}</p>
    <button data-act="copy-shopping">Copy shopping list</button></div>`;
}

async function runUpgrades(deck, rerender) {
  const x = extrasOf(deck);
  x.busy = 'upgrades'; x.progress = 'Loading tournament decks…'; rerender();
  try {
    let prep = null;
    try { prep = await prepareMeta(msg => { x.progress = msg; rerender(); }); } catch (e) { /* advisor still works on owned cards */ }
    const metaResolved = prep ? prep.profiles.map(p => Meta.resolved.get(p.id)).filter(Boolean) : [];
    x.upgrades = await findUpgrades(deck, { metaResolved, metaProfiles: prep?.profiles || [], k: prep?.k ?? 0 }, msg => { x.progress = msg; rerender(); });
  } catch (err) { console.error(err); x.upgrades = { error: 'Something went wrong: ' + err.message }; }
  x.busy = null; rerender();
}

function renderDeckTabsHeaderOnly() {
  document.querySelectorAll('#deckTabs button').forEach((b, i) => { b.querySelector('.dt-score').textContent = `Score ${currentDecks[i].score}/100 · ${currentDecks[i].stats.total} cards`; });
}

// ---------- Saved decks ----------
function renderSaved() {
  const list = SavedDecks.list();
  $('#savedList').innerHTML = list.length ? list.map(d => {
    const rot = d.format === 'standard' ? rotationReport(d.entries).count : 0;
    return `<div class="saved-item"><span class="nm">${esc(d.name)}</span><small>${esc(RULES.formats[d.format]?.label || '')} · ${d.stats.total} cards · score ${d.score} · saved ${new Date(d.saved || d.created).toLocaleDateString()}</small>${rot ? `<span class="badge warnb" title="Expected to leave Standard ${esc(NEXT_ROTATION.when)}">${rot} rotating</span>` : ''}<button data-open="${esc(d.id)}">Open</button></div>`;
  }).join('')
    : '<div class="empty">No saved decks yet. Build one on the <b>Build deck</b> tab and click <b>Save deck</b>.</div>';
}
$('#savedList').addEventListener('click', e => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  const d = SavedDecks.list().find(x => x.id === b.dataset.open);
  if (d) { renderDeck(d, $('#savedView'), { editable: true, saved: true }); $('#savedView').scrollIntoView({ behavior: 'smooth' }); }
});

// ---------- Tournament decks ----------
const metaOpen = new Set();
async function renderMeta(force = false) {
  const st = $('#metaStatus');
  setStatus(st, spin('Loading recent tournament decks…'));
  let m;
  try { m = await Meta.load(msg => setStatus(st, spin(msg)), { force }); }
  catch (err) { setStatus(st, 'Could not load tournament data: ' + esc(err.message), true); return; }
  setStatus(st, '');
  const dates = m.tournaments.map(t => t.date).sort();
  const d = s => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  $('#metaInfo').innerHTML = `<b>${m.lists.toLocaleString()} deck lists</b> from ${m.tournaments.length} recent online Standard tournaments on Limitless (${d(dates[0])}–${d(dates[dates.length - 1])}). Online events with public lists, not official majors.`;
  const coll = Collection.entries();
  $('#metaList').innerHTML = m.decks.map(deck => {
    const own = ownershipOf(deck, coll);
    const open = metaOpen.has(deck.id);
    const reals = m.decks.filter(o => o.id !== deck.id).map(o => ({ o, r: realMatchup(deck.id, o.id) })).filter(x => x.r).sort((a, b) => b.r.games - a.r.games).slice(0, 6);
    return `<div class="meta-item panel" data-meta="${esc(deck.id)}">
      <div class="meta-head">
        <div class="meta-name"><b>${esc(deck.name)}</b><small>${(deck.share * 100).toFixed(1)}% of decks · ${Math.round(deck.winRate * 100)}% match win rate · ${deck.count} players</small></div>
        <div class="own"><div class="simbar"><i style="width:${Math.round(own.have / own.total * 100)}%;background:${own.have >= 50 ? 'var(--good)' : own.have >= 30 ? 'var(--warn)' : 'var(--bad)'}"></i></div><small>You own <b>${own.have}/${own.total}</b></small></div>
        <button data-meta-toggle>${open ? 'Hide' : 'Details'}</button>
        <button data-meta-build title="Build the best version of this deck from your cards">Build my version</button>
      </div>
      ${open ? metaDetails(deck, own, reals) : ''}
    </div>`;
  }).join('');
}
function metaDetails(deck, own, reals) {
  const r = Meta.resolved.get(deck.id);
  const priceOf = item => {
    const e = r?.entries.find(x => x.card.name === item.name);
    return e ? Prices.get(e.card.id) : null;
  };
  let cost = 0, unknown = 0;
  const missingRows = own.missing.map(m => {
    const p = priceOf(m);
    const v = Prices.value(p);
    if (v != null) cost += v * m.need; else unknown++;
    return `<li>${m.need}× ${esc(m.name)} <small>${esc(m.set)} ${esc(m.number)}</small> <span class="price">${r ? Prices.fmt(p, m.need) : ''}</span></li>`;
  }).join('');
  const group = cat => deck.list.filter(c => c.category === cat).map(c => `<div>${c.count} ${esc(c.name)} <small>${esc(c.set)} ${esc(c.number)}</small></div>`).join('');
  return `<div class="meta-body">
    <div class="meta-cols">
      <div><h3 class="sub">Sample list</h3><small class="hint">${esc(deck.sample.player)} — #${deck.sample.placing} of ${deck.sample.players} at ${esc(deck.sample.event)}</small>
        <div class="meta-list"><b>Pokémon</b>${group('Pokemon')}<b>Trainers</b>${group('Trainer')}<b>Energy</b>${group('Energy')}</div>
        <button data-meta-copy>Copy list</button></div>
      <div><h3 class="sub">You're missing ${own.total - own.have} card${own.total - own.have === 1 ? '' : 's'}</h3>
        ${own.missing.length ? `<ul class="missing">${missingRows}</ul>
          ${r ? `<p><b>About $${cost.toFixed(2)}</b> to complete${unknown ? ` (+${unknown} without a price)` : ''} · TCGplayer market, cheapest printing</p>` : `<button data-meta-prices>Show prices</button>`}` : '<p>You own every card in this list!</p>'}
        ${reals.length ? `<h3 class="sub">Real results vs other decks</h3>${reals.map(x => `<div class="simrow mrow"><span>${esc(x.o.name)}</span><div class="simbar"><i style="width:${Math.round(x.r.win * 100)}%;background:${x.r.win >= 0.55 ? 'var(--good)' : x.r.win >= 0.45 ? 'var(--warn)' : 'var(--bad)'}"></i></div><b>${pctS(x.r.win)}</b><small>${x.r.games} games</small></div>`).join('')}` : ''}
      </div>
    </div></div>`;
}
$('#metaList').addEventListener('click', async e => {
  const item = e.target.closest('[data-meta]');
  if (!item) return;
  const deck = Meta.data.decks.find(d => d.id === item.dataset.meta);
  if (e.target.closest('[data-meta-toggle]')) {
    if (metaOpen.has(deck.id)) metaOpen.delete(deck.id); else metaOpen.add(deck.id);
    renderMeta();
    return;
  }
  if (e.target.closest('[data-meta-prices]')) {
    e.target.closest('button').innerHTML = spin('Loading prices…');
    await Meta.resolveDeck(deck);
    renderMeta();
    return;
  }
  if (e.target.closest('[data-meta-copy]')) {
    const sec = (title, cat) => { const l = deck.list.filter(c => c.category === cat); return [`${title}: ${l.reduce((a, c) => a + c.count, 0)}`, ...l.map(c => `${c.count} ${c.name} ${c.set} ${c.number}`)].join('\n'); };
    navigator.clipboard?.writeText([sec('Pokémon', 'Pokemon'), sec('Trainer', 'Trainer'), sec('Energy', 'Energy'), '', 'Total Cards: 60'].join('\n\n')).then(() => toast('List copied — paste it into Pokémon TCG Live'));
    return;
  }
  if (e.target.closest('[data-meta-build]')) {
    // Build around the archetype's main attacker using the user's cards
    e.target.closest('button').innerHTML = spin('Preparing…');
    const r = await Meta.resolveDeck(deck);
    const core = r.core || deck.name;
    $('#fmt').value = 'standard';
    $('#focus').value = core;
    showTab('build');
    $('#generateBtn').click();
    toast(Collection.entries().some(x => x.card.name === core) ? `Building around ${core}` : `You don't own ${core} yet — showing your best decks instead`);
  }
});
$('#metaRefresh').addEventListener('click', () => { Meta.profiles = null; Meta.resolved.clear(); renderMeta(true); });

// ---------- Collection value & stats ----------
$('#statsBtn').addEventListener('click', () => {
  const p = $('#statsPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) renderStats();
});
async function renderStats() {
  const p = $('#statsPanel');
  const entries = Collection.entries();
  if (!entries.length) { p.innerHTML = '<div class="panel"><p class="hint">Add some cards first.</p></div>'; return; }
  p.innerHTML = `<div class="panel"><p class="hint">${spin('Loading prices…')}</p></div>`;
  await loadPrices(entries.map(e => e.card.id), (n, t) => { p.innerHTML = `<div class="panel"><p class="hint">${spin(`Loading prices… ${n}/${t}`)}</p></div>`; });
  const val = e => (Prices.value(Prices.get(e.card.id)) ?? 0);
  const priced = entries.filter(e => Prices.value(Prices.get(e.card.id)) != null);
  const total = entries.reduce((a, e) => a + val(e) * e.qty, 0);
  const cards = entries.reduce((a, e) => a + e.qty, 0);
  const top = entries.slice().sort((a, b) => val(b) - val(a)).slice(0, 10);
  // Set completion (unique numbers owned / printed set size)
  const sets = new Map();
  for (const e of entries) {
    if (!e.card.setTotal) continue;
    const s = sets.get(e.card.setId) || { name: e.card.setName, total: e.card.setTotal, nums: new Set() };
    s.nums.add(e.card.localId); // secret rares (numbered past the set size) count too
    s.total = Math.max(s.total, s.nums.size);
    sets.set(e.card.setId, s);
  }
  const setRows = [...sets.values()].map(s => ({ ...s, pct: s.nums.size / s.total })).sort((a, b) => b.pct - a.pct).slice(0, 12);
  // Tradeable extras: copies beyond a playset of 4 (by card name; basic Energy excluded)
  const byName = new Map();
  for (const e of entries) { if (isBasicEnergy(e.card)) continue; const g = byName.get(e.card.name) || { name: e.card.name, qty: 0, list: [] }; g.qty += e.qty; g.list.push(e); byName.set(e.card.name, g); }
  const extras = [...byName.values()].filter(g => g.qty > 4).map(g => {
    const cheapest = g.list.slice().sort((a, b) => val(a) - val(b));
    let n = g.qty - 4, v = 0;
    for (const e of cheapest) { const k = Math.min(n, e.qty); v += k * val(e); n -= k; if (!n) break; }
    return { name: g.name, extra: g.qty - 4, value: v };
  }).sort((a, b) => b.value - a.value);
  const rar = new Map();
  for (const e of entries) rar.set(e.card.rarity || 'Unknown', (rar.get(e.card.rarity || 'Unknown') || 0) + e.qty);
  const rot = entries.filter(e => NEXT_ROTATION.marks.includes(e.card.regulationMark) && e.card.legal.standard).reduce((a, e) => a + e.qty, 0);
  p.innerHTML = `<div class="panel stats">
    <div class="stat-grid four">
      <div class="stat"><b>$${total.toFixed(2)}</b><small>Estimated collection value</small></div>
      <div class="stat"><b>${cards}</b><small>Cards (${entries.length} unique)</small></div>
      <div class="stat"><b>${priced.length ? '$' + (total / cards).toFixed(2) : '—'}</b><small>Average per card</small></div>
      <div class="stat"><b>${rot}</b><small>Cards expected to rotate ${esc(NEXT_ROTATION.when)}</small></div>
    </div>
    <div class="stats-cols">
      <div><h3 class="sub">Most valuable</h3><ol class="top">${top.map(e => `<li>${esc(e.card.name)} <small>${esc(e.card.setName)}${e.qty > 1 ? ` ×${e.qty}` : ''}</small><span class="price">${Prices.fmt(Prices.get(e.card.id))}</span></li>`).join('')}</ol></div>
      <div><h3 class="sub">Set completion</h3>${setRows.map(s => `<div class="simrow mrow"><span title="${esc(s.name)}">${esc(s.name)}</span><div class="simbar"><i style="width:${Math.max(2, Math.round(s.pct * 100))}%;background:var(--accent-2)"></i></div><b>${Math.round(s.pct * 100)}%</b><small>${s.nums.size}/${s.total}</small></div>`).join('')}</div>
      <div><h3 class="sub">Spare copies to trade</h3>${extras.length ? `<ul class="missing">${extras.map(x => `<li>${x.extra}× ${esc(x.name)}<span class="price">$${x.value.toFixed(2)}</span></li>`).join('')}</ul><p class="hint">Copies beyond 4 of a card (you can only play 4).</p>` : '<p class="hint">No spare copies beyond a playset of 4.</p>'}
        <h3 class="sub">By rarity</h3><div class="legend">${[...rar].sort((a, b) => b[1] - a[1]).map(([r, n]) => `<span style="--c:var(--accent-2)">${n} ${esc(r)}</span>`).join('')}</div></div>
    </div>
    <p class="hint">Prices are TCGplayer market prices (USD) for the cheapest version of each printing; when TCGplayer has none, the Cardmarket € price is counted as-is. Cached for 3 days. ${entries.length - priced.length ? `${entries.length - priced.length} cards had no price.` : ''}</p>
  </div>`;
}

// ---------- Light / dark switch ----------
function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function syncThemeIcon() {
  $('#themeBtn use').setAttribute('href', currentTheme() === 'dark' ? '#i-sun' : '#i-moon');
}
$('#themeBtn').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('df.theme', next); } catch (e) { /* ignore */ }
  syncThemeIcon();
});
syncThemeIcon();

// ---------- Install as an app ----------
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;
// Android / desktop Chrome & Edge: the browser offers a real install prompt
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  if (!isStandalone()) $('#installBtn').hidden = false;
});
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; installPrompt = null; toast('Deck Forge installed — find it on your home screen'); });
// iPhone / iPad Safari: no prompt exists, so show the steps instead
if (isIOS() && !isStandalone()) $('#installBtn').hidden = false;
$('#installBtn').addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') $('#installBtn').hidden = true;
    installPrompt = null;
  } else {
    $('#installHelp').showModal();
  }
});
$('#installHelp').addEventListener('click', e => { if (e.target.id === 'installHelp') $('#installHelp').close(); });
if (isStandalone()) document.documentElement.classList.add('standalone');

// Offline support + instant start once installed
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Friendly starting point on the Add cards page (replaced by results once you search or scan)
$('#results').innerHTML = `<div class="empty getting-started">
  <svg class="i big-i"><use href="#i-cards"/></svg>
  <h3>Start building your collection</h3>
  <p>Search for a card, type the set and number printed on it, or scan it with your camera. Every card you add can be used in every deck you build.</p>
</div>`;

// ---------- Init ----------
Collection.load();
updateCount();
CardDB.loadSets().catch(() => {});
// Open on the tab named in the link (home-screen shortcuts use ?tab=add / ?tab=build), else the last one used
try {
  const want = new URLSearchParams(location.search).get('tab') || localStorage.getItem('df.tab');
  if (want && document.getElementById('tab-' + want)) showTab(want);
} catch (e) { /* ignore */ }
