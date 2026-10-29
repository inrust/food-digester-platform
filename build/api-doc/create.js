import fs from 'node:fs';
import path from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImportedXmlComponent,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: node create.js /absolute/path/output.docx');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const MD_PATH = '/Users/anray/Documents/project/hiddenjoyacom/food-digester-platform/build/api-doc/merged.md';
const DOC_TITLE = 'Bio-Nexa 设备平台统一 API 文档';

const palette = {
  dark: '263238',
  primary: '1F4E5F',
  secondary: '37474F',
  light: '78909C',
  border: 'C9D6DB',
  fill: 'E8F0F2',
  codeFill: 'F5F4EF',
  codeInline: 'F0EDE6',
};

const bodyFont = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', cs: 'Times New Roman', eastAsia: 'SimSun' };
const headFont = { ascii: 'Arial', hAnsi: 'Arial', cs: 'Arial', eastAsia: 'Microsoft YaHei' };
const codeFont = { ascii: 'Consolas', hAnsi: 'Consolas', cs: 'Consolas', eastAsia: 'SimSun' };

const CONTENT_WIDTH = 9026; // A4, 1440 twip margins

const run = (text, options = {}) => new TextRun({ text, font: bodyFont, size: 21, ...options });
const para = (children, options = {}) =>
  new Paragraph({
    spacing: { after: 120, line: 320 },
    ...options,
    children: Array.isArray(children) ? children : [children],
  });

// ---------- inline parsing: **bold** and `code` ----------
function inlineRuns(text, options = {}) {
  const runs = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(run(text.slice(last, m.index), options));
    const tok = m[0];
    if (tok.startsWith('**')) {
      runs.push(run(tok.slice(2, -2), { ...options, bold: true }));
    } else {
      runs.push(
        run(tok.slice(1, -1), {
          ...options,
          font: codeFont,
          shading: { type: ShadingType.CLEAR, fill: options.codeFill || palette.codeInline },
        }),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(run(text.slice(last), options));
  if (runs.length === 0) runs.push(run('', options));
  return runs;
}
const stripInline = (text) => text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1');

// ---------- markdown block parsing ----------
const lines = fs.readFileSync(MD_PATH, 'utf-8').split('\n');
const blocks = [];
let i = 0;
const isTableLine = (s) => /^\s*\|.*\|\s*$/.test(s);
const isTableSep = (s) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s) && s.includes('-');
const isCjkChar = (ch) => ch !== undefined && ch.codePointAt(0) > 0x2e7f;
const cjkEnd = (s) => isCjkChar(s[s.length - 1]);
const cjkStart = (s) => isCjkChar(s[0]);

while (i < lines.length) {
  const line = lines[i];
  if (!line.trim()) {
    i += 1;
    continue;
  }

  const fence = line.match(/^```(\w*)\s*$/);
  if (fence) {
    const buf = [];
    i += 1;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    i += 1;
    blocks.push({ type: 'code', lang: fence[1] || '', lines: buf });
    continue;
  }

  const h = line.match(/^(#{1,3})\s+(.*)$/);
  if (h) {
    blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
    i += 1;
    continue;
  }

  if (isTableLine(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
    const rows = [];
    const parseRow = (s) =>
      s
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
    rows.push(parseRow(line));
    i += 2; // skip separator
    while (
      i < lines.length &&
      isTableLine(lines[i]) &&
      !isTableSep(lines[i]) &&
      !(i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      rows.push(parseRow(lines[i]));
      i += 1;
    }
    blocks.push({ type: 'table', rows });
    continue;
  }

  const bullet = line.match(/^[-*]\s+(.*)$/);
  if (bullet) {
    const items = [];
    while (i < lines.length) {
      const b = lines[i].match(/^[-*]\s+(.*)$/);
      if (!b) break;
      items.push(b[1]);
      i += 1;
    }
    blocks.push({ type: 'bullets', items });
    continue;
  }

  const ordered = line.match(/^\d+[.、]\s+(.*)$/);
  if (ordered) {
    const items = [];
    while (i < lines.length) {
      const o = lines[i].match(/^\d+[.、]\s+(.*)$/);
      if (!o) break;
      items.push(o[1]);
      i += 1;
    }
    blocks.push({ type: 'ordered', items });
    continue;
  }

  // paragraph: join consecutive plain lines
  const buf = [line];
  i += 1;
  while (i < lines.length && lines[i].trim()) {
    const nxt = lines[i];
    if (
      /^(#{1,3})\s/.test(nxt) ||
      /^```/.test(nxt) ||
      isTableLine(nxt) ||
      /^[-*]\s/.test(nxt) ||
      /^\d+[.、]\s/.test(nxt)
    )
      break;
    buf.push(nxt);
    i += 1;
  }
  let text = buf[0];
  for (let k = 1; k < buf.length; k += 1) {
    text += cjkEnd(text) || cjkStart(buf[k]) ? buf[k] : ' ' + buf[k];
  }
  blocks.push({ type: 'para', text });
}

// ---------- renderers ----------
const tocEntries = [];
const children = [];
const numberingConfig = [
  {
    reference: 'bullets',
    levels: [
      {
        level: 0,
        format: LevelFormat.BULLET,
        text: '•',
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 580, hanging: 300 } } },
      },
    ],
  },
];
let orderedCount = 0;
let contentUnits = 0;
const estPage = () => 3 + Math.floor(contentUnits / 36);
const plainPara = (text) => {
  contentUnits += Math.max(1, Math.ceil(text.length / 44));
  return para(inlineRuns(text), { indent: { firstLine: 420 } });
};

function renderTable(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const disp = (s) => {
    let w = 0;
    for (const ch of stripInline(s)) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
    return w;
  };
  const raw = Array.from({ length: cols }, (_, c) => Math.max(4, ...rows.map((r) => Math.min(disp(r[c] || ''), 44))));
  const sum = raw.reduce((a, b) => a + b, 0);
  const widths = raw.map((w) => Math.max(640, Math.floor((w / sum) * CONTENT_WIDTH)));
  widths[cols - 1] += CONTENT_WIDTH - widths.reduce((a, b) => a + b, 0);
  const cellBorder = { style: BorderStyle.SINGLE, size: 2, color: palette.border };
  const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
  const mkCell = (text, c, isHeader) =>
    new TableCell({
      width: { size: widths[c], type: WidthType.DXA },
      margins: { top: 70, bottom: 70, left: 110, right: 110 },
      borders,
      shading: isHeader ? { type: ShadingType.CLEAR, fill: palette.fill } : undefined,
      children: [
        para(inlineRuns(text, { size: 18, bold: isHeader, codeFill: 'FFFFFF' }), { spacing: { after: 0, line: 260 } }),
      ],
    });
  contentUnits += rows.length * 0.7;
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map(
      (r, ri) =>
        new TableRow({
          tableHeader: ri === 0,
          children: Array.from({ length: cols }, (_, c) => mkCell(r[c] || '', c, ri === 0)),
        }),
    ),
  });
}

const spacerAfterTable = () => para(run('', { size: 8 }), { spacing: { after: 60, line: 120 } });

for (const b of blocks) {
  if (b.type === 'heading') {
    const entry = { title: stripInline(b.text), level: b.level, page: estPage() };
    tocEntries.push(entry);
    const opts = {
      1: { size: 32, color: palette.primary, spacing: { before: 120, after: 300 }, pageBreakBefore: true },
      2: { size: 26, color: palette.dark, spacing: { before: 320, after: 140 } },
      3: { size: 23, color: palette.secondary, spacing: { before: 240, after: 120 } },
    }[b.level];
    children.push(
      para(inlineRuns(b.text, { font: headFont, bold: true, size: opts.size, color: opts.color }), {
        heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][b.level - 1],
        spacing: opts.spacing,
        pageBreakBefore: opts.pageBreakBefore || false,
      }),
    );
  } else if (b.type === 'para') {
    children.push(plainPara(b.text));
  } else if (b.type === 'bullets') {
    for (const item of b.items) {
      contentUnits += Math.max(1, Math.ceil(item.length / 46));
      children.push(para(inlineRuns(item), { numbering: { reference: 'bullets', level: 0 }, spacing: { after: 80 } }));
    }
  } else if (b.type === 'ordered') {
    const ref = `ordered-${orderedCount}`;
    orderedCount += 1;
    numberingConfig.push({
      reference: ref,
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 580, hanging: 300 } } },
        },
      ],
    });
    for (const item of b.items) {
      contentUnits += Math.max(1, Math.ceil(item.length / 46));
      children.push(para(inlineRuns(item), { numbering: { reference: ref, level: 0 }, spacing: { after: 80 } }));
    }
  } else if (b.type === 'code') {
    contentUnits += b.lines.length * 0.55;
    for (const cl of b.lines) {
      children.push(
        para(new TextRun({ text: cl.length ? cl : ' ', font: codeFont, size: 17 }), {
          spacing: { after: 0, line: 230 },
          indent: { left: 240, right: 240 },
          shading: { type: ShadingType.CLEAR, fill: palette.codeFill },
        }),
      );
    }
    children.push(spacerAfterTable());
  } else if (b.type === 'table') {
    children.push(renderTable(b.rows));
    children.push(spacerAfterTable());
  }
}

// ---------- TOC ----------
const xmlEscape = (v) =>
  String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const toc = (entries) => {
  const cached = entries
    .map(({ title, level, page }) => {
      const indent = Math.max(0, level - 1) * 360;
      return `<w:p><w:pPr><w:pStyle w:val="TOC${level}"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9000"/></w:tabs><w:ind w:left="${indent}"/></w:pPr><w:r><w:t>${xmlEscape(title)}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${page}</w:t></w:r></w:p>`;
    })
    .join('');
  return ImportedXmlComponent.fromXmlString(`<w:sdt xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:sdtPr><w:alias w:val="目录"/></w:sdtPr>
    <w:sdtContent>
      <w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/><w:instrText xml:space="preserve"> TOC \\o &quot;1-3&quot; \\h \\z \\u </w:instrText><w:fldChar w:fldCharType="separate"/></w:r></w:p>
      ${cached}
      <w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    </w:sdtContent>
  </w:sdt>`).root[0];
};

// ---------- cover ----------
const coverChildren = [
  para(run('', { size: 8 }), { spacing: { before: 4200, after: 0 } }),
  para(run('Bio-Nexa 设备平台', { font: headFont, bold: true, size: 56, color: palette.primary }), {
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
  }),
  para(run('统一 API 文档', { font: headFont, bold: true, size: 56, color: palette.primary }), {
    alignment: AlignmentType.CENTER,
    spacing: { after: 480 },
  }),
  para(run('', { size: 8 }), {
    alignment: AlignmentType.CENTER,
    spacing: { after: 480 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: palette.primary, space: 1 } },
    indent: { left: 3000, right: 3000 },
  }),
  para(
    run('设备接入（Onboarding） · 设备 REST API · MQTT 联调说明', {
      font: headFont,
      size: 24,
      color: palette.secondary,
    }),
    { alignment: AlignmentType.CENTER, spacing: { after: 200 } },
  ),
  para(run('版本基线：2026-10-01', { font: headFont, size: 22, color: palette.light }), {
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
  }),
  para(
    run('整合自 device-api / onboard-api / iot 三份设备侧接口文档', { font: headFont, size: 20, color: palette.light }),
    { alignment: AlignmentType.CENTER },
  ),
];

const tocPage = [
  para(run('目　录', { font: headFont, bold: true, size: 32, color: palette.primary }), {
    spacing: { before: 240, after: 240 },
  }),
  toc(tocEntries),
];

const doc = new Document({
  features: { updateFields: true },
  numbering: { config: numberingConfig },
  styles: {
    paragraphStyles: [1, 2, 3].map((lvl) => ({
      id: `TOC${lvl}`,
      name: `toc ${lvl}`,
      run: { font: bodyFont, size: lvl === 1 ? 22 : 20, bold: lvl === 1, color: palette.dark },
      paragraph: { spacing: { after: 60, line: 300 } },
    })),
  },
  sections: [
    {
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children: coverChildren,
    },
    {
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: {
        default: new Header({
          children: [
            para(run(DOC_TITLE, { font: headFont, size: 18, color: palette.light }), {
              alignment: AlignmentType.CENTER,
              spacing: { after: 60 },
              border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: palette.border, space: 4 } },
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            para(new TextRun({ children: [PageNumber.CURRENT], font: headFont, size: 18, color: palette.light }), {
              alignment: AlignmentType.CENTER,
            }),
          ],
        }),
      },
      children: [...tocPage, ...children],
    },
  ],
});

fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
console.log(
  `blocks=${blocks.length} toc=${tocEntries.length} tables=${blocks.filter((b) => b.type === 'table').length} code=${blocks.filter((b) => b.type === 'code').length}`,
);
