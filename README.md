# PDF / Word → Markdown

A tiny, self-contained website that converts **PDF, Word (`.docx`), and image**
files into **Markdown (`.md`) or Word (`.docx`)** — handy for feeding large
documents into Claude or editing them further. Drop in several files at once
and download them individually or as a zip. Scanned/image files can be read
with optional **OCR**.

**Everything runs in your browser, offline.** Files are read locally with
Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/) (PDF),
[mammoth.js](https://github.com/mwilliamson/mammoth.js) +
[Turndown](https://github.com/mixmark-io/turndown) (Word in),
[Tesseract.js](https://github.com/naptha/tesseract.js) (OCR), and
[marked](https://github.com/markedjs/marked) +
[docx](https://github.com/dolanmiu/docx) (Word out) — all bundled into this
repo, so there are **no external network calls at all**. The page also ships a
strict Content-Security-Policy that forbids any outbound connection, so the
browser will physically refuse to upload your files. This matters for documents
containing signatures or private data.

## How to use it

You don't need to install anything, and after the files are on your machine it
works with no internet connection.

Because the tool uses ES modules and a web worker, browsers require it to be
**served over `http`** rather than opened with a raw `file://` path. Two easy
ways:

**A) Run a one-line local server** (fully private, offline):

```bash
cd Pdf-md
python3 -m http.server 8000
# then open http://localhost:8000 in your browser
```

**B) Use the GitHub Pages link** (see *Hosting* below) if you'd rather have a URL.

Then:

1. Drag one or more PDF / `.docx` files onto the drop zone — or click
   **Choose files**.
2. Wait for the progress bar (each file is processed in turn; large PDFs go
   page by page).
3. Each file gets its own result card — click **Download .md** or **Copy**.
   With two or more files, **Download all (.zip)** saves them together. The
   download format follows the **Output** setting (`.md` or `.docx`).

## Options

- **Output** — choose **Markdown (`.md`)** or **Word (`.docx`)**. Word output
  is a genuine OOXML document (real headings, bold/italic, lists, and tables)
  that opens in Word, Google Docs, LibreOffice, and Pages — not an HTML file
  renamed to `.docx`.
- **Detect headings from font sizes** *(PDF)* — bigger text becomes `#`, `##`,
  `###`. Word headings come straight from the document's own styles.
- **Insert page-break markers** *(PDF)* — adds a `---` between pages.
- **Mark image/signature regions** — flags images/signatures with a marker
  instead of dropping them silently (applies to both PDF and Word).
- **OCR scanned pages & images** *(off by default)* — reads text off image
  pixels using Tesseract.js. Turn this on for scanned PDFs and image files.
  It's **English-only** and noticeably slower (a few seconds per page), so
  leave it off for normal text PDFs.

## What converts well (and what doesn't)

| Content                          | Result                                             |
| -------------------------------- | -------------------------------------------------- |
| Text-based PDFs (Word, LaTeX…)   | ✅ Clean text, headings, paragraphs                 |
| Word `.docx`                     | ✅ Headings, bold/italic, lists, and tables         |
| Scanned PDFs / images + OCR      | ✅ Printed text extracted (turn OCR on)             |
| Multi-column / complex PDF layout| ⚠️ Usable, but reading order may need tidying      |
| PDF tables                       | ⚠️ Text is kept; grid structure is not rebuilt     |
| Handwriting (even with OCR)      | ⚠️ Tesseract handles print well, handwriting poorly|
| Old binary `.doc`                | ❌ Not supported — save as `.docx` first            |
| Signatures (e.g. DocuSign)       | ❌ A signature image isn't text; a marker is left   |

### About OCR

OCR uses [Tesseract.js](https://github.com/naptha/tesseract.js). The first time
you run it in a session, the browser loads the engine (~3 MB WASM) and the
English language data (~2 MB) from the local `vendor/` folder — no network. A
scanned PDF page with no text layer is rasterized and read automatically when
OCR is on; image files (PNG/JPG/WebP) are OCR'd whole.

## Hosting (optional)

This repo includes a GitHub Actions workflow
(`.github/workflows/deploy-pages.yml`) that publishes the site to **GitHub
Pages** automatically on every push to `main`.

**One-time setup:** in the repo, go to **Settings → Pages** and set
**Source → GitHub Actions**. After the next push (or a manual run from the
**Actions** tab), the site is live at
`https://<your-user>.github.io/<repo>/`. The workflow re-deploys on each push,
so the link always reflects the latest code.

Prefer no hosting at all? The site is fully static — just run the local server
described above.

### Is it safe to host publicly?

Yes. There is no server, database, account, or secret — just static files.
A PDF you convert is processed entirely inside *your* browser and is never
transmitted, so a public link does not expose any of your documents; it only
lets other people run the same converter on *their own* files. Making the repo
private hides the (harmless) source code but adds no protection for your data.
If you want a hosted link only you can reach, that requires private GitHub
Pages (a paid plan); otherwise just run it locally with the command above.

## Files

- `index.html` — page, UI, and Content-Security-Policy
- `app.js` — drag/drop, batch handling, PDF/Word/image → Markdown logic
- `md-to-docx.js` — Markdown → real OOXML `.docx` (via marked + docx)
- `style.css` — styling
- `vendor/` — bundled libraries, all local (no CDN):
  - `pdf.min.mjs`, `pdf.worker.min.mjs` — pdf.js (PDF parsing)
  - `mammoth.browser.min.js` — Word `.docx` → HTML
  - `turndown.js`, `turndown-plugin-gfm.js` — HTML → Markdown (with tables)
  - `jszip.min.js` — bundle multiple `.md` files into a zip
  - `tesseract.min.js`, `tesseract-worker.min.js`,
    `tesseract-core-simd-lstm.wasm(.js)`, `eng.traineddata.gz` — OCR engine
    and English language data
  - `marked.umd.js` — Markdown parser, and `docx.umd.js` — Word `.docx` writer
