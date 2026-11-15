// PDF Cut — trims PDF margins and exports e-reader friendly files.
// Everything runs client-side: pdf.js renders/analyses pages, pdf-lib writes
// the cropped PDF, JSZip packages EPUB/KEPUB/CBZ.
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), pick: $('pick'), fileinfo: $('fileinfo'),
  workspace: $('workspace'),
  mode: $('mode'), padding: $('padding'), sens: $('sens'), edge: $('edge'),
  skipFull: $('skipFull'), ignoreHF: $('ignoreHF'),
  device: $('device'), customDims: $('customDims'), cw: $('cw'), ch: $('ch'),
  gray: $('gray'), qual: $('qual'), title: $('title'), author: $('author'),
  prev: $('prev'), next: $('next'), pageLabel: $('pageLabel'),
  stage: $('stage'), pv: $('pv'), cropbox: $('cropbox'), cropInfo: $('cropInfo'),
  resetPage: $('resetPage'), applyAll: $('applyAll'), toggleResult: $('toggleResult'), resetAll: $('resetAll'),
  progress: $('progress'), bar: $('bar'), status: $('status'),
  allWrap: $('allWrap'), allFiles: $('allFiles'), allCount: $('allCount'), mainLabel: $('mainLabel'), mainSub: $('mainSub'),
};

const state = {
  // Fields of the active document (swapped in/out by activate()):
  bytes: null,        // Uint8Array of the original PDF (kept pristine for pdf-lib)
  doc: null,          // pdf.js document
  baseName: 'book',
  pages: [],          // per page: { w, h, view, rotate, map, mw, mh, bg }
  overrides: {},      // page index -> manual crop (fractions)
  current: 0,
  // Derived for the active document by recompute():
  boxes: [],          // per page detected content box (fractions) or null
  full: [],           // per page: full-bleed (cover / full-page image)
  auto: [],           // per page automatic crop (fractions) {l,t,r,b}
  crops: [],          // per page final crop = override || auto
  // UI:
  active: null,       // active entry of `docs`
  previewCache: null, // { index, canvas }
  showResult: false,
  busy: false,        // generating output
  loading: false,     // analysing queued files
};

// Every loaded file. Each keeps its own pages, manual crops, title and author.
const docs = [];
const DOC_FIELDS = ['bytes', 'doc', 'baseName', 'pages', 'overrides', 'current'];
const queue = [];
let docSeq = 0;

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

// ---------------------------------------------------------------- loading

els.pick.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => { addFiles(els.file.files); els.file.value = ''; });
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === els.drop) els.drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files || []));

function addFiles(files) {
  const pdfs = [...files].filter(isPdf);
  if (!pdfs.length) {
    if (files.length) els.fileinfo.textContent = 'Only PDF files are supported.';
    return;
  }
  for (const f of pdfs) {
    const d = {
      id: ++docSeq, name: f.name, file: f, status: 'queued', progress: 0, error: '',
      bytes: null, doc: null, baseName: f.name.replace(/\.pdf$/i, '') || 'book',
      pages: [], overrides: {}, current: 0, title: '', author: '',
    };
    docs.push(d);
    queue.push(d);
  }
  els.fileinfo.textContent = '';
  els.drop.classList.add('compact');
  els.pick.textContent = 'Add PDFs';
  $('dropHint').textContent = 'or drop more here';
  renderFileList();
  processQueue();
}

async function processQueue() {
  if (state.loading) return;
  state.loading = true;
  updateButtons();
  while (queue.length) {
    const d = queue.shift();
    if (!docs.includes(d)) continue; // removed while waiting
    try {
      await loadDoc(d);
      d.status = 'ready';
    } catch (err) {
      console.error(err);
      d.status = 'error';
      d.error = err.message || String(err);
    }
    d.file = null;
    if (d.status === 'ready' && !state.active && docs.includes(d)) {
      els.workspace.hidden = false;
      activate(d);
    }
    renderFileList();
  }
  state.loading = false;
  showProgress(false);
  updateButtons();
  renderFileList();
}

async function loadDoc(d) {
  d.status = 'loading';
  renderFileList();
  const buf = new Uint8Array(await d.file.arrayBuffer());
  d.bytes = buf;
  // pdf.js may transfer the buffer to its worker, so hand it a copy.
  d.doc = await pdfjsLib.getDocument({ data: buf.slice() }).promise;
  let meta = {};
  try { meta = (await d.doc.getMetadata()).info || {}; } catch { /* ignore */ }
  d.title = (meta.Title && String(meta.Title).trim()) || d.baseName;
  d.author = (meta.Author && String(meta.Author).trim()) || '';
  const n = d.doc.numPages;
  const longSide = n > 600 ? 300 : 400; // smaller maps for long documents
  showProgress(true);
  for (let i = 0; i < n; i++) {
    if (!docs.includes(d)) throw new Error('removed');
    d.progress = i / n;
    setProgress(i / n, `${d.name}: analysing page ${i + 1} of ${n}`);
    renderFileList();
    d.pages.push(await analysePage(d.doc, i, longSide));
  }
}

// Make `d` the document shown in the preview (and used by recompute/output).
function activate(d, { preview = true } = {}) {
  const prev = state.active;
  if (prev && prev !== d && docs.includes(prev)) {
    for (const k of DOC_FIELDS) prev[k] = state[k];
    prev.title = els.title.value;
    prev.author = els.author.value;
  }
  state.active = d;
  for (const k of DOC_FIELDS) state[k] = d[k];
  els.title.value = d.title;
  els.author.value = d.author;
  state.previewCache = null;
  imageCache = null;
  recompute(preview);
  renderFileList();
}

function removeDoc(d) {
  if (state.busy) return;
  const i = docs.indexOf(d);
  if (i < 0) return;
  docs.splice(i, 1);
  if (state.active === d) {
    state.active = null;
    const next = docs.find((x) => x.status === 'ready');
    if (next) activate(next);
    else {
      els.workspace.hidden = true;
      Object.assign(state, { bytes: null, doc: null, pages: [], overrides: {}, current: 0, crops: [] });
    }
  }
  if (d.doc && d.status !== 'loading') d.doc.destroy();
  if (!docs.length) {
    els.drop.classList.remove('compact');
    els.pick.textContent = 'Choose PDFs';
    $('dropHint').textContent = 'or drop them here. You can pick several at once.';
  }
  renderFileList();
}

function renderFileList() {
  const ul = $('fileList');
  ul.hidden = !docs.length;
  ul.replaceChildren(...docs.map((d) => {
    const li = document.createElement('li');
    if (d === state.active) li.classList.add('active');
    if (d.status === 'error') li.classList.add('error');
    const sel = document.createElement('button');
    sel.type = 'button';
    sel.className = 'file-sel';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = d.status === 'ready' ? `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}`
      : d.status === 'loading' ? `Analysing ${Math.round(d.progress * 100)}%`
      : d.status === 'queued' ? 'Waiting…' : 'Could not open';
    if (d.status === 'error') sel.title = d.error;
    sel.append(name, meta);
    sel.disabled = d.status !== 'ready' || state.busy;
    sel.setAttribute('aria-current', d === state.active ? 'true' : 'false');
    sel.addEventListener('click', () => { if (d !== state.active && !state.busy) activate(d); });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'file-rm';
    rm.textContent = '×';
    rm.setAttribute('aria-label', `Remove ${d.name}`);
    rm.disabled = state.busy;
    rm.addEventListener('click', () => removeDoc(d));
    li.append(sel, rm);
    return li;
  }));
  const ready = docs.filter((d) => d.status === 'ready').length;
  els.allWrap.hidden = ready < 2;
  els.allCount.textContent = ready;
  updateMainLabel();
}

const batchMode = () => !els.allWrap.hidden && els.allFiles.checked;
function updateMainLabel() {
  const n = docs.filter((d) => d.status === 'ready').length;
  els.mainLabel.textContent = batchMode() ? `Download all ${n} for Kobo` : 'Download for Kobo';
  els.mainSub.textContent = batchMode() ? '.zip of .kepub.epub files' : '.kepub.epub';
}
els.allFiles.addEventListener('change', updateMainLabel);

function updateButtons() {
  const off = state.busy || state.loading;
  document.querySelectorAll('button[data-fmt]').forEach((b) => (b.disabled = off));
}

// Render a page small and store how far each pixel is from the page's
// background tone (median luminance). Works for white, cream or dark pages.
async function analysePage(pdf, index, longSide) {
  const page = await pdf.getPage(index + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = longSide / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const mw = Math.max(1, Math.round(vp.width));
  const mh = Math.max(1, Math.round(vp.height));
  const canvas = analysePage.canvas || (analysePage.canvas = document.createElement('canvas'));
  canvas.width = mw; canvas.height = mh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, mw, mh);
  const map = new Uint8Array(mw * mh);
  let bg = 255;
  try {
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const px = ctx.getImageData(0, 0, mw, mh).data;
    const lum = new Uint8Array(mw * mh);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
      const l = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000 | 0;
      lum[i] = l; hist[l]++;
    }
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lum.length / 2) { bg = v; break; } }
    for (let i = 0; i < lum.length; i++) map[i] = Math.abs(lum[i] - bg);
  } catch (err) {
    console.warn(`Page ${index + 1} failed to render for analysis`, err);
  }
  page.cleanup();
  return { w: vp1.width, h: vp1.height, view: page.view.slice(), rotate: page.rotate, map, mw, mh, bg };
}

// ---------------------------------------------------------------- detection

function settings() {
  let dims;
  if (els.device.value === 'custom') dims = [+els.cw.value || 1264, +els.ch.value || 1680];
  else dims = els.device.value.split('x').map((s) => parseInt(s, 10));
  return {
    mode: els.mode.value,
    pad: +els.padding.value / 100,
    sens: +els.sens.value,
    edge: +els.edge.value / 100,
    skipFull: els.skipFull.checked,
    ignoreHF: els.ignoreHF.checked,
    devW: dims[0], devH: dims[1],
    gray: els.gray.checked,
    quality: +els.qual.value / 100,
  };
}

// Content bounding box of a page's deviation map, as fractions of the page.
function detectBox(p, s) {
  const { map, mw: W, mh: H } = p;
  const x0 = Math.floor(s.edge * W), x1 = W - x0;
  const y0 = Math.floor(s.edge * H), y1 = H - y0;
  if (x1 <= x0 || y1 <= y0) return { box: null, full: false };
  const minCount = Math.max(2, Math.ceil(0.004 * Math.max(W, H)));
  const thr = s.sens;

  const rowOk = new Uint8Array(H);
  for (let y = y0; y < y1; y++) {
    let c = 0;
    const off = y * W;
    for (let x = x0; x < x1; x++) if (map[off + x] > thr) c++;
    rowOk[y] = c >= minCount ? 1 : 0;
  }
  let top = -1, bot = -1;
  for (let y = y0; y < y1; y++) if (rowOk[y]) { if (top < 0) top = y; bot = y + 1; }
  if (top < 0) return { box: null, full: false };
  if (s.ignoreHF) [top, bot] = stripEdgeBlocks(rowOk, top, bot, H, 0.06, 0.15);

  const colOk = new Uint8Array(W);
  for (let x = x0; x < x1; x++) {
    let c = 0;
    for (let y = top; y < bot; y++) if (map[y * W + x] > thr) { if (++c >= minCount) break; }
    colOk[x] = c >= minCount ? 1 : 0;
  }
  let left = -1, right = -1;
  for (let x = x0; x < x1; x++) if (colOk[x]) { if (left < 0) left = x; right = x + 1; }
  if (left < 0) return { box: null, full: false };
  // Side stamps (e.g. arXiv identifiers), line numbers and stray marginal marks.
  [left, right] = stripEdgeBlocks(colOk, left, right, W, 0.05, 0.15);

  const box = { l: left / W, t: top / H, r: right / W, b: bot / H };
  const spanW = (x1 - x0) / W, spanH = (y1 - y0) / H;
  const full = (box.r - box.l) >= spanW * 0.96 && (box.b - box.t) >= spanH * 0.96;
  return { box, full };
}

// Given a 1-D "has ink" profile, drop a thin block at either end that is
// separated from the body by a clear gap (running heads, page numbers, stamps).
function stripEdgeBlocks(ok, start0, end0, size, maxThick, zone) {
  const blocks = [];
  const gapMin = Math.max(3, Math.round(size * 0.012));
  let start = -1, last = -1;
  for (let i = start0; i < end0; i++) {
    if (!ok[i]) continue;
    if (start < 0) start = i;
    else if (i - last > gapMin) { blocks.push([start, last + 1]); start = i; }
    last = i;
  }
  if (start >= 0) blocks.push([start, last + 1]);
  if (blocks.length < 2) return [start0, end0];
  const thin = (b) => b[1] - b[0] <= size * maxThick;
  let a = 0, z = blocks.length - 1;
  if (thin(blocks[a]) && blocks[a][1] <= size * zone && blocks[a + 1][0] - blocks[a][1] >= gapMin * 1.5) a++;
  if (z > a && thin(blocks[z]) && blocks[z][0] >= size * (1 - zone) && blocks[z][0] - blocks[z - 1][1] >= gapMin * 1.5) z--;
  return [blocks[a][0], blocks[z][1]];
}

const FULL = Object.freeze({ l: 0, t: 0, r: 1, b: 1 });
const unionBox = (a, b) => (!a ? { ...b } : !b ? { ...a } : { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) });
const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[s.length >> 1]; };

// Pages share a crop only with pages of the same size/orientation (and parity
// in odd/even mode), so mixed-size documents don't get a nonsense union.
function groupOf(i, s) {
  const p = state.pages[i];
  return `${s.mode === 'oddeven' ? i % 2 : 0}:${Math.round(p.w / 4)}x${Math.round(p.h / 4)}`;
}

function recompute(preview = true) {
  const s = settings();
  const n = state.pages.length;
  state.boxes = new Array(n);
  state.full = new Array(n);
  for (let i = 0; i < n; i++) {
    const { box, full } = detectBox(state.pages[i], s);
    state.boxes[i] = box;
    state.full[i] = full;
  }
  // A page whose background differs from the document's usual paper tone
  // (e.g. a coloured cover or full-page photo) counts as full-bleed too.
  const paper = median(state.pages.map((p) => p.bg));
  for (let i = 0; i < n; i++) if (Math.abs(state.pages[i].bg - paper) > s.sens) state.full[i] = true;

  const eligible = (i) => state.boxes[i] && !(s.skipFull && state.full[i]);
  const groupBox = {};
  if (s.mode !== 'perpage') {
    const members = {};
    for (let i = 0; i < n; i++) if (eligible(i)) (members[groupOf(i, s)] ||= []).push(i);
    for (const g in members) {
      const idx = members[g];
      const bs = idx.map((i) => state.boxes[i]);
      // Pages that stick out well past the typical page (a wide figure, a
      // stamp on the first page) don't widen the shared crop; they get their
      // own wider crop below instead.
      let core = bs;
      if (bs.length >= 3) {
        const m = { l: median(bs.map((b) => b.l)), t: median(bs.map((b) => b.t)), r: median(bs.map((b) => b.r)), b: median(bs.map((b) => b.b)) };
        const tol = 0.05;
        const inl = bs.filter((b) => b.l >= m.l - tol && b.t >= m.t - tol && b.r <= m.r + tol && b.b <= m.b + tol);
        if (inl.length) core = inl;
      }
      groupBox[g] = core.reduce((u, b) => unionBox(u, b), null);
    }
  }
  state.auto = state.boxes.map((b, i) => {
    if (s.skipFull && state.full[i]) return { ...FULL };
    let c = b;
    if (s.mode !== 'perpage') {
      const g = groupBox[groupOf(i, s)];
      c = g ? unionBox(g, b) : b; // never cut a page's own content
    }
    if (!c) return { ...FULL };
    const p = state.pages[i];
    // Equal absolute padding on all sides, relative to the shorter page side.
    const padPts = s.pad * Math.min(p.w, p.h);
    const px = padPts / p.w, py = padPts / p.h;
    return { l: Math.max(0, c.l - px), t: Math.max(0, c.t - py), r: Math.min(1, c.r + px), b: Math.min(1, c.b + py) };
  });
  applyOverrides(preview);
}

function applyOverrides(preview = true) {
  state.crops = state.auto.map((a, i) => state.overrides[i] || a);
  if (preview) drawPreview();
}

// ---------------------------------------------------------------- preview

async function drawPreview() {
  const i = state.current;
  const n = state.pages.length;
  if (!n) return;
  els.pageLabel.textContent = `Page ${i + 1} / ${n}`;
  els.prev.disabled = i === 0;
  els.next.disabled = i === n - 1;

  if (!state.previewCache || state.previewCache.index !== i) {
    const page = await state.doc.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const target = 1000 * Math.min(2, window.devicePixelRatio || 1) / 1.25;
    const vp = page.getViewport({ scale: target / Math.max(vp1.width, vp1.height) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (state.current !== i) return; // user moved on meanwhile
    state.previewCache = { index: i, canvas: c };
  }
  const src = state.previewCache.canvas;
  const crop = state.crops[i];
  const W = src.width, H = src.height;
  const out = els.pv, ctx = out.getContext('2d');
  els.stage.classList.toggle('result', state.showResult);
  if (state.showResult) {
    const cx = crop.l * W, cy = crop.t * H, cw = (crop.r - crop.l) * W, chh = (crop.b - crop.t) * H;
    out.width = Math.max(1, Math.round(cw)); out.height = Math.max(1, Math.round(chh));
    ctx.drawImage(src, cx, cy, cw, chh, 0, 0, out.width, out.height);
  } else {
    if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
    ctx.drawImage(src, 0, 0);
  }
  positionCropbox();
  updateInfo();
}

function positionCropbox() {
  const c = state.crops[state.current];
  if (!c) return;
  const b = els.cropbox.style;
  b.left = `${c.l * 100}%`; b.top = `${c.t * 100}%`;
  b.width = `${(c.r - c.l) * 100}%`; b.height = `${(c.b - c.t) * 100}%`;
  els.cropbox.classList.toggle('manual', !!state.overrides[state.current]);
}

function updateInfo() {
  const i = state.current;
  const s = settings();
  const manual = !!state.overrides[i];
  const [ow, oh] = outputSize(state.pages[i], state.crops[i], s);
  let what = manual ? 'Manual crop' : 'Auto crop';
  if (!manual && s.skipFull && state.full[i]) what = 'Cover / full-page image, not cropped';
  else if (!manual && !state.boxes[i]) what = 'Blank page';
  els.cropInfo.textContent = state.showResult
    ? `${what} · ${ow}×${oh}px on your e-reader`
    : `${what} · drag the box to adjust`;
  els.resetPage.disabled = !manual;
  const mode = s.mode;
  els.applyAll.textContent = mode === 'oddeven' ? `Use on all ${(i + 1) % 2 ? 'odd' : 'even'} pages` : 'Use on all pages';
  els.resetAll.disabled = !Object.keys(state.overrides).length;
}

// Drag handles / move the crop box (mouse + touch via pointer events).
let drag = null;
els.cropbox.addEventListener('pointerdown', (e) => {
  const h = e.target.dataset.h || 'move';
  const rect = els.stage.getBoundingClientRect();
  drag = { h, id: e.pointerId, x: e.clientX, y: e.clientY, w: rect.width, hgt: rect.height, start: { ...state.crops[state.current] } };
  els.cropbox.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.cropbox.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = (e.clientX - drag.x) / drag.w, dy = (e.clientY - drag.y) / drag.hgt;
  const s0 = drag.start, MIN = 0.05;
  const c = { ...s0 };
  const h = drag.h;
  if (h === 'move') {
    const w = s0.r - s0.l, hh = s0.b - s0.t;
    c.l = Math.min(Math.max(0, s0.l + dx), 1 - w); c.r = c.l + w;
    c.t = Math.min(Math.max(0, s0.t + dy), 1 - hh); c.b = c.t + hh;
  } else {
    if (h.includes('w')) c.l = Math.min(Math.max(0, s0.l + dx), s0.r - MIN);
    if (h.includes('e')) c.r = Math.max(Math.min(1, s0.r + dx), s0.l + MIN);
    if (h.includes('n')) c.t = Math.min(Math.max(0, s0.t + dy), s0.b - MIN);
    if (h.includes('s')) c.b = Math.max(Math.min(1, s0.b + dy), s0.t + MIN);
  }
  state.overrides[state.current] = c;
  state.crops[state.current] = c;
  positionCropbox();
});
const endDrag = (e) => { if (drag && e.pointerId === drag.id) { drag = null; updateInfo(); } };
els.cropbox.addEventListener('pointerup', endDrag);
els.cropbox.addEventListener('pointercancel', endDrag);

els.resetPage.addEventListener('click', () => { delete state.overrides[state.current]; applyOverrides(); });
els.resetAll.addEventListener('click', () => { state.overrides = {}; applyOverrides(); });
els.applyAll.addEventListener('click', () => {
  const s = settings();
  const i = state.current;
  const c = { ...state.crops[i] };
  const g = groupOf(i, s);
  for (let j = 0; j < state.pages.length; j++) {
    if (s.mode === 'oddeven' && j % 2 !== i % 2) continue;
    if (groupOf(j, s).split(':')[1] !== g.split(':')[1]) continue; // same page size only
    state.overrides[j] = { ...c };
  }
  applyOverrides();
});
els.toggleResult.addEventListener('click', () => {
  state.showResult = !state.showResult;
  els.toggleResult.setAttribute('aria-pressed', String(state.showResult));
  els.toggleResult.textContent = state.showResult ? 'Edit crop' : 'Show result';
  drawPreview();
});

els.prev.addEventListener('click', () => { if (state.current > 0) { state.current--; drawPreview(); } });
els.next.addEventListener('click', () => { if (state.current < state.pages.length - 1) { state.current++; drawPreview(); } });
document.addEventListener('keydown', (e) => {
  if (els.workspace.hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'ArrowLeft') els.prev.click();
  if (e.key === 'ArrowRight') els.next.click();
});

for (const [inp, out] of [['padding', 'paddingOut'], ['sens', 'sensOut'], ['edge', 'edgeOut'], ['qual', 'qualOut']]) {
  els[inp].addEventListener('input', () => { $(out).textContent = els[inp].value; });
}
let rcTimer = 0;
const scheduleRecompute = () => { clearTimeout(rcTimer); rcTimer = setTimeout(() => state.active && !state.busy && recompute(), 60); };
for (const id of ['mode', 'padding', 'sens', 'edge', 'skipFull', 'ignoreHF']) {
  els[id].addEventListener('input', scheduleRecompute);
  els[id].addEventListener('change', scheduleRecompute);
}
els.device.addEventListener('change', () => { els.customDims.hidden = els.device.value !== 'custom'; if (state.pages.length) updateInfo(); });
for (const id of ['cw', 'ch']) els[id].addEventListener('input', () => state.pages.length && updateInfo());

// ---------------------------------------------------------------- output

function outputSize(p, crop, s) {
  const cw = p.w * (crop.r - crop.l), ch = p.h * (crop.b - crop.t);
  const scale = Math.min(s.devW / cw, s.devH / ch);
  return [Math.max(1, Math.round(cw * scale)), Math.max(1, Math.round(ch * scale)), scale];
}

// Render the crop region of a page directly at device resolution.
async function renderPageImage(i, s) {
  const p = state.pages[i];
  const crop = state.crops[i];
  const [ow, oh, scale] = outputSize(p, crop, s);
  const page = await state.doc.getPage(i + 1);
  const vp = page.getViewport({ scale });
  const c = renderPageImage.canvas || (renderPageImage.canvas = document.createElement('canvas'));
  c.width = ow; c.height = oh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ow, oh);
  await page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: [1, 0, 0, 1, -crop.l * vp.width, -crop.t * vp.height],
  }).promise;
  page.cleanup();
  if (s.gray) {
    const img = ctx.getImageData(0, 0, ow, oh);
    const d = img.data;
    for (let j = 0; j < d.length; j += 4) {
      const l = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
      d[j] = d[j + 1] = d[j + 2] = l;
    }
    ctx.putImageData(img, 0, 0);
  }
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Image encoding failed'))), 'image/jpeg', s.quality));
  return { blob, width: ow, height: oh };
}

async function renderAllImages(s) {
  const n = state.pages.length;
  const images = [];
  for (let i = 0; i < n; i++) {
    setProgress(i / n, `Rendering page ${i + 1} of ${n}`);
    images.push(await renderPageImage(i, s));
  }
  return images;
}

const xml = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const pad4 = (i) => String(i + 1).padStart(4, '0');

// Flatten the PDF outline into [{title, page, depth}] for the EPUB TOC.
async function readOutline() {
  const out = [];
  let outline = null;
  try { outline = await state.doc.getOutline(); } catch { /* none */ }
  const walk = async (items, depth) => {
    for (const it of items || []) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await state.doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          page = typeof dest[0] === 'number' ? dest[0] : await state.doc.getPageIndex(dest[0]);
        }
      } catch { /* unresolved */ }
      const title = (it.title || '').trim();
      if (page != null && page >= 0 && page < state.pages.length && title) out.push({ title, page, depth });
      await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return out;
}

// Nested <ol> for the EPUB 3 nav document.
function navList(entries) {
  let html = '';
  let depth = -1;
  for (const e of entries) {
    const d = Math.min(e.depth, depth + 1);
    if (d > depth) html += '<ol>'.repeat(d - depth);
    else { html += '</li>'; html += '</ol></li>'.repeat(depth - d); }
    html += `<li><a href="pages/p${pad4(e.page)}.xhtml">${xml(e.title)}</a>`;
    depth = d;
  }
  html += '</li>' + '</ol></li>'.repeat(depth) + '</ol>';
  return html;
}

async function buildEpub(s, images) {
  setProgress(1, 'Packaging EPUB…');
  const title = els.title.value.trim() || state.baseName;
  const author = els.author.value.trim();
  const id = 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16));
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const n = images.length;
  let toc = await readOutline();
  if (!toc.length) toc = [{ title, page: 0, depth: 0 }];

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

  zip.file('OEBPS/style.css',
    `@page { margin: 0; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
div.page { margin: 0; padding: 0; position: relative; width: 100%; height: 100%; }
img { position: absolute; top: 0; left: 0; margin: 0; padding: 0; border: 0; }`);

  const manifest = [];
  const spine = [];
  for (let i = 0; i < n; i++) {
    const { blob, width, height } = images[i];
    const k = pad4(i);
    zip.file(`OEBPS/images/p${k}.jpg`, blob, { compression: 'STORE' });
    zip.file(`OEBPS/pages/p${k}.xhtml`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${xml(title)} — ${i + 1}</title>
  <meta name="viewport" content="width=${width}, height=${height}"/>
  <link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body style="width:${width}px; height:${height}px;">
  <div class="page"><img src="../images/p${k}.jpg" width="${width}" height="${height}" style="width:${width}px; height:${height}px;" alt="Page ${i + 1}"/></div>
</body>
</html>`);
    manifest.push(`<item id="img${k}" href="images/p${k}.jpg" media-type="image/jpeg"${i === 0 ? ' properties="cover-image"' : ''}/>`);
    manifest.push(`<item id="p${k}" href="pages/p${k}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="p${k}"/>`);
  }

  const pageList = images.map((_, i) => `<li><a href="pages/p${pad4(i)}.xhtml">${i + 1}</a></li>`).join('');
  zip.file('OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${xml(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>Contents</h1>${navList(toc)}</nav>
  <nav epub:type="page-list" hidden=""><ol>${pageList}</ol></nav>
</body>
</html>`);

  let play = 0;
  zip.file('OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${xml(id)}"/><meta name="dtb:depth" content="1"/>
  <meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
  <docTitle><text>${xml(title)}</text></docTitle>
  <navMap>${toc.map((e) => `<navPoint id="nav${++play}" playOrder="${play}"><navLabel><text>${xml(e.title)}</text></navLabel><content src="pages/p${pad4(e.page)}.xhtml"/></navPoint>`).join('')}</navMap>
</ncx>`);

  const first = images[0];
  zip.file('OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${xml(id)}</dc:identifier>
    <dc:title>${xml(title)}</dc:title>
    ${author ? `<dc:creator>${xml(author)}</dc:creator>` : ''}
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">none</meta>
    <meta name="cover" content="img0001"/>
    <meta name="fixed-layout" content="true"/>
    <meta name="original-resolution" content="${first.width}x${first.height}"/>
    <meta name="book-type" content="comic"/>
    <meta name="zero-gutter" content="true"/>
    <meta name="zero-margin" content="true"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>`);

  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' },
    (m) => setProgress(m.percent / 100, 'Packaging EPUB…'));
}

async function buildCbz(images) {
  const zip = new JSZip();
  images.forEach((im, i) => zip.file(`${pad4(i)}.jpg`, im.blob, { compression: 'STORE' }));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.comicbook+zip' },
    (m) => setProgress(m.percent / 100, 'Packaging CBZ…'));
}

// Crop the original PDF by rewriting each page's boxes — keeps vector text.
async function buildCroppedPdf() {
  setProgress(0, 'Cropping PDF…');
  const { PDFDocument } = window.PDFLib;
  const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const info = state.pages[i];
    const crop = state.crops[i];
    if (!info || !crop) return;
    const [vx0, vy0, vx1, vy1] = info.view; // pdf.js visible box in PDF user space
    const W = vx1 - vx0, H = vy1 - vy0;
    // Map display-space fractions (after /Rotate) back to unrotated page space,
    // where (u, v) run left→right and top→bottom.
    const rot = ((info.rotate % 360) + 360) % 360;
    const toUV = (x, y) => {
      switch (rot) {
        case 90: return [y, 1 - x];
        case 180: return [1 - x, 1 - y];
        case 270: return [1 - y, x];
        default: return [x, y];
      }
    };
    const pts = [toUV(crop.l, crop.t), toUV(crop.r, crop.b)];
    const u0 = Math.min(pts[0][0], pts[1][0]), u1 = Math.max(pts[0][0], pts[1][0]);
    const v0 = Math.min(pts[0][1], pts[1][1]), v1 = Math.max(pts[0][1], pts[1][1]);
    const x = vx0 + u0 * W, w = (u1 - u0) * W;
    const y = vy0 + (1 - v1) * H, h = (v1 - v0) * H;
    page.setMediaBox(x, y, w, h);
    page.setCropBox(x, y, w, h);
    page.setTrimBox(x, y, w, h);
    page.setBleedBox(x, y, w, h);
    page.setArtBox(x, y, w, h);
    if (i % 50 === 0) setProgress(i / pages.length, 'Cropping PDF…');
  });
  const out = await doc.save();
  return new Blob([out], { type: 'application/pdf' });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const safeName = () => (els.title.value.trim() || state.baseName).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);

let imageCache = null; // { key, images } so EPUB/KEPUB/CBZ don't re-render each time
let statusPrefix = '';
const FMT_NAMES = { kepub: 'Kobo', epub: 'EPUB', cbz: 'CBZ', pdf: 'PDF' };

// Build one output file for the active document.
async function makeOutput(fmt) {
  const s = settings();
  if (fmt === 'pdf') return { blob: await buildCroppedPdf(), name: `${safeName()} (cropped).pdf` };
  const key = JSON.stringify([state.active?.id, s.devW, s.devH, s.gray, s.quality, state.crops]);
  if (!imageCache || imageCache.key !== key) imageCache = { key, images: await renderAllImages(s) };
  const images = imageCache.images;
  if (fmt === 'cbz') return { blob: await buildCbz(images), name: `${safeName()}.cbz` };
  return { blob: await buildEpub(s, images), name: `${safeName()}${fmt === 'kepub' ? '.kepub' : ''}.epub` };
}

async function generate(fmt) {
  if (state.busy || state.loading || !state.active) return;
  state.busy = true;
  updateButtons();
  renderFileList();
  showProgress(true);
  try {
    const ready = docs.filter((d) => d.status === 'ready');
    if (!batchMode() || ready.length < 2) {
      const o = await makeOutput(fmt);
      download(o.blob, o.name);
    } else {
      const original = state.active;
      const zip = new JSZip();
      const used = new Set();
      try {
        for (const [k, d] of ready.entries()) {
          activate(d, { preview: false });
          statusPrefix = `File ${k + 1} of ${ready.length} · `;
          const o = await makeOutput(fmt);
          let name = o.name;
          for (let n = 2; used.has(name.toLowerCase()); n++) name = o.name.replace(/(\.kepub\.epub|\.[a-z]+)$/i, ` (${n})$1`);
          used.add(name.toLowerCase());
          zip.file(name, o.blob, { compression: 'STORE' });
          imageCache = null; // free memory between files
        }
      } finally {
        statusPrefix = '';
        activate(original);
      }
      const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' },
        (m) => setProgress(m.percent / 100, 'Zipping…'));
      download(blob, `PDF Cut - ${ready.length} files (${FMT_NAMES[fmt]}).zip`);
    }
    setProgress(1, 'Done. Check your downloads.');
    setTimeout(() => { if (!state.busy && !state.loading) showProgress(false); }, 2500);
  } catch (err) {
    console.error(err);
    setProgress(0, `Failed: ${err.message || err}`);
    setTimeout(() => showProgress(false), 6000);
  } finally {
    state.busy = false;
    updateButtons();
    renderFileList();
  }
}

document.querySelectorAll('button[data-fmt]').forEach((b) => b.addEventListener('click', () => generate(b.dataset.fmt)));

function showProgress(on) { els.progress.hidden = !on; if (on) setProgress(0, ''); }
function setProgress(frac, text) { els.bar.value = Math.max(0, Math.min(1, frac)); els.status.textContent = text ? statusPrefix + text : ''; }

// Expose for automated tests.
window.__pdfcut = { state, docs, settings, recompute, generate };
