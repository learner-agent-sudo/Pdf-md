# PDF → Markdown

A tiny, self-contained website that converts a PDF into a single Markdown
(`.md`) file — handy for feeding large documents into Claude or other tools.

**Everything runs in your browser.** Your PDF is read locally with Mozilla's
[pdf.js](https://mozilla.github.io/pdf.js/) and never uploaded to any server,
which matters for documents containing signatures or private data.

## How to use it

You don't need to install anything.

1. Open `index.html` in a browser (double-click it, or see *Hosting* below).
2. Drag a PDF onto the drop zone — or click **Choose a file**.
3. Wait for the progress bar (large PDFs are processed page by page).
4. Click **Download .md** to save the file, or **Copy** to grab the text.

> The first run needs an internet connection so the browser can fetch pdf.js
> from the CDN. After that, your browser usually caches it.

## Options

- **Detect headings from font sizes** — bigger text becomes `#`, `##`, `###`.
- **Insert page-break markers** — adds a `---` between pages.
- **Mark image/signature regions** — flags pages with no extractable text.

## What converts well (and what doesn't)

| Content                         | Result                                            |
| ------------------------------- | ------------------------------------------------- |
| Text-based PDFs (Word, LaTeX…)  | ✅ Clean text, headings, paragraphs                |
| Multi-column / complex layout   | ⚠️ Usable, but reading order may need tidying     |
| Tables                          | ⚠️ Text is kept; grid structure is not rebuilt    |
| Scanned pages / handwriting     | ❌ Images, not text — can't be extracted (no OCR)  |
| Signatures (e.g. DocuSign)      | ❌ The signature image isn't text; a marker is left |

If you later need scanned/handwritten PDFs, that requires OCR (a heavier,
typically local tool) — open an issue and we can add it.

## Hosting (optional)

To get a shareable link instead of opening the file locally, push this repo and
enable **GitHub Pages** (Settings → Pages → deploy from branch). The site is
fully static — just `index.html`, `app.js`, and `style.css`.

## Files

- `index.html` — page and UI
- `app.js` — drag/drop handling + PDF → Markdown logic
- `style.css` — styling
