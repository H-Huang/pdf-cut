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
  prev: $('prev'), next: $('next'), pageLabel: $('pageLabel'), showCropped: $('showCropped'),
  pv: $('pv'), cropInfo: $('cropInfo'),
  progress: $('progress'), bar: $('bar'), status: $('status'),
};

const state = {
  bytes: null,        // Uint8Array of the original PDF (kept pristine for pdf-lib)
  doc: null,          // pdf.js document
  baseName: 'book',
  pages: [],          // per page: { w, h, view, rotate, map, mw, mh }
  boxes: [],          // per page detected content box (fractions) or null
  full: [],           // per page: content fills the whole page
  crops: [],          // per page final crop (fractions) {l,t,r,b}
  current: 0,
  previewCache: null, // { index, canvas }
  busy: false,
};

// ---------------------------------------------------------------- loading

els.pick.addEventListener('click', () => els.file.click());
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
els.file.addEventListener('change', () => { if (els.file.files[0]) loadFile(els.file.files[0]); });
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === els.drop) els.drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (f) loadFile(f);
});

async function loadFile(file) {
  if (state.busy) return;
  state.busy = true;
  try {
    els.fileinfo.textContent = `Loading ${file.name}…`;
    const buf = new Uint8Array(await file.arrayBuffer());
    state.bytes = buf;
    state.baseName = file.name.replace(/\.pdf$/i, '') || 'book';
    if (state.doc) state.doc.destroy();
    // pdf.js may transfer the buffer to its worker, so hand it a copy.
    state.doc = await pdfjsLib.getDocument({ data: buf.slice() }).promise;
    const n = state.doc.numPages;

    let meta = {};
    try { meta = (await state.doc.getMetadata()).info || {}; } catch { /* ignore */ }
    els.title.value = (meta.Title && String(meta.Title).trim()) || state.baseName;
    els.author.value = (meta.Author && String(meta.Author).trim()) || '';

    showProgress(true);
    state.pages = [];
    // Smaller analysis maps for long documents to bound memory use.
    const longSide = n > 600 ? 300 : 400;
    for (let i = 0; i < n; i++) {
      setProgress(i / n, `Analysing page ${i + 1} of ${n}`);
      state.pages.push(await analysePage(i, longSide));
    }
    showProgress(false);
    els.fileinfo.textContent = `${file.name} — ${n} page${n === 1 ? '' : 's'}, ${(file.size / 1048576).toFixed(1)} MB`;
    els.workspace.hidden = false;
    state.current = 0;
    state.previewCache = null;
    recompute();
  } catch (err) {
    console.error(err);
    showProgress(false);
    els.fileinfo.textContent = `Could not open this PDF: ${err.message || err}`;
  } finally {
    state.busy = false;
  }
}

// Render a page small and store how far each pixel is from the page's
// background tone (median luminance). Works for white, cream or dark pages.
async function analysePage(index, longSide) {
  const page = await state.doc.getPage(index + 1);
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

  if (s.ignoreHF) [top, bot] = stripHeaderFooter(rowOk, top, bot, H);

  let left = -1, right = -1;
  for (let x = x0; x < x1; x++) {
    let c = 0;
    for (let y = top; y < bot; y++) if (map[y * W + x] > thr) { if (++c >= minCount) break; }
    if (c >= minCount) { if (left < 0) left = x; right = x + 1; }
  }
  if (left < 0) return { box: null, full: false };

  const box = { l: left / W, t: top / H, r: right / W, b: bot / H };
  const spanW = (x1 - x0) / W, spanH = (y1 - y0) / H;
  const full = (box.r - box.l) >= spanW * 0.96 && (box.b - box.t) >= spanH * 0.96;
  return { box, full };
}

// Drop a thin block of rows at the very top/bottom that is separated from the
// body by a clear gap (running heads, page numbers).
function stripHeaderFooter(rowOk, top, bot, H) {
  const blocks = [];
  const gapMin = Math.max(3, Math.round(H * 0.012));
  let start = -1, lastInk = -1;
  for (let y = top; y < bot; y++) {
    if (rowOk[y]) {
      if (start < 0) start = y;
      else if (y - lastInk > gapMin) { blocks.push([start, lastInk + 1]); start = y; }
      lastInk = y;
    }
  }
  if (start >= 0) blocks.push([start, lastInk + 1]);
  if (blocks.length < 2) return [top, bot];
  const small = (b) => b[1] - b[0] <= H * 0.06;
  let first = 0, last = blocks.length - 1;
  if (small(blocks[first]) && blocks[first][1] <= H * 0.15 && blocks[first + 1][0] - blocks[first][1] >= gapMin * 1.5) first++;
  if (last > first && small(blocks[last]) && blocks[last][0] >= H * 0.85 && blocks[last][0] - blocks[last - 1][1] >= gapMin * 1.5) last--;
  return [blocks[first][0], blocks[last][1]];
}

function recompute() {
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
  const bgs = state.pages.map((p) => p.bg).sort((a, b) => a - b);
  const paper = bgs[bgs.length >> 1];
  for (let i = 0; i < n; i++) if (Math.abs(state.pages[i].bg - paper) > s.sens) state.full[i] = true;
  const FULL = { l: 0, t: 0, r: 1, b: 1 };
  const union = (idxs) => {
    let u = null;
    for (const i of idxs) {
      const b = state.boxes[i];
      if (!b || (s.skipFull && state.full[i])) continue;
      u = u ? { l: Math.min(u.l, b.l), t: Math.min(u.t, b.t), r: Math.max(u.r, b.r), b: Math.max(u.b, b.b) } : { ...b };
    }
    return u;
  };
  // Pages share a crop only with pages of the same size/orientation (and parity
  // in odd/even mode), so mixed-size documents don't get a nonsense union.
  const groupOf = (i) => {
    const p = state.pages[i];
    return `${s.mode === 'oddeven' ? i % 2 : 0}:${Math.round(p.w / 4)}x${Math.round(p.h / 4)}`;
  };
  const groupBox = {};
  if (s.mode !== 'perpage') {
    const members = {};
    for (let i = 0; i < n; i++) (members[groupOf(i)] ||= []).push(i);
    for (const g in members) groupBox[g] = union(members[g]);
  }
  state.crops = state.boxes.map((b, i) => {
    let c;
    if (s.skipFull && state.full[i]) c = FULL;
    else if (s.mode === 'perpage') c = b || FULL;
    else c = groupBox[groupOf(i)] || b || FULL;
    if (c === FULL) return { ...FULL };
    const p = state.pages[i];
    // Equal absolute padding on all sides, relative to the shorter page side.
    const padPts = s.pad * Math.min(p.w, p.h);
    const px = padPts / p.w, py = padPts / p.h;
    return {
      l: Math.max(0, c.l - px), t: Math.max(0, c.t - py),
      r: Math.min(1, c.r + px), b: Math.min(1, c.b + py),
    };
  });
  drawPreview();
}

// ---------------------------------------------------------------- preview

async function drawPreview() {
  const i = state.current;
  const n = state.pages.length;
  if (!n) return;
  els.pageLabel.textContent = `Page ${i + 1} of ${n}`;
  els.prev.disabled = i === 0;
  els.next.disabled = i === n - 1;

  if (!state.previewCache || state.previewCache.index !== i) {
    const page = await state.doc.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1100 / Math.max(vp1.width, vp1.height)) * Math.min(2, window.devicePixelRatio || 1) / 1.2;
    const vp = page.getViewport({ scale });
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
  const cx = crop.l * W, cy = crop.t * H, cw = (crop.r - crop.l) * W, chh = (crop.b - crop.t) * H;
  const out = els.pv, ctx = out.getContext('2d');
  if (els.showCropped.checked) {
    out.width = Math.max(1, Math.round(cw)); out.height = Math.max(1, Math.round(chh));
    ctx.drawImage(src, cx, cy, cw, chh, 0, 0, out.width, out.height);
  } else {
    out.width = W; out.height = H;
    ctx.drawImage(src, 0, 0);
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--shade').trim() || 'rgba(200,40,40,.28)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(cx, cy, cw, chh);
    ctx.fill('evenodd');
    ctx.strokeStyle = css.getPropertyValue('--line').trim() || '#c62828';
    ctx.lineWidth = Math.max(1, W / 400);
    ctx.strokeRect(cx, cy, cw, chh);
  }
  const s = settings();
  const p = state.pages[i];
  const [ow, oh] = outputSize(p, crop, s);
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  let note = '';
  if (s.skipFull && state.full[i]) note = ' (full-bleed page, not cropped)';
  else if (!state.boxes[i]) note = ' (blank page)';
  els.cropInfo.textContent =
    `Trimmed: left ${pct(crop.l)}, right ${pct(1 - crop.r)}, top ${pct(crop.t)}, bottom ${pct(1 - crop.b)}${note}. ` +
    `E-reader image: ${ow}×${oh}px.`;
}

els.prev.addEventListener('click', () => { if (state.current > 0) { state.current--; drawPreview(); } });
els.next.addEventListener('click', () => { if (state.current < state.pages.length - 1) { state.current++; drawPreview(); } });
document.addEventListener('keydown', (e) => {
  if (els.workspace.hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'ArrowLeft') els.prev.click();
  if (e.key === 'ArrowRight') els.next.click();
});
els.showCropped.addEventListener('change', drawPreview);

const outputs = [['padding', 'paddingOut'], ['sens', 'sensOut'], ['edge', 'edgeOut'], ['qual', 'qualOut']];
for (const [inp, out] of outputs) {
  els[inp].addEventListener('input', () => { $(out).textContent = els[inp].value; });
}
let rcTimer = 0;
const scheduleRecompute = () => { clearTimeout(rcTimer); rcTimer = setTimeout(() => state.pages.length && recompute(), 60); };
for (const id of ['mode', 'padding', 'sens', 'edge', 'skipFull', 'ignoreHF']) {
  els[id].addEventListener('input', scheduleRecompute);
  els[id].addEventListener('change', scheduleRecompute);
}
els.device.addEventListener('change', () => { els.customDims.hidden = els.device.value !== 'custom'; drawPreview(); });
for (const id of ['cw', 'ch']) els[id].addEventListener('input', () => drawPreview());

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

async function generate(fmt) {
  if (state.busy || !state.pages.length) return;
  state.busy = true;
  const buttons = document.querySelectorAll('#downloads button[data-fmt]');
  buttons.forEach((b) => (b.disabled = true));
  showProgress(true);
  try {
    const s = settings();
    if (fmt === 'pdf') {
      download(await buildCroppedPdf(), `${safeName()} (cropped).pdf`);
    } else {
      const key = JSON.stringify([s.devW, s.devH, s.gray, s.quality, state.crops]);
      if (!imageCache || imageCache.key !== key) imageCache = { key, images: await renderAllImages(s) };
      const images = imageCache.images;
      if (fmt === 'cbz') download(await buildCbz(images), `${safeName()}.cbz`);
      else download(await buildEpub(s, images), `${safeName()}${fmt === 'kepub' ? '.kepub' : ''}.epub`);
    }
    setProgress(1, 'Done. Check your downloads.');
    setTimeout(() => showProgress(false), 2500);
  } catch (err) {
    console.error(err);
    setProgress(0, `Failed: ${err.message || err}`);
  } finally {
    state.busy = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.querySelectorAll('#downloads button[data-fmt]').forEach((b) => b.addEventListener('click', () => generate(b.dataset.fmt)));

function showProgress(on) { els.progress.hidden = !on; if (on) setProgress(0, ''); }
function setProgress(frac, text) { els.bar.value = Math.max(0, Math.min(1, frac)); els.status.textContent = text; }

// Expose for automated tests.
window.__pdfcut = { state, settings, recompute, generate, buildEpub, buildCroppedPdf, renderAllImages };
