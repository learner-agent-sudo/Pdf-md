// PDF / Word → Markdown converter — runs entirely client-side.
//
// - PDF:  pdf.js pulls positioned text out of each page, then heuristics
//         (font size → heading level, vertical gaps → paragraphs) rebuild it.
// - DOCX: mammoth.js converts the Word document to HTML, then Turndown
//         (with the GFM plugin for tables) turns that HTML into Markdown.
//
// Multiple files are converted in one batch; each gets its own result card,
// and everything can be downloaded together as a .zip.

import * as pdfjsLib from "./vendor/pdf.min.mjs";
import { markdownToDocxBlob } from "./md-to-docx.js";
import { compareToDocxBlob } from "./compare.js";
import { enrichDocx } from "./docx-enrich.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const { Diff } = window;

// Globals provided by the vendored classic scripts (loaded before this module).
const { mammoth, TurndownService, turndownPluginGfm, JSZip, Tesseract } = window;

// Local paths for the Tesseract OCR assets (all vendored — no CDN).
const OCR_PATHS = {
  workerPath: "vendor/tesseract-worker.min.js",
  corePath: "vendor/tesseract-core-simd-lstm.wasm.js",
  langPath: "vendor",
};

// --- DOM ---------------------------------------------------------------
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const resultsHead = document.getElementById("results-head");
const resultsSummary = document.getElementById("results-summary");
const downloadAllBtn = document.getElementById("download-all");
const resultsEl = document.getElementById("results");
const errorEl = document.getElementById("error");

const optHeadings = document.getElementById("opt-headings");
const optPageBreaks = document.getElementById("opt-pagebreaks");
const optImageMarks = document.getElementById("opt-imagemarks");
const optOcr = document.getElementById("opt-ocr");
const optOcrLang = document.getElementById("opt-ocr-lang");
const optKeepChanges = document.getElementById("opt-keepchanges");
const optCompare = document.getElementById("opt-compare");
const formatToggle = document.getElementById("format-toggle");

let results = []; // [{ baseName, markdown, meta, ok, error }]
let ocrWorker = null; // lazily created, reused across a batch
let ocrWorkerLang = null; // language the cached worker was created with
let outputFormat = "md"; // 'md' | 'docx' — download-time choice

// --- Wiring ------------------------------------------------------------
browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFiles(e.target.files);
  fileInput.value = ""; // allow re-selecting the same file
});

["dragenter", "dragover"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  })
);
dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

downloadAllBtn.addEventListener("click", downloadAllZip);

// Toggling compare mode clears any stale results from the other mode.
optCompare.addEventListener("change", () => {
  hideError();
  results = [];
  resultsEl.innerHTML = "";
  resultsHead.hidden = true;
  dropZone.classList.toggle("compare-on", optCompare.checked);
});

// Segmented "Download as" toggle. Output format is a download-time choice, so
// switching it just re-renders the existing results' buttons/filenames.
formatToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg");
  if (!btn) return;
  outputFormat = btn.dataset.format;
  formatToggle.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b === btn));
  if (results.length) renderResults();
});

// --- Batch flow --------------------------------------------------------
async function handleFiles(fileList) {
  hideError();
  const files = [...fileList];
  results = [];
  resultsEl.innerHTML = "";
  resultsHead.hidden = true;
  progressWrap.hidden = false;

  if (optCompare.checked) {
    await runCompare(files);
    return;
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setProgress(i / files.length, `Converting ${file.name} (${i + 1} of ${files.length})…`);
    await new Promise((r) => setTimeout(r, 0)); // let the UI paint

    const baseName = baseNameOf(file);
    try {
      const { markdown, meta } = await fileToMarkdown(file, i, files.length);
      results.push({ baseName, markdown, meta, ok: true });
    } catch (err) {
      console.error(err);
      results.push({ baseName, ok: false, error: err.message || String(err) });
    }
  }

  await disposeOcrWorker(); // free the OCR worker once the batch is done
  setProgress(1, "Done");
  progressWrap.hidden = true;
  renderResults();
}

function baseNameOf(file) {
  return file.name.replace(/\.(pdf|docx?|md|markdown|txt|png|jpe?g|webp|bmp|gif)$/i, "") || "document";
}

// Convert any supported file to Markdown (throws for unsupported types).
async function fileToMarkdown(file, i, count, opts = {}) {
  const kind = detectKind(file);
  if (kind === "pdf") return convertPdf(file, i, count);
  if (kind === "docx") return convertDocx(file, opts);
  if (kind === "image") return convertImage(file);
  if (kind === "md") return convertMarkdownFile(file);
  if (kind === "doc") throw new Error("Old .doc format isn't supported — save it as .docx and try again.");
  throw new Error("Unsupported file type. Please use a PDF, .docx, .md, or image file.");
}

async function convertMarkdownFile(file) {
  const text = await file.text();
  return { markdown: tidy(text), meta: `Markdown · ${countWords(text)} words` };
}

// --- Compare two files → tracked-changes Word --------------------------
async function runCompare(files) {
  if (files.length !== 2) {
    progressWrap.hidden = true;
    resultsHead.hidden = true;
    showError("Comparison needs exactly 2 files — upload the original first, then the revised version.");
    return;
  }
  try {
    // Compare accepted content (don't inject tracked-change markers, which
    // would otherwise appear as literal text in the diff).
    setProgress(0.1, `Reading ${files[0].name}…`);
    const a = await fileToMarkdown(files[0], 0, 2, { keepChanges: false });
    setProgress(0.5, `Reading ${files[1].name}…`);
    const b = await fileToMarkdown(files[1], 1, 2, { keepChanges: false });
    setProgress(0.85, "Building tracked-changes document…");
    const blob = await compareToDocxBlob(a.markdown, b.markdown);
    const baseName = `${baseNameOf(files[0])}_vs_${baseNameOf(files[1])}_changes`;
    results = [{
      ok: true,
      isCompare: true,
      baseName,
      meta: `tracked changes · ${files[0].name} → ${files[1].name}`,
      compareBlob: blob,
      previewText: diffPreview(a.markdown, b.markdown),
    }];
  } catch (err) {
    console.error(err);
    results = [{ ok: false, baseName: "comparison", error: err.message || String(err) }];
  }
  await disposeOcrWorker();
  setProgress(1, "Done");
  progressWrap.hidden = true;
  renderResults();
}

// A plain-text unified-style preview of the changes, shown on screen.
function diffPreview(aMd, bMd) {
  const parts = Diff.diffLines(aMd, bMd);
  let out = "";
  for (const p of parts) {
    const lines = p.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const mark = p.added ? "+ " : p.removed ? "- " : "  ";
    for (const l of lines) out += mark + l + "\n";
  }
  return out.trim() || "(no textual differences found)";
}

// Produce the downloadable file for a result in its chosen format. The docx
// blob is generated on demand and cached on the result object.
async function fileFor(r) {
  if (r.isCompare) {
    return { blob: r.compareBlob, name: `${r.baseName}.docx` };
  }
  if (outputFormat === "docx") {
    if (!r._docxBlob) r._docxBlob = await markdownToDocxBlob(r.markdown);
    return { blob: r._docxBlob, name: `${r.baseName}.docx` };
  }
  return {
    blob: new Blob([r.markdown], { type: "text/markdown;charset=utf-8" }),
    name: `${r.baseName}.md`,
  };
}

function detectKind(file) {
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".doc")) return "doc";
  if (/\.(md|markdown|txt)$/.test(n)) return "md";
  if (/\.(png|jpe?g|webp|bmp|gif)$/.test(n) || file.type.startsWith("image/")) return "image";
  return "unknown";
}

// --- OCR (Tesseract.js) ------------------------------------------------
// One worker is created per language string and reused while that string is
// unchanged. A different language (or a different auto-detected combination)
// tears the worker down and creates a new one.
async function ensureOcrWorker(lang) {
  if (ocrWorker && ocrWorkerLang === lang) return ocrWorker;
  await disposeOcrWorker();
  ocrWorker = await Tesseract.createWorker(lang, 1, OCR_PATHS);
  ocrWorkerLang = lang;
  return ocrWorker;
}

async function disposeOcrWorker() {
  if (!ocrWorker) return;
  try {
    await ocrWorker.terminate();
  } catch {
    /* ignore */
  }
  ocrWorker = null;
  ocrWorkerLang = null;
}

// Raw recognize in a specific language string; returns text + mean confidence.
async function ocrRecognize(source, lang) {
  const worker = await ensureOcrWorker(lang);
  const { data } = await worker.recognize(source);
  return { text: data.text || "", confidence: data.confidence || 0 };
}

function cleanOcrText(text) {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function ocrImageSource(source, lang) {
  const { text } = await ocrRecognize(source, lang);
  return cleanOcrText(text);
}

// Resolve which Tesseract language(s) to use. When the user picks "Auto-detect"
// we probe the image: an English pass tells us if the script is Latin (then a
// small heuristic picks the European language), otherwise a combined CJK pass
// tells us whether it's Chinese, Japanese, or Korean. English is always kept in
// the mix so mixed-language pages work.
async function resolveOcrLang(source) {
  const choice = optOcrLang.value || "auto";
  if (choice !== "auto") return choice;

  const probe = await ocrRecognize(source, "eng");
  const nonSpace = probe.text.replace(/\s/g, "");
  const ascii = (probe.text.match(/[A-Za-z]/g) || []).length;
  const latinScore = nonSpace.length ? ascii / nonSpace.length : 0;

  if (probe.confidence >= 60 && latinScore >= 0.55) {
    return detectLatinLang(probe.text); // 'eng' or e.g. 'fra+eng'
  }

  // Non-Latin script: probe with the CJK languages to see which one.
  const cjk = await ocrRecognize(source, "eng+chi_sim+jpn+kor");
  const t = cjk.text;
  if (/[぀-ヿ]/.test(t)) return "jpn+eng"; // kana → Japanese
  if (/[가-힣]/.test(t)) return "kor+eng"; // hangul → Korean
  if (/[㐀-鿿豈-﫿]/.test(t)) return "chi_sim+eng"; // Han → Chinese
  return "eng"; // fell through: treat as English
}

// Lightweight European-language guess from OCR'd Latin text, via diacritics and
// common stop-words. Returns 'eng' or '<lang>+eng'.
function detectLatinLang(text) {
  const t = " " + text.toLowerCase().replace(/\s+/g, " ") + " ";
  const score = { fra: 0, deu: 0, spa: 0, ita: 0, por: 0 };
  if (/[àâçéèêëîïôûù]/.test(text)) score.fra += 2;
  if (/[äöüß]/.test(text)) score.deu += 3;
  if (/[ñ¿¡]/.test(text)) score.spa += 3;
  if (/[ãõ]/.test(text)) score.por += 2;
  const stop = {
    fra: [" le ", " la ", " les ", " des ", " et ", " une ", " est ", " pour ", " dans ", " du ", " qui "],
    deu: [" der ", " die ", " das ", " und ", " ist ", " nicht ", " mit ", " ein ", " auch ", " sich "],
    spa: [" el ", " los ", " las ", " que ", " una ", " para ", " con ", " por ", " como ", " pero "],
    ita: [" il ", " lo ", " gli ", " che ", " di ", " per ", " una ", " sono ", " non ", " della "],
    por: [" os ", " as ", " uma ", " para ", " com ", " não ", " dos ", " uma ", " mais ", " são "],
  };
  for (const l in stop) for (const w of stop[l]) if (t.includes(w)) score[l] += 1;

  let best = "eng";
  let bestScore = 2; // require a clear signal to override English
  for (const l in score) if (score[l] > bestScore) { bestScore = score[l]; best = l; }
  return best === "eng" ? "eng" : `${best}+eng`;
}

// Convert a whole image file to Markdown via OCR.
async function convertImage(file) {
  if (!optOcr.checked) {
    return {
      markdown: `*(image file — enable “OCR scanned pages & images” to extract text)*\n`,
      meta: "image · OCR off",
    };
  }
  setProgress(null, `Detecting language in ${file.name}…`);
  const lang = await resolveOcrLang(file);
  setProgress(null, `OCR ${file.name} (${lang})…`);
  const text = await ocrImageSource(file, lang);
  return { markdown: tidy(text || "*(no text found in image)*"), meta: `image · OCR (${lang})` };
}

// --- DOCX → Markdown ---------------------------------------------------
async function convertDocx(file, opts = {}) {
  const arrayBuffer = await file.arrayBuffer();
  const keepChanges = opts.keepChanges ?? optKeepChanges.checked;
  // Recover Word auto-numbering, tracked changes, and comments before mammoth.
  const enriched = await enrichDocx(arrayBuffer, { keepChanges });
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: enriched });
  let md = makeTurndown().turndown(prepDocxHtml(html));
  // Turndown escapes a leading "1." (to avoid making a list); our injected
  // Word numbers are literal, so unescape them: "1\. Overview" -> "1. Overview".
  md = md.replace(/^(\s*)(\d+)\\\.(\s)/gm, "$1$2.$3");
  md = tidy(md);
  return { markdown: md, meta: `Word · ${countWords(md)} words` };
}

// mammoth emits table cells as <td><p>…</p></td> with no header row, but the
// GFM Markdown-table rule only fires when the first row is <th>. Markdown
// tables need a header row anyway, so we flatten cell paragraphs, expand merged
// cells (colspan/rowspan) so every row has the same column count, and promote
// the first row's cells to <th>.
function prepDocxHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  doc.querySelectorAll("td, th").forEach((cell) => {
    const ps = cell.querySelectorAll(":scope > p");
    if (ps.length) {
      // Join multi-paragraph cells with <br> so line breaks survive in Markdown.
      cell.innerHTML = [...ps].map((p) => p.innerHTML.trim()).filter(Boolean).join("<br>");
    }
  });

  doc.querySelectorAll("table").forEach((table) => {
    expandMergedCells(doc, table);
    const firstRow = table.querySelector("tr");
    if (!firstRow) return;
    const cells = [...firstRow.children];
    if (!cells.some((c) => c.nodeName === "TH")) {
      cells.forEach((td) => {
        const th = doc.createElement("th");
        th.innerHTML = td.innerHTML;
        td.replaceWith(th);
      });
    }
  });

  return doc.body.innerHTML;
}

// Normalize a table so every row has the same number of single cells: a
// colspan=N cell becomes the cell plus N-1 empty cells, and a rowspan=N cell
// drops an empty placeholder into the next N-1 rows at that column. Markdown
// tables can't merge cells, so this keeps columns aligned instead of garbled.
function expandMergedCells(doc, table) {
  const rows = [...table.querySelectorAll(":scope > tbody > tr, :scope > tr, :scope > thead > tr")];
  if (!rows.length) return;
  const carry = {}; // column index -> remaining rowspan placeholders to insert

  for (const row of rows) {
    const cells = [...row.children];
    let col = 0;
    const frag = [];
    const emit = (node) => { frag[col] = node; };

    const placeCarried = () => {
      while (carry[col] > 0) {
        const empty = doc.createElement(cells[0] && cells[0].nodeName === "TH" ? "td" : "td");
        empty.innerHTML = "";
        emit(empty);
        carry[col]--;
        if (carry[col] <= 0) delete carry[col];
        col++;
      }
    };

    for (const cell of cells) {
      placeCarried();
      const colspan = parseInt(cell.getAttribute("colspan") || "1", 10);
      const rowspan = parseInt(cell.getAttribute("rowspan") || "1", 10);
      cell.removeAttribute("colspan");
      cell.removeAttribute("rowspan");
      emit(cell);
      if (rowspan > 1) carry[col] = rowspan - 1;
      col++;
      for (let k = 1; k < colspan; k++) {
        const empty = doc.createElement(cell.nodeName.toLowerCase());
        empty.innerHTML = "";
        emit(empty);
        if (rowspan > 1) carry[col] = rowspan - 1;
        col++;
      }
    }
    placeCarried();

    // Rebuild the row in column order.
    row.textContent = "";
    for (const node of frag) if (node) row.appendChild(node);
  }
}

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  td.use(turndownPluginGfm.gfm); // GitHub-flavored tables, strikethrough, etc.

  // Images in Word docs arrive as embedded base64 data — huge and useless in
  // Markdown, so replace them with a marker (or drop them entirely).
  td.addRule("stripImages", {
    filter: "img",
    replacement: () => (optImageMarks.checked ? "*(image omitted)*" : ""),
  });
  return td;
}

// --- PDF → Markdown ----------------------------------------------------
async function convertPdf(file, fileIndex, fileCount) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const total = pdf.numPages;
  const pages = [];
  let ocrPages = 0;
  let failedPages = 0;
  let ocrLang = null; // resolved once per file, then reused

  try {
    for (let i = 1; i <= total; i++) {
      // Live progress across every page so long documents show real movement
      // (and so it's obvious the run hasn't finished early).
      setProgress((fileIndex + i / total) / fileCount, `Converting ${file.name} — page ${i} of ${total}…`);

      let fragment = "";
      let page = null;
      try {
        page = await pdf.getPage(i);
        const { md, chars, garbled } = await convertPdfPage(page);
        fragment = md;

        // OCR when the page is image-based (no text) or the extracted text is
        // garbled (e.g. a CJK font with no ToUnicode map), if OCR is enabled.
        if ((chars < 8 || garbled) && optOcr.checked) {
          const canvas = await renderPdfPageToCanvas(page);
          if (ocrLang === null) {
            setProgress((fileIndex + i / total) / fileCount, `Detecting language in ${file.name}…`);
            ocrLang = await resolveOcrLang(canvas);
          }
          setProgress((fileIndex + i / total) / fileCount, `OCR ${file.name} — page ${i} of ${total} (${ocrLang})…`);
          const text = await ocrImageSource(canvas, ocrLang);
          if (text) {
            fragment = tidy(text);
            ocrPages++;
          }
        }
      } catch (err) {
        // Isolate a bad page instead of losing the rest of the document.
        console.error(`page ${i} failed:`, err);
        failedPages++;
        fragment = `*(page ${i} could not be read)*`;
      } finally {
        if (page) page.cleanup();
      }

      pages.push(fragment);
      await new Promise((r) => setTimeout(r, 0)); // stay responsive on large PDFs
    }
  } finally {
    // Release the document's memory — important for large/multi-file batches.
    pdf.destroy();
  }

  let md = pages.join(optPageBreaks.checked ? "\n\n---\n\n" : "\n\n");
  md = tidy(md);
  const meta =
    `PDF · ${total} page${total > 1 ? "s" : ""}` +
    (ocrPages ? ` · ${ocrPages} OCR'd${ocrLang ? ` (${ocrLang})` : ""}` : "") +
    (failedPages ? ` · ${failedPages} unreadable` : "");
  return { markdown: md, meta };
}

// Render a PDF page to a canvas (for OCR).
async function renderPdfPageToCanvas(page) {
  const base = page.getViewport({ scale: 1 });
  // Aim for ~1600px on the long edge — enough resolution for OCR accuracy.
  const scale = Math.min(3, Math.max(1.5, 1600 / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// Convert a single page's text content into a Markdown fragment.
async function convertPdfPage(page) {
  const content = await page.getTextContent();
  const items = content.items.filter((it) => "str" in it);

  // Build lines: group items that share roughly the same baseline (y).
  // pdf.js transform = [a, b, c, d, e, f]; e = x, f = y, font size ≈ |d|.
  const rawLines = [];
  const yTolerance = 3;

  for (const it of items) {
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
    const fontName = it.fontName || "";

    let line = rawLines.find((l) => Math.abs(l.y - y) <= yTolerance);
    if (!line) {
      line = { y, items: [] };
      rawLines.push(line);
    }
    line.items.push({ x, str: it.str, size, fontName, width: it.width });
  }

  if (!rawLines.length) {
    // No extractable text — likely a scanned/image-only page.
    const md = optImageMarks.checked ? "*(no extractable text on this page)*" : "";
    return { md, chars: 0 };
  }

  // Top-to-bottom, then left-to-right within each line.
  rawLines.sort((a, b) => b.y - a.y);
  const lines = rawLines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = "";
    let prev = null;
    for (const part of line.items) {
      if (prev) {
        const gap = part.x - (prev.x + prev.width);
        const spaceW = prev.size * 0.25;
        const lastCh = text.slice(-1);
        const firstCh = part.str.charAt(0);
        // CJK scripts don't use spaces between characters; positional gaps
        // there are just glyph spacing, so don't inject spaces between them.
        const cjkBoundary = isCJK(lastCh) && isCJK(firstCh);
        if (gap > spaceW && !cjkBoundary && !/\s$/.test(text) && !/^\s/.test(part.str)) text += " ";
      }
      text += part.str;
      prev = part;
    }
    const size = median(line.items.map((p) => p.size));
    const bold = line.items.some((p) => /bold|black|heavy|semibold/i.test(p.fontName));
    return { y: line.y, text: text.replace(/[ \t]+/g, " ").trim(), size, bold };
  });

  // Body font size = the most common line size, used as the heading baseline.
  const bodySize = mode(lines.map((l) => Math.round(l.size)));

  const out = [];
  let prevY = null;
  let prevSize = bodySize;

  for (const line of lines) {
    if (!line.text) continue;

    // Blank line when the vertical gap is noticeably larger than line spacing.
    if (prevY !== null) {
      const gap = prevY - line.y;
      if (gap > prevSize * 1.6) out.push("");
    }

    let md = line.text;
    if (optHeadings.checked) {
      const ratio = line.size / bodySize;
      const short = line.text.length <= 120;
      if (ratio >= 2.0 && short) md = `# ${md}`;
      else if (ratio >= 1.5 && short) md = `## ${md}`;
      else if (ratio >= 1.18 && short) md = `### ${md}`;
      else if (line.bold && short && /[A-Za-z]/.test(line.text) && line.text.length <= 80) {
        // A short, fully-bold line that isn't bigger: treat as a minor heading.
        md = `**${md}**`;
      }
    }

    out.push(md);
    prevY = line.y;
    prevSize = line.size;
  }

  const allText = lines.map((l) => l.text).join("");
  const chars = allText.replace(/\s/g, "").length;
  // "Garbled" = a page whose extracted text is mostly U+FFFD replacement
  // characters, which happens when a font (often CJK) has no ToUnicode map.
  const bad = (allText.match(/�/g) || []).length;
  const garbled = chars > 0 && bad / chars > 0.2;
  return { md: out.join("\n"), chars, garbled };
}

// Is this character in a CJK block (Chinese/Japanese/Korean ideographs & kana)?
function isCJK(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (
    (c >= 0x3040 && c <= 0x30ff) || // hiragana + katakana
    (c >= 0x3400 && c <= 0x4dbf) || // CJK ext A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK unified ideographs
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
    (c >= 0xf900 && c <= 0xfaff) // CJK compatibility ideographs
  );
}

// --- Rendering results -------------------------------------------------
function renderResults() {
  resultsEl.innerHTML = "";
  const format = outputFormat; // live: reflects the current toggle
  const compareMode = results.some((r) => r.isCompare);
  const okCount = results.filter((r) => r.ok).length;

  resultsHead.hidden = false;
  // The .md/.docx toggle is irrelevant for a comparison (always a Word redline).
  formatToggle.hidden = compareMode;
  resultsSummary.textContent = compareMode
    ? (okCount ? "Comparison ready" : "Comparison failed")
    : `${okCount} of ${results.length} file${results.length > 1 ? "s" : ""} converted`;
  downloadAllBtn.hidden = okCount < 2;

  results.forEach((r) => {
    const card = document.createElement("div");
    card.className = "card" + (r.ok ? "" : " card-error");

    const bar = document.createElement("div");
    bar.className = "card-bar";

    const ext = r.isCompare || format === "docx" ? "docx" : "md";
    const previewText = r.isCompare ? r.previewText : r.markdown;
    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = r.ok ? `${r.baseName}.${ext}  ·  ${r.meta}` : `${r.baseName}  ·  failed`;
    bar.appendChild(name);

    if (r.ok) {
      const actions = document.createElement("div");
      actions.className = "card-actions";

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-secondary";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(previewText);
        } catch {
          const ta = card.querySelector("textarea");
          ta.select();
          document.execCommand("copy");
        }
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      });

      const dlBtn = document.createElement("button");
      dlBtn.className = "btn";
      dlBtn.textContent = `Download .${ext}`;
      dlBtn.addEventListener("click", async () => {
        dlBtn.disabled = true;
        const original = dlBtn.textContent;
        if (ext === "docx" && !r.isCompare) dlBtn.textContent = "Building…";
        try {
          const { blob, name: fname } = await fileFor(r);
          downloadBlob(blob, fname);
        } catch (err) {
          console.error(err);
          showError(`Couldn't build the .docx: ${err.message || err}`);
        } finally {
          dlBtn.textContent = original;
          dlBtn.disabled = false;
        }
      });

      actions.append(copyBtn, dlBtn);
      bar.appendChild(actions);
    }

    card.appendChild(bar);

    if (r.ok && r.isCompare) {
      const note = document.createElement("p");
      note.className = "card-note";
      note.textContent =
        "Open the .docx in Word, Google Docs, or LibreOffice with Track Changes to accept/reject edits. Preview below shows added (+) and removed (−) lines.";
      card.appendChild(note);
    }

    if (r.ok) {
      const ta = document.createElement("textarea");
      ta.className = "output";
      ta.readOnly = true;
      ta.spellcheck = false;
      ta.value = previewText;
      card.appendChild(ta);
    } else {
      const msg = document.createElement("p");
      msg.className = "card-msg";
      msg.textContent = r.error;
      card.appendChild(msg);
    }

    resultsEl.appendChild(card);
  });
}

async function downloadAllZip() {
  downloadAllBtn.disabled = true;
  const label = downloadAllBtn.textContent;
  downloadAllBtn.textContent = "Building…";
  try {
    const zip = new JSZip();
    const used = new Map();
    for (const r of results) {
      if (!r.ok) continue;
      const { blob, name } = await fileFor(r);
      // Avoid clobbering when two inputs share a base name.
      let unique = name;
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        unique = name.replace(/(\.[^.]+)$/, ` (${n})$1`);
      } else {
        used.set(name, 1);
      }
      zip.file(unique, blob);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, "converted-files.zip");
  } catch (err) {
    console.error(err);
    showError(`Couldn't build the zip: ${err.message || err}`);
  } finally {
    downloadAllBtn.textContent = label;
    downloadAllBtn.disabled = false;
  }
}

// --- Helpers -----------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function tidy(md) {
  return md
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
    .concat("\n");
}

function countWords(md) {
  const m = md.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mode(nums) {
  if (!nums.length) return 10;
  const counts = new Map();
  let best = nums[0];
  let bestCount = 0;
  for (const n of nums) {
    const c = (counts.get(n) || 0) + 1;
    counts.set(n, c);
    if (c > bestCount) {
      bestCount = c;
      best = n;
    }
  }
  return best;
}

function setProgress(fraction, label) {
  if (fraction != null) progressFill.style.width = `${Math.round(fraction * 100)}%`;
  if (label) progressLabel.textContent = label;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function hideError() {
  errorEl.hidden = true;
}
