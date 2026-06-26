// PDF → Markdown converter — runs entirely client-side using pdf.js.
//
// Strategy: pull the positioned text items out of each page, regroup them into
// visual lines, then apply lightweight heuristics (font size → heading level,
// vertical gaps → paragraph breaks) to reconstruct a readable Markdown document.

import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

// --- DOM ---------------------------------------------------------------
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const resultSection = document.getElementById("result");
const resultName = document.getElementById("result-name");
const output = document.getElementById("output");
const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");
const errorEl = document.getElementById("error");

const optHeadings = document.getElementById("opt-headings");
const optPageBreaks = document.getElementById("opt-pagebreaks");
const optImageMarks = document.getElementById("opt-imagemarks");

let lastMarkdown = "";
let lastBaseName = "document";

// --- Wiring ------------------------------------------------------------
browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
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
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastMarkdown);
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  } catch {
    output.select();
    document.execCommand("copy");
  }
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([lastMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${lastBaseName}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

// --- Main flow ---------------------------------------------------------
async function handleFile(file) {
  hideError();
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showError("That doesn't look like a PDF. Please choose a .pdf file.");
    return;
  }

  lastBaseName = file.name.replace(/\.pdf$/i, "") || "document";
  resultSection.hidden = true;
  progressWrap.hidden = false;
  setProgress(0, "Reading file…");

  try {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const total = pdf.numPages;
    const pages = [];

    for (let i = 1; i <= total; i++) {
      const page = await pdf.getPage(i);
      pages.push(await convertPage(page));
      page.cleanup();
      setProgress(i / total, `Converting page ${i} of ${total}…`);
      // Yield to the event loop so the UI stays responsive on large PDFs.
      await new Promise((r) => setTimeout(r, 0));
    }

    let md = pages.join(optPageBreaks.checked ? "\n\n---\n\n" : "\n\n");
    md = tidy(md);

    lastMarkdown = md;
    output.value = md;
    resultName.textContent = `${lastBaseName}.md  ·  ${total} page${total > 1 ? "s" : ""}`;
    progressWrap.hidden = true;
    resultSection.hidden = false;
  } catch (err) {
    console.error(err);
    progressWrap.hidden = true;
    showError(`Couldn't convert this PDF: ${err.message || err}`);
  }
}

// Convert a single page's text content into a Markdown fragment.
async function convertPage(page) {
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
    return optImageMarks.checked ? "*(no extractable text on this page)*" : "";
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

  return out.join("\n");
}

// --- Markdown tidy-up --------------------------------------------------
function tidy(md) {
  return md
    .replace(/[ \t]+\n/g, "\n") // trailing spaces
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .replace(/^\s+|\s+$/g, "") // trim ends
    .concat("\n");
}

// --- Small stats helpers ----------------------------------------------
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

// --- UI helpers --------------------------------------------------------
function setProgress(fraction, label) {
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
  if (label) progressLabel.textContent = label;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function hideError() {
  errorEl.hidden = true;
}
