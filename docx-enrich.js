// Enrich a Word .docx's OOXML *before* mammoth converts it, to recover three
// things mammoth otherwise loses:
//
//  1. Auto-numbering — Word's list/heading numbers ("1.", "1.1.", "a)") are
//     field-generated, not literal text, so mammoth drops the composite value.
//     We compute each numbered paragraph's number from numbering.xml and inject
//     it as literal text (then remove the numPr so mammoth doesn't renumber).
//  2. Tracked changes — mammoth silently accepts insertions and discards
//     deletions. We mark insertions {++like this++} and keep deletions
//     {--like this--} (CriticMarkup), so nothing is lost.
//  3. Comments — mammoth drops them. We inline each as {>>comment<<}.
//
// Everything runs on the XML with DOMParser/XMLSerializer; the modified
// document.xml is written back into the zip and handed to mammoth.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS = (el, name) => el.getElementsByTagNameNS(W, name);

export async function enrichDocx(arrayBuffer, opts = {}) {
  const keepChanges = opts.keepChanges !== false;
  let zip;
  try {
    zip = await window.JSZip.loadAsync(arrayBuffer);
  } catch {
    return arrayBuffer;
  }
  const docFile = zip.file("word/document.xml");
  if (!docFile) return arrayBuffer;

  const dom = new DOMParser().parseFromString(await docFile.async("string"), "application/xml");
  if (dom.getElementsByTagName("parsererror").length) return arrayBuffer;

  const numbering = await loadNumbering(zip);
  applyNumbering(dom, numbering);

  if (keepChanges) {
    markInsertions(dom);
    keepDeletions(dom);
    injectComments(dom, await loadComments(zip));
  }

  zip.file("word/document.xml", new XMLSerializer().serializeToString(dom));
  return zip.generateAsync({ type: "arraybuffer" });
}

// --- helpers to build w: nodes ----------------------------------------
function textRun(dom, text) {
  const r = dom.createElementNS(W, "w:r");
  const t = dom.createElementNS(W, "w:t");
  t.setAttribute("xml:space", "preserve");
  t.appendChild(dom.createTextNode(text));
  r.appendChild(t);
  return r;
}

// --- 1. Auto-numbering -------------------------------------------------
async function loadNumbering(zip) {
  const f = zip.file("word/numbering.xml");
  if (!f) return null;
  const dom = new DOMParser().parseFromString(await f.async("string"), "application/xml");
  if (dom.getElementsByTagName("parsererror").length) return null;

  const abstracts = {};
  for (const an of NS(dom, "abstractNum")) {
    const id = an.getAttributeNS(W, "abstractNumId");
    const levels = {};
    for (const lvl of NS(an, "lvl")) {
      const ilvl = lvl.getAttributeNS(W, "ilvl");
      const fmtEl = NS(lvl, "numFmt")[0];
      const txtEl = NS(lvl, "lvlText")[0];
      const startEl = NS(lvl, "start")[0];
      levels[ilvl] = {
        numFmt: fmtEl ? fmtEl.getAttributeNS(W, "val") : "decimal",
        lvlText: txtEl ? txtEl.getAttributeNS(W, "val") : "%1.",
        start: startEl ? parseInt(startEl.getAttributeNS(W, "val"), 10) || 1 : 1,
      };
    }
    abstracts[id] = levels;
  }
  const nums = {};
  for (const n of NS(dom, "num")) {
    const numId = n.getAttributeNS(W, "numId");
    const ref = NS(n, "abstractNumId")[0];
    if (ref) nums[numId] = ref.getAttributeNS(W, "val");
  }
  return { abstracts, nums };
}

function applyNumbering(dom, numbering) {
  if (!numbering) return;
  const counters = {}; // abstractId -> { ilvl -> current }

  for (const p of [...NS(dom, "p")]) {
    const pPr = NS(p, "pPr")[0];
    if (!pPr) continue;
    const numPr = NS(pPr, "numPr")[0];
    if (!numPr) continue;
    const ilvlEl = NS(numPr, "ilvl")[0];
    const numIdEl = NS(numPr, "numId")[0];
    if (!numIdEl) continue;
    const ilvl = ilvlEl ? ilvlEl.getAttributeNS(W, "val") : "0";
    const numId = numIdEl.getAttributeNS(W, "val");
    const absId = numbering.nums[numId];
    const abstract = absId != null ? numbering.abstracts[absId] : null;
    const level = abstract && abstract[ilvl];
    if (!level) continue;
    if (/^bullet$/i.test(level.numFmt) || level.numFmt === "none") continue; // leave bullets to mammoth

    const li = parseInt(ilvl, 10);
    const c = (counters[absId] = counters[absId] || {});
    c[li] = c[li] === undefined ? level.start : c[li] + 1;
    for (const k in c) if (parseInt(k, 10) > li) delete c[k]; // reset deeper levels

    const label = level.lvlText.replace(/%(\d)/g, (_, d) => {
      const idx = parseInt(d, 10) - 1;
      const lv = abstract[String(idx)];
      const val = c[idx] != null ? c[idx] : (lv ? lv.start : 1);
      return formatNum(val, lv ? lv.numFmt : "decimal");
    });

    // Inject the literal number and stop mammoth from renumbering.
    p.insertBefore(textRun(dom, label + " "), pPr.nextSibling);
    numPr.parentNode.removeChild(numPr);
  }
}

function formatNum(n, fmt) {
  switch (fmt) {
    case "decimalZero": return n < 10 ? "0" + n : String(n);
    case "lowerLetter": return toLetter(n);
    case "upperLetter": return toLetter(n).toUpperCase();
    case "lowerRoman": return toRoman(n);
    case "upperRoman": return toRoman(n).toUpperCase();
    default: return String(n);
  }
}
function toLetter(n) {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s || "a";
}
function toRoman(n) {
  const map = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, sym] of map) while (n >= v) { s += sym; n -= v; }
  return s || "i";
}

// --- 2. Tracked changes ------------------------------------------------
function markInsertions(dom) {
  for (const ins of [...NS(dom, "ins")]) {
    ins.insertBefore(textRun(dom, "{++"), ins.firstChild);
    ins.appendChild(textRun(dom, "++}"));
  }
}

// Deletions live in <w:del> with <w:delText>; mammoth drops the whole element.
// Unwrap it, turn delText into normal text, and bracket it as {--...--}.
function keepDeletions(dom) {
  for (const del of [...NS(dom, "del")]) {
    for (const dt of [...NS(del, "delText")]) {
      const t = dom.createElementNS(W, "w:t");
      t.setAttribute("xml:space", "preserve");
      t.appendChild(dom.createTextNode(dt.textContent));
      dt.parentNode.replaceChild(t, dt);
    }
    const parent = del.parentNode;
    parent.insertBefore(textRun(dom, "{--"), del);
    while (del.firstChild) parent.insertBefore(del.firstChild, del);
    parent.insertBefore(textRun(dom, "--}"), del);
    parent.removeChild(del);
  }
}

async function loadComments(zip) {
  const f = zip.file("word/comments.xml");
  if (!f) return {};
  const dom = new DOMParser().parseFromString(await f.async("string"), "application/xml");
  if (dom.getElementsByTagName("parsererror").length) return {};
  const out = {};
  for (const c of NS(dom, "comment")) {
    const id = c.getAttributeNS(W, "id");
    out[id] = [...NS(c, "t")].map((t) => t.textContent).join("").trim();
  }
  return out;
}

function injectComments(dom, comments) {
  for (const ref of [...NS(dom, "commentReference")]) {
    const id = ref.getAttributeNS(W, "id");
    const text = comments[id];
    if (!text) continue;
    const run = ref.closest ? ref.closest("*") : ref.parentNode; // the enclosing w:r
    const host = run && run.parentNode ? run : ref.parentNode;
    host.parentNode.insertBefore(textRun(dom, ` {>>${text}<<}`), host.nextSibling);
  }
}
