// Compare two documents and produce a Word .docx with real tracked changes.
//
// Both inputs arrive as Markdown (the app converts PDF/Word/MD to Markdown
// first). We lex each into block-level units (headings, paragraphs, list
// items, tables, code) and, crucially, keep each block's inline formatting as
// a list of styled runs (bold / italic / strikethrough / inline-code) rather
// than flattening to plain text. We diff the block sequences, and within a
// changed block diff word-by-word (character-by-character for CJK), carrying
// each fragment's formatting into the output. Output uses docx InsertedTextRun
// / DeletedTextRun so Word, Google Docs, and LibreOffice show it as an
// accept/reject redline.
//
// Preserved: heading level (relative font size), bullets, numbering, and
// bold/italic/code. Not preserved (not present in Markdown): exact point
// sizes, colors, and fonts.

const { marked, docx, Diff } = window;

const AUTHOR = "Comparison";
const DATE = new Date().toISOString();

export async function compareToDocxBlob(oldMd, newMd) {
  const d = docx;
  const oldBlocks = extractBlocks(oldMd);
  const newBlocks = extractBlocks(newMd);

  let revId = 1;
  const nextId = () => revId++;
  const children = [];

  const comparator = (a, b) =>
    a.kind === b.kind &&
    (a.depth || 0) === (b.depth || 0) &&
    !!a.ordered === !!b.ordered &&
    (a.level || 0) === (b.level || 0) &&
    norm(a.text) === norm(b.text);

  const parts = Diff.diffArrays(oldBlocks, newBlocks, { comparator });

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (const blk of part.value) children.push(...renderBlock(blk, "same", d, nextId));
    } else if (part.removed) {
      const next = parts[i + 1];
      if (next && next.added) {
        const olds = part.value;
        const news = next.value;
        const n = Math.max(olds.length, news.length);
        for (let j = 0; j < n; j++) {
          if (j < olds.length && j < news.length) {
            children.push(...renderModified(olds[j], news[j], d, nextId));
          } else if (j < news.length) {
            children.push(...renderBlock(news[j], "ins", d, nextId));
          } else {
            children.push(...renderBlock(olds[j], "del", d, nextId));
          }
        }
        i++; // consumed the following "added" part
      } else {
        for (const blk of part.value) children.push(...renderBlock(blk, "del", d, nextId));
      }
    } else if (part.added) {
      for (const blk of part.value) children.push(...renderBlock(blk, "ins", d, nextId));
    }
  }

  const doc = new d.Document({
    features: { trackRevisions: true }, // open with Track Changes visible
    numbering: { config: [orderedConfig("cmp-ord", d)] },
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children: children.length ? children : [new d.Paragraph({})] }],
  });
  return d.Packer.toBlob(doc);
}

// --- Block extraction (keeps inline styling) ---------------------------
function extractBlocks(md) {
  const toks = marked.lexer(md || "");
  const blocks = [];
  for (const t of toks) pushBlock(t, blocks, 0);
  return blocks;
}

function pushBlock(t, blocks, level) {
  const add = (kind, runs, extra = {}) =>
    blocks.push({ kind, runs, text: runs.map((r) => r.text).join(""), ...extra });

  switch (t.type) {
    case "space":
      break;
    case "heading":
      add("heading", inlineRuns(t.tokens), { depth: t.depth });
      break;
    case "paragraph":
      add("para", inlineRuns(t.tokens));
      break;
    case "blockquote":
      add("quote", inlineRuns(t.tokens || []));
      break;
    case "code":
      add("code", [{ text: String(t.text || ""), code: true }]);
      break;
    case "list":
      for (const item of t.items) {
        const inline = [];
        const nested = [];
        for (const c of item.tokens || []) {
          if (c.type === "list") nested.push(c);
          else if (c.type === "text") inline.push(...(c.tokens || [{ type: "text", text: c.text }]));
          else if (c.type === "paragraph") inline.push(...c.tokens);
          else if (c.text) inline.push({ type: "text", text: c.text });
        }
        add("li", inlineRuns(inline), { ordered: !!t.ordered, level });
        for (const n of nested) pushBlock(n, blocks, level + 1);
      }
      break;
    case "table":
      blocks.push({ kind: "table", token: t, runs: [], text: tableText(t) });
      break;
    default:
      if (t.text) add("para", [{ text: stripMd(t.text) }]);
  }
}

// Flatten marked inline tokens to styled runs: { text, bold, italic, strike, code }.
function inlineRuns(tokens, base = {}) {
  const runs = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "text":
      case "escape":
        runs.push({ text: t.text, ...base });
        break;
      case "strong":
        runs.push(...inlineRuns(t.tokens, { ...base, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns(t.tokens, { ...base, italic: true }));
        break;
      case "del":
        runs.push(...inlineRuns(t.tokens, { ...base, strike: true }));
        break;
      case "codespan":
        runs.push({ text: t.text, ...base, code: true });
        break;
      case "br":
        runs.push({ text: " ", ...base });
        break;
      case "link":
        runs.push(...inlineRuns(t.tokens, base));
        break;
      default:
        if (t.tokens) runs.push(...inlineRuns(t.tokens, base));
        else if (typeof t.text === "string") runs.push({ text: t.text, ...base });
    }
  }
  return runs.length ? runs : [{ text: "" }];
}

function inlineText(tokens) {
  return inlineRuns(tokens).map((r) => r.text).join("").replace(/\s+/g, " ").trim();
}

function tableText(t) {
  const head = t.header.map((c) => inlineText(c.tokens)).join(" | ");
  const rows = t.rows.map((r) => r.map((c) => inlineText(c.tokens)).join(" | ")).join(" \n ");
  return head + " \n " + rows;
}

function stripMd(s) {
  return String(s).replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
}

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

// --- Rendering ---------------------------------------------------------
// A block with every run in one status (same / ins / del), keeping styling.
function renderBlock(blk, status, d, nextId) {
  if (blk.kind === "table") return [renderTable(blk.token, status, d, nextId)];
  const children = blk.runs
    .filter((r) => r.text !== "")
    .map((r) => makeRun(r.text, status, d, nextId, r));
  if (!children.length) children.push(makeRun("", status, d, nextId, {}));
  return [paragraphFor(blk, children, d)];
}

// A modified block: word-level (char-level for CJK) diff, carrying styling.
function renderModified(oldBlk, newBlk, d, nextId) {
  if (oldBlk.kind !== newBlk.kind || oldBlk.kind === "table" || oldBlk.kind === "code") {
    return [...renderBlock(oldBlk, "del", d, nextId), ...renderBlock(newBlk, "ins", d, nextId)];
  }
  const oldChars = expandToChars(oldBlk.runs);
  const newChars = expandToChars(newBlk.runs);
  const oldText = oldChars.map((c) => c.ch).join("");
  const newText = newChars.map((c) => c.ch).join("");
  const cjk = isCJKHeavy(oldText) || isCJKHeavy(newText);
  const parts = cjk ? Diff.diffChars(oldText, newText) : Diff.diffWordsWithSpace(oldText, newText);

  const groups = [];
  let oi = 0;
  let ni = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) {
      appendChars(groups, newChars, ni, len, "ins");
      ni += len;
    } else if (p.removed) {
      appendChars(groups, oldChars, oi, len, "del");
      oi += len;
    } else {
      appendChars(groups, newChars, ni, len, "same");
      ni += len;
      oi += len;
    }
  }
  const children = groups.map((g) => makeRun(g.text, g.status, d, nextId, g.style));
  if (!children.length) children.push(makeRun("", "same", d, nextId, {}));
  return [paragraphFor(newBlk, children, d)];
}

// Expand styled runs to a per-character array carrying each char's style.
function expandToChars(runs) {
  const out = [];
  for (const r of runs) {
    const style = { bold: r.bold, italic: r.italic, strike: r.strike, code: r.code };
    for (const ch of r.text) out.push({ ch, style });
  }
  return out;
}

// Append `len` chars from `chars[start..]` to `groups`, merging runs that share
// the same (status, style) so we emit as few docx runs as possible.
function appendChars(groups, chars, start, len, status) {
  for (let i = 0; i < len; i++) {
    const c = chars[start + i];
    if (!c) continue;
    const key = status + "|" + styleKey(c.style);
    const last = groups[groups.length - 1];
    if (last && last._key === key) last.text += c.ch;
    else groups.push({ text: c.ch, status, style: c.style, _key: key });
  }
}

function styleKey(s) {
  return `${!!s.bold}${!!s.italic}${!!s.strike}${!!s.code}`;
}

function paragraphFor(blk, children, d) {
  const opts = { children };
  if (blk.kind === "heading") opts.heading = d.HeadingLevel[`HEADING_${Math.min(Math.max(blk.depth, 1), 6)}`];
  else if (blk.kind === "li") {
    if (blk.ordered) opts.numbering = { reference: "cmp-ord", level: blk.level || 0 };
    else opts.bullet = { level: blk.level || 0 };
  } else if (blk.kind === "quote") {
    opts.indent = { left: 480 };
  } else if (blk.kind === "code") {
    opts.shading = { type: "clear", fill: "F2F2F2" };
  }
  return new d.Paragraph(opts);
}

function makeRun(text, status, d, nextId, style = {}) {
  const opts = { text };
  if (style.bold) opts.bold = true;
  if (style.italic) opts.italics = true;
  if (style.strike) opts.strike = true;
  if (style.code) {
    opts.font = "Consolas";
    opts.size = 20;
  }
  if (status === "ins") return new d.InsertedTextRun({ id: nextId(), author: AUTHOR, date: DATE, ...opts });
  if (status === "del") return new d.DeletedTextRun({ id: nextId(), author: AUTHOR, date: DATE, ...opts });
  return new d.TextRun(opts);
}

function renderTable(token, status, d, nextId) {
  const cell = (c, header) =>
    new d.TableCell({
      width: { size: Math.floor(10000 / (token.header.length || 1)) / 100, type: d.WidthType.PERCENTAGE },
      shading: header ? { type: "clear", fill: "F2F2F2" } : undefined,
      children: [new d.Paragraph({ children: [makeRun(inlineText(c.tokens), status, d, nextId, { bold: header })] })],
    });
  const rows = [
    new d.TableRow({ tableHeader: true, children: token.header.map((c) => cell(c, true)) }),
    ...token.rows.map((r) => new d.TableRow({ children: r.map((c) => cell(c, false)) })),
  ];
  return new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows });
}

function isCJKHeavy(text) {
  const cjk = (text.match(/[㐀-鿿぀-ヿ가-힣]/g) || []).length;
  const nonSpace = text.replace(/\s/g, "").length;
  return nonSpace > 0 && cjk / nonSpace > 0.3;
}

function orderedConfig(reference, d) {
  return {
    reference,
    levels: [0, 1, 2, 3].map((level) => ({
      level,
      format: d.LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: d.AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    })),
  };
}
