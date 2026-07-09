# PDF / Word → Markdown

A tiny, self-contained website that converts **PDF and Word (`.docx`)** files
into Markdown (`.md`) — handy for feeding large documents into Claude or other
tools. Drop in several files at once and download them individually or as a zip.

**Everything runs in your browser, offline.** Files are read locally with
Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/) (PDF) and
[mammoth.js](https://github.com/mwilliamson/mammoth.js) +
[Turndown](https://github.com/mixmark-io/turndown) (Word) — all bundled into
this repo, so there are **no external network calls at all**. The page also
ships a strict Content-Security-Policy that forbids any outbound connection, so
the browser will physically refuse to upload your files. This matters for
documents containing signatures or private data.

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
   With two or more files, **Download all (.zip)** saves them together.

## Options

- **Detect headings from font sizes** *(PDF)* — bigger text becomes `#`, `##`,
  `###`. Word headings come straight from the document's own styles.
- **Insert page-break markers** *(PDF)* — adds a `---` between pages.
- **Mark image/signature regions** — flags images/signatures with a marker
  instead of dropping them silently (applies to both PDF and Word).

## What converts well (and what doesn't)

| Content                          | Result                                             |
| -------------------------------- | -------------------------------------------------- |
| Text-based PDFs (Word, LaTeX…)   | ✅ Clean text, headings, paragraphs                 |
| Word `.docx`                     | ✅ Headings, bold/italic, lists, and tables         |
| Multi-column / complex PDF layout| ⚠️ Usable, but reading order may need tidying      |
| PDF tables                       | ⚠️ Text is kept; grid structure is not rebuilt     |
| Old binary `.doc`                | ❌ Not supported — save as `.docx` first            |
| Scanned pages / handwriting      | ❌ Images, not text — can't be extracted (no OCR)   |
| Signatures (e.g. DocuSign)       | ❌ The signature image isn't text; a marker is left |

If you later need scanned/handwritten PDFs, that requires OCR (a heavier,
typically local tool) — open an issue and we can add it.

## Hosting (optional)

To get a shareable link instead of running a local server, enable **GitHub
Pages** (Settings → Pages → deploy from branch). The site is fully static.

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
- `app.js` — drag/drop, batch handling, PDF & Word → Markdown logic
- `style.css` — styling
- `vendor/` — bundled libraries, all local (no CDN):
  - `pdf.min.mjs`, `pdf.worker.min.mjs` — pdf.js (PDF parsing)
  - `mammoth.browser.min.js` — Word `.docx` → HTML
  - `turndown.js`, `turndown-plugin-gfm.js` — HTML → Markdown (with tables)
  - `jszip.min.js` — bundle multiple `.md` files into a zip
