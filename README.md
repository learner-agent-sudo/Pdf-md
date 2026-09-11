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
  The **OCR language** defaults to **Auto-detect** (handles pages that mix
  English with another language); you can also force a specific language
  (English, French, German, Spanish, Italian, Portuguese, Chinese
  Simplified/Traditional, Japanese, Korean). OCR is noticeably slower (a few
  seconds per page), so leave it off for normal text PDFs.
- **Compare 2 files → tracked-changes Word** — upload the original file, then
  the revised one, to get a Word `.docx` **redline** (see below).

## What converts well (and what doesn't)

| Content                          | Result                                             |
| -------------------------------- | -------------------------------------------------- |
| Text-based PDFs (Word, LaTeX…)   | ✅ Clean text, headings, paragraphs                 |
| Non-English text (French, 中文…) | ✅ Extracted directly; scans need OCR + the language |
| Word `.docx`                     | ✅ Headings, bold/italic, lists, and tables         |
| Scanned PDFs / images + OCR      | ✅ Printed text extracted (turn OCR on, pick language)|
| Very long PDFs (100+ pages)      | ✅ Processed page by page with live progress         |
| Multi-column / complex PDF layout| ⚠️ Usable, but reading order may need tidying      |
| PDF tables                       | ⚠️ Text is kept; grid structure is not rebuilt     |
| Handwriting (even with OCR)      | ⚠️ Tesseract handles print well, handwriting poorly|
| Old binary `.doc`                | ❌ Not supported — save as `.docx` first            |
| Signatures (e.g. DocuSign)       | ❌ A signature image isn't text; a marker is left   |

### About OCR

OCR uses [Tesseract.js](https://github.com/naptha/tesseract.js). The first time
you run it in a session, the browser loads the engine (~3 MB WASM) and the
chosen language's data (~0.6–2 MB) from the local `vendor/` folder — no network.
Only the selected language is downloaded. A scanned PDF page with no text layer
(or one whose text is garbled because its font lacks a Unicode map) is
rasterized and read automatically when OCR is on; image files (PNG/JPG/WebP)
are OCR'd whole.

### Auto-detect language

With OCR set to **Auto-detect**, the tool runs a quick English probe on the
first page needing OCR. If the script is Latin, a small heuristic (accents +
common words) picks the European language; otherwise a combined pass decides
between Chinese, Japanese, and Korean. English is always kept in the mix, so
pages that mix English with Chinese/French still read correctly. For a document
in one known language, forcing that language in the dropdown is fastest and most
accurate.

## Comparing two files (track changes)

Tick **Compare 2 files** and upload the **original** first, then the **revised**
version (each may be PDF, Word `.docx`, `.md`, or `.txt`). The tool produces a
single Word `.docx` with real **tracked changes** (`<w:ins>` / `<w:del>`) that
you accept or reject in Word, Google Docs, or LibreOffice, plus an on-screen
`+`/`−` preview.

The redline preserves the formatting that survives conversion — **heading
levels (relative font sizes), bullets, numbered lists, and bold / italic /
inline-code** — and carries that styling onto the tracked changes themselves
(a changed bold word stays bold in both its deletion and its insertion). It
compares word by word (character by character for Chinese/Japanese).

What it can't reproduce is formatting that Markdown doesn't carry: exact fonts,
colors, and absolute point sizes. Those would require parsing the Word OOXML
run-by-run (a Word-only path). For a pixel-perfect compare of two `.docx`
files, Word's own *Review → Compare* is still the specialist; this tool's edge
is a quick, portable redline **across mixed formats** (e.g. a PDF vs. a Word
draft), which Word can't do. Note also that a change to *formatting alone*
(identical words, different styling) is applied in the output but not marked as
a separate tracked revision.

### Long documents

Large PDFs are processed one page at a time with a live progress bar, and each
page's memory is released as it goes. If a single page can't be read, it's
marked `*(page N could not be read)*` and the rest of the document still
converts — the result's label notes how many pages (if any) were unreadable.

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
- `app.js` — drag/drop, batch handling, PDF/Word/image/MD → Markdown logic
- `md-to-docx.js` — Markdown → real OOXML `.docx` (via marked + docx)
- `compare.js` — two-file diff → tracked-changes `.docx` (via marked + diff + docx)
- `style.css` — styling
- `vendor/` — bundled libraries, all local (no CDN):
  - `pdf.min.mjs`, `pdf.worker.min.mjs` — pdf.js (PDF parsing)
  - `mammoth.browser.min.js` — Word `.docx` → HTML
  - `turndown.js`, `turndown-plugin-gfm.js` — HTML → Markdown (with tables)
  - `jszip.min.js` — bundle multiple `.md` files into a zip
  - `tesseract.min.js`, `tesseract-worker.min.js`,
    `tesseract-core-simd-lstm.wasm(.js)` — OCR engine
  - `*.traineddata.gz` — OCR language data (eng, fra, deu, spa, ita, por,
    chi_sim, chi_tra, jpn, kor)
  - `marked.umd.js` — Markdown parser, and `docx.umd.js` — Word `.docx` writer
  - `diff.min.js` — text diffing for the two-file comparison
