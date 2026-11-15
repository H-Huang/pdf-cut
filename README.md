# PDF Cut

**Read PDFs on your Kobo without the huge margins.**

👉 **https://h-huang.github.io/pdf-cut/**

PDFs are made for letter or A4 paper, so on a 6–7" e-reader the text is tiny and surrounded by white space. PDF Cut trims those margins off and gives you a file that fills your e-reader's screen.

1. Open the site and choose one or more PDFs.
2. Check the preview. Margins are detected automatically, and you can drag the box to adjust any page.
3. Tap **Download for Kobo** and copy the file to your e-reader.

Also exports EPUB (most e-readers, Send to Kindle), CBZ and a cropped PDF. Everything runs in your browser. Your files are never uploaded.

## Development

It's a static site with no build step: plain HTML, CSS and JS, with the libraries ([pdf.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/), [JSZip](https://stuk.github.io/jszip/)) kept in `vendor/`. To run it locally:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Pushing to `main` deploys to GitHub Pages.

## License

MIT, see [LICENSE](LICENSE). The libraries in `vendor/` keep their own licenses, copied in [`vendor/licenses/`](vendor/licenses/): pdf.js 4.10.38 (Apache-2.0), pdf-lib 1.17.1 (MIT) and JSZip 3.10.1 (used under MIT).
