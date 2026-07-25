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
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

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
const optFormat = document.getElementById("opt-format");

let results = []; // [{ baseName, markdown, meta, ok, error }]
let ocrWorker = null; // lazily created, reused across a batch

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

// Output format is a download-time choice: re-render existing results so their
// buttons/filenames update the moment the selector changes.
optFormat.addEventListener("change", () => {
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

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setProgress(i / files.length, `Converting ${file.name} (${i + 1} of ${files.length})…`);
    await new Promise((r) => setTimeout(r, 0)); // let the UI paint

    const baseName = file.name.replace(/\.(pdf|docx?)$/i, "") || "document";
    try {
      const kind = detectKind(file);
      if (kind === "pdf") {
        const { markdown, meta } = await convertPdf(file, i, files.length);
        results.push({ baseName, markdown, meta, ok: true });
      } else if (kind === "docx") {
        const { markdown, meta } = await convertDocx(file);
        results.push({ baseName, markdown, meta, ok: true });
      } else if (kind === "image") {
        const { markdown, meta } = await convertImage(file);
        results.push({ baseName, markdown, meta, ok: true });
      } else if (kind === "doc") {
        results.push({ baseName, ok: false, error: "Old .doc format isn't supported — save it as .docx and try again." });
      } else {
        results.push({ baseName, ok: false, error: "Unsupported file type. Please use a PDF, .docx, or image file." });
      }
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

// Produce the downloadable file for a result in its chosen format. The docx
// blob is generated on demand and cached on the result object.
async function fileFor(r) {
  if (optFormat.value === "docx") {
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
  if (/\.(png|jpe?g|webp|bmp|gif)$/.test(n) || file.type.startsWith("image/")) return "image";
  return "unknown";
}

// --- OCR (Tesseract.js) ------------------------------------------------
// One worker is created on first use and reused for the whole batch.
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await Tesseract.createWorker("eng", 1, OCR_PATHS);
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
}

async function ocrImageSource(source) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(source);
  return (data.text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Convert a whole image file to Markdown via OCR.
async function convertImage(file) {
  if (!optOcr.checked) {
    return {
      markdown: `*(image file — enable “OCR scanned pages & images” to extract text)*\n`,
      meta: "image · OCR off",
    };
  }
  setProgress(null, `OCR ${file.name}…`);
  const text = await ocrImageSource(file);
  return { markdown: tidy(text || "*(no text found in image)*"), meta: `image · OCR` };
}

// --- DOCX → Markdown ---------------------------------------------------
async function convertDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  const md = tidy(makeTurndown().turndown(prepDocxHtml(html)));
  return { markdown: md, meta: `Word · ${countWords(md)} words` };
}

// mammoth emits table cells as <td><p>…</p></td> with no header row, but the
// GFM Markdown-table rule only fires when the first row is <th>. Markdown
// tables need a header row anyway, so: flatten the paragraphs inside each cell
// and promote the first row's cells to <th>.
function prepDocxHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  doc.querySelectorAll("td, th").forEach((cell) => {
    const ps = cell.querySelectorAll(":scope > p");
    if (ps.length) {
      cell.innerHTML = [...ps].map((p) => p.innerHTML.trim()).join(" ");
    }
  });

  doc.querySelectorAll("table").forEach((table) => {
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

  for (let i = 1; i <= total; i++) {
    const page = await pdf.getPage(i);
    const { md, chars } = await convertPdfPage(page);
    let fragment = md;

    // A page with essentially no extractable text is image-based. If OCR is
    // enabled, rasterize it and read the text off the pixels instead.
    if (chars < 8 && optOcr.checked) {
      setProgress(fileIndex / fileCount, `OCR ${file.name} — page ${i} of ${total}…`);
      const text = await ocrPdfPage(page);
      if (text) {
        fragment = tidy(text);
        ocrPages++;
      }
    }

    pages.push(fragment);
    page.cleanup();
    await new Promise((r) => setTimeout(r, 0)); // stay responsive on large PDFs
  }

  let md = pages.join(optPageBreaks.checked ? "\n\n---\n\n" : "\n\n");
  md = tidy(md);
  const meta =
    `PDF · ${total} page${total > 1 ? "s" : ""}` + (ocrPages ? ` · ${ocrPages} OCR'd` : "");
  return { markdown: md, meta };
}

// Render a PDF page to a canvas and OCR it.
async function ocrPdfPage(page) {
  const base = page.getViewport({ scale: 1 });
  // Aim for ~1600px on the long edge — enough resolution for OCR accuracy.
  const scale = Math.min(3, Math.max(1.5, 1600 / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return ocrImageSource(canvas);
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
        if (gap > spaceW && !/\s$/.test(text) && !/^\s/.test(part.str)) text += " ";
      }
      text += part.str;
      prev = part;
    }
    const size = median(line.items.map((p) => p.size));
    const bold = line.items.some((p) => /bold|black|heavy|semibold/i.test(p.fontName));
    return { y: line.y, text: text.replace(/\s+/g, " ").trim(), size, bold };
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

  const chars = lines.reduce((n, l) => n + l.text.replace(/\s/g, "").length, 0);
  return { md: out.join("\n"), chars };
}

// --- Rendering results -------------------------------------------------
function renderResults() {
  resultsEl.innerHTML = "";
  const format = optFormat.value; // live: reflects the current selector
  const okCount = results.filter((r) => r.ok).length;

  resultsHead.hidden = false;
  resultsSummary.textContent =
    `${okCount} of ${results.length} file${results.length > 1 ? "s" : ""} converted`;
  downloadAllBtn.hidden = okCount < 2;

  results.forEach((r, idx) => {
    const card = document.createElement("div");
    card.className = "card" + (r.ok ? "" : " card-error");

    const bar = document.createElement("div");
    bar.className = "card-bar";

    const ext = format === "docx" ? "docx" : "md";
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
          await navigator.clipboard.writeText(r.markdown);
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
        if (format === "docx") dlBtn.textContent = "Building…";
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

    if (r.ok) {
      const ta = document.createElement("textarea");
      ta.className = "output";
      ta.readOnly = true;
      ta.spellcheck = false;
      ta.value = r.markdown;
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
