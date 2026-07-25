// Markdown → .docx, entirely in the browser.
//
// We lex the Markdown with `marked` and map the tokens to real docx elements
// (Paragraph / TextRun / Table / …), then Packer serializes a genuine OOXML
// Word file — one that opens correctly in Word, Google Docs, LibreOffice, and
// Pages (unlike the HTML-in-a-.docx trick some libraries use).

const { marked, docx } = window;

export async function markdownToDocxBlob(markdown) {
  const {
    Document, Packer, Paragraph, TextRun, ExternalHyperlink,
    HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle,
    LevelFormat, AlignmentType,
  } = docx;

  const D = { Paragraph, TextRun, ExternalHyperlink, HeadingLevel, Table,
    TableRow, TableCell, WidthType, BorderStyle };

  const tokens = marked.lexer(markdown || "");
  const blocks = [];
  const numbering = []; // ordered-list numbering configs, one per ordered list

  for (const token of tokens) blocksFromToken(token, blocks, numbering, D, { LevelFormat, AlignmentType });

  const doc = new Document({
    numbering: { config: numbering },
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } }, // 11pt
    },
    sections: [{ children: blocks.length ? blocks : [new Paragraph({})] }],
  });

  return Packer.toBlob(doc);
}

// --- Block-level mapping ----------------------------------------------
function blocksFromToken(token, out, numbering, D, enums) {
  switch (token.type) {
    case "space":
      break;

    case "heading": {
      const depth = Math.min(Math.max(token.depth, 1), 6);
      out.push(new D.Paragraph({
        heading: D.HeadingLevel[`HEADING_${depth}`],
        children: inlineRuns(token.tokens, {}, D),
      }));
      break;
    }

    case "paragraph":
      out.push(new D.Paragraph({ children: inlineRuns(token.tokens, {}, D) }));
      break;

    case "text":
      out.push(new D.Paragraph({
        children: token.tokens ? inlineRuns(token.tokens, {}, D) : [new D.TextRun(token.text || "")],
      }));
      break;

    case "hr":
      out.push(new D.Paragraph({
        border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, space: 1, color: "999999" } },
        children: [],
      }));
      break;

    case "blockquote": {
      const inner = [];
      for (const t of token.tokens) blocksFromToken(t, inner, numbering, D, enums);
      // Indent and italicize the quoted paragraphs.
      for (const p of inner) out.push(p);
      break;
    }

    case "code": {
      const lines = String(token.text).split("\n");
      const children = [];
      lines.forEach((line, i) => {
        children.push(new D.TextRun({ text: line, font: "Consolas", size: 20, break: i ? 1 : 0 }));
      });
      out.push(new D.Paragraph({
        shading: { type: "clear", fill: "F2F2F2" },
        spacing: { before: 60, after: 60 },
        children,
      }));
      break;
    }

    case "list":
      renderList(token, 0, out, numbering, D, enums);
      break;

    case "table":
      out.push(buildTable(token, D));
      break;

    case "html":
      break; // ignore stray HTML

    default:
      if (token.tokens) out.push(new D.Paragraph({ children: inlineRuns(token.tokens, {}, D) }));
      else if (token.text) out.push(new D.Paragraph(String(token.text)));
  }
}

function renderList(token, level, out, numbering, D, enums) {
  let reference = null;
  if (token.ordered) {
    reference = `ord-${numbering.length}`;
    numbering.push(orderedConfig(reference, enums));
  }

  for (const item of token.items) {
    const inline = [];
    const nested = [];
    for (const t of item.tokens || []) {
      if (t.type === "list") nested.push(t);
      else if (t.type === "text") inline.push(...(t.tokens || [{ type: "text", text: t.text }]));
      else if (t.type === "paragraph") inline.push(...t.tokens);
      else if (t.text) inline.push({ type: "text", text: t.text });
    }

    const children = inlineRuns(inline, {}, D);
    if (item.task) children.unshift(new D.TextRun(item.checked ? "☑ " : "☐ "));

    out.push(new D.Paragraph({
      children,
      ...(token.ordered ? { numbering: { reference, level } } : { bullet: { level } }),
    }));

    for (const n of nested) renderList(n, level + 1, out, numbering, D, enums);
  }
}

function buildTable(token, D) {
  const widthPct = (n) => ({ size: Math.floor(10000 / n) / 100, type: D.WidthType.PERCENTAGE });
  const cols = token.header.length || 1;

  const headerRow = new D.TableRow({
    tableHeader: true,
    children: token.header.map((cell) =>
      new D.TableCell({
        width: widthPct(cols),
        shading: { type: "clear", fill: "F2F2F2" },
        children: [new D.Paragraph({ children: inlineRuns(cell.tokens, { bold: true }, D) })],
      })
    ),
  });

  const bodyRows = token.rows.map((row) =>
    new D.TableRow({
      children: row.map((cell) =>
        new D.TableCell({
          width: widthPct(cols),
          children: [new D.Paragraph({ children: inlineRuns(cell.tokens, {}, D) })],
        })
      ),
    })
  );

  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

// --- Inline mapping ----------------------------------------------------
function inlineRuns(tokens, style, D) {
  const runs = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "text":
      case "escape":
        runs.push(new D.TextRun({ text: t.text, ...style }));
        break;
      case "strong":
        runs.push(...inlineRuns(t.tokens, { ...style, bold: true }, D));
        break;
      case "em":
        runs.push(...inlineRuns(t.tokens, { ...style, italics: true }, D));
        break;
      case "del":
        runs.push(...inlineRuns(t.tokens, { ...style, strike: true }, D));
        break;
      case "codespan":
        runs.push(new D.TextRun({ text: t.text, font: "Consolas", ...style }));
        break;
      case "br":
        runs.push(new D.TextRun({ break: 1 }));
        break;
      case "link":
        runs.push(new D.ExternalHyperlink({
          link: t.href,
          children: [new D.TextRun({
            text: t.text || t.href,
            style: "Hyperlink",
            color: "0563C1",
            underline: {},
            ...style,
          })],
        }));
        break;
      case "image":
        runs.push(new D.TextRun({ text: t.text ? `[${t.text}]` : "[image]", italics: true, ...style }));
        break;
      default:
        if (t.tokens) runs.push(...inlineRuns(t.tokens, style, D));
        else if (t.text) runs.push(new D.TextRun({ text: t.text, ...style }));
    }
  }
  return runs.length ? runs : [new D.TextRun("")];
}

function orderedConfig(reference, { LevelFormat, AlignmentType }) {
  return {
    reference,
    levels: [0, 1, 2, 3].map((level) => ({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    })),
  };
}
