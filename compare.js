// Compare two documents and produce a Word .docx with real tracked changes.
//
// Both inputs arrive as Markdown (the app converts PDF/Word/MD to Markdown
// first). We lex each into block-level units (headings, paragraphs, list
// items, tables, code), diff the block sequences, and within a changed block
// diff word-by-word. Output uses docx InsertedTextRun / DeletedTextRun so Word,
// Google Docs, and LibreOffice show it as an accept/reject redline. Structure
// that carries formatting — heading level (font size), bullets, numbering — is
// preserved on each block.

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
        // A modification: pair old blocks with new blocks positionally.
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

// --- Block extraction --------------------------------------------------
function extractBlocks(md) {
  const toks = marked.lexer(md || "");
  const blocks = [];
  for (const t of toks) pushBlock(t, blocks, 0);
  return blocks;
}

function pushBlock(t, blocks, level) {
  switch (t.type) {
    case "space":
      break;
    case "heading":
      blocks.push({ kind: "heading", depth: t.depth, text: inlineText(t.tokens) });
      break;
    case "paragraph":
      blocks.push({ kind: "para", text: inlineText(t.tokens) });
      break;
    case "blockquote":
      blocks.push({ kind: "quote", text: inlineText(t.tokens || []) || stripMd(t.text) });
      break;
    case "code":
      blocks.push({ kind: "code", text: String(t.text || "") });
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
        blocks.push({ kind: "li", ordered: !!t.ordered, level, text: inlineText(inline) });
        for (const n of nested) pushBlock(n, blocks, level + 1);
      }
      break;
    case "table":
      blocks.push({ kind: "table", token: t, text: tableText(t) });
      break;
    default:
      if (t.text) blocks.push({ kind: "para", text: stripMd(t.text) });
  }
}

function inlineText(tokens) {
  let s = "";
  for (const t of tokens || []) {
    if (t.type === "br") s += " ";
    else if (t.tokens) s += inlineText(t.tokens);
    else if (typeof t.text === "string") s += t.text;
  }
  return s.replace(/\s+/g, " ").trim();
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
// A block with every run in one status (same / ins / del).
function renderBlock(blk, status, d, nextId) {
  if (blk.kind === "table") return [renderTable(blk.token, status, d, nextId)];
  const runs = [makeRun(blk.text, status, d, nextId, runStyle(blk))];
  return [paragraphFor(blk, runs, d)];
}

// A modified block: word-level (or char-level for CJK) diff between old & new.
function renderModified(oldBlk, newBlk, d, nextId) {
  // Different structure kinds, tables or code: show as delete-then-insert.
  if (oldBlk.kind !== newBlk.kind || oldBlk.kind === "table" || oldBlk.kind === "code") {
    return [...renderBlock(oldBlk, "del", d, nextId), ...renderBlock(newBlk, "ins", d, nextId)];
  }
  const style = runStyle(newBlk);
  const cjk = isCJKHeavy(oldBlk.text) || isCJKHeavy(newBlk.text);
  const parts = cjk
    ? Diff.diffChars(oldBlk.text, newBlk.text)
    : Diff.diffWordsWithSpace(oldBlk.text, newBlk.text);
  const runs = [];
  for (const p of parts) {
    const status = p.added ? "ins" : p.removed ? "del" : "same";
    if (p.value) runs.push(makeRun(p.value, status, d, nextId, style));
  }
  if (!runs.length) runs.push(makeRun("", "same", d, nextId, style));
  return [paragraphFor(newBlk, runs, d)];
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

function runStyle(blk) {
  return blk.kind === "code" ? { font: "Consolas", size: 20 } : {};
}

function makeRun(text, status, d, nextId, style = {}) {
  if (status === "ins") {
    return new d.InsertedTextRun({ text, id: nextId(), author: AUTHOR, date: DATE, ...style });
  }
  if (status === "del") {
    return new d.DeletedTextRun({ text, id: nextId(), author: AUTHOR, date: DATE, ...style });
  }
  return new d.TextRun({ text, ...style });
}

function renderTable(token, status, d, nextId) {
  const cell = (c, header) =>
    new d.TableCell({
      width: { size: Math.floor(10000 / (token.header.length || 1)) / 100, type: d.WidthType.PERCENTAGE },
      shading: header ? { type: "clear", fill: "F2F2F2" } : undefined,
      children: [new d.Paragraph({ children: [makeRun(inlineText(c.tokens), status, d, nextId, header ? { bold: true } : {})] })],
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
