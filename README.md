# PDF Cut

A static web page that trims the margins off a PDF and exports it for e-readers:

- **EPUB** (fixed layout): Kobo, Apple Books, Send to Kindle, and most other readers
- **Kobo KEPUB** (`.kepub.epub`): opens in Kobo's enhanced reader
- **CBZ**: comic-book archive (Kobo, KOReader, comic apps)
- **Cropped PDF**: the original vector PDF with its page boxes trimmed, so text stays sharp and selectable

All processing happens in the browser. The PDF never leaves your computer.

## How it works

1. Each page is rendered at low resolution with [pdf.js](https://mozilla.github.io/pdf.js/). Pixels that differ from the page's background tone count as content.
2. Thin side strips such as arXiv stamps are ignored. A crop box is computed per page, per odd/even page, or once for the whole document. Pages of different sizes are grouped separately. Covers and full-page images can be left uncropped. Running headers, footers and page numbers can optionally be dropped. Pages whose content sticks out (a wide figure, say) get their own wider crop instead of widening every page.
3. You can drag the crop box on any page to adjust it (mouse or touch), then reset it or reuse it on all odd, even or all pages.
4. For EPUB, KEPUB and CBZ, each cropped page is rendered at the chosen device resolution and saved as a JPEG. The JPEGs are packaged with [JSZip](https://stuk.github.io/jszip/).
5. For the cropped PDF, [pdf-lib](https://pdf-lib.js.org/) rewrites each page's MediaBox and CropBox, so no re-rendering happens.

## Hosting on GitHub Pages

There is no build step. The page is plain HTML, CSS and JS, and the libraries are kept in `vendor/`.

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, pick `main` and `/ (root)`, and save.
3. The site appears at `https://<user>.github.io/<repo>/`.

`.nojekyll` stops GitHub Pages from running Jekyll over the files.

## Running locally

ES modules don't load from `file://`, so serve the folder:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Vendored libraries

| File | Package |
| --- | --- |
| `vendor/pdf.min.mjs`, `vendor/pdf.worker.min.mjs` | pdfjs-dist 4.10.38 (Apache-2.0) |
| `vendor/pdf-lib.min.js` | pdf-lib 1.17.1 (MIT) |
| `vendor/jszip.min.js` | jszip 3.10.1 (MIT / GPLv3) |
