import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
  UnderlineType,
  convertMillimetersToTwip,
} from 'docx';
import type { ISectionOptions, IStylesOptions, ParagraphChild } from 'docx';
import type {
  RenderOptions,
  RenderResult,
  Renderer,
  ViewModel,
  VMEntry,
  VMSection,
} from '../core/types.ts';

/**
 * Renderer DOCX nativo (OOXML), construido desde el ViewModel con la librería
 * `docx`. NUNCA desde el HTML: cualquier conversión HTML→DOCX (html-docx-js,
 * altChunk) produce un archivo del que todo parser headless extrae CERO
 * caracteres. El autor lo abre en Word y lo ve impecable; el ATS recibe un
 * documento vacío.
 *
 * ESTE ARTEFACTO NO BUSCA PARIDAD VISUAL CON EL PDF, y eso es una decisión de
 * contrato, no una limitación pendiente de arreglar. El PDF es el documento
 * compuesto; el DOCX es una versión de una sola columna, semántica y editable,
 * pensada para que un reclutador la abra en Word, la copie o la anote. Las
 * diferencias de salto de página, de interletraje y de tipografía entre ambos
 * son esperables.
 *
 * Restricciones que hacen que el DOCX sea parseable (§4.4 del dossier):
 *   - Estilos NOMBRADOS estándar (Normal, Heading1/2/3, ListBullet): son la
 *     única señal con la que los parsers segmentan el documento.
 *   - Sin tablas, sin text boxes, sin headers/footers de sección, sin content
 *     controls, sin altChunk. Las fechas se alinean con un TAB STOP a la
 *     derecha, que es como se hace en Word.
 *   - Se declara la familia PROPIETARIA que el Word del reclutador sí tiene
 *     licenciada (Calibri / Cambria), mientras el PDF embebe las libres
 *     métricamente compatibles (Carlito / Caladea). Misma métrica, cero
 *     problema de licencia, y nada que redistribuir en este repo.
 */

/** Fuentes del sistema Windows/Office; sus equivalentes libres van en el PDF. */
const BODY_FONT = 'Calibri';
const DISPLAY_FONT = 'Cambria';

const INK = '16181D';
const INK_MUTED = '4A5058';
const RULE = '8A9199';
const ACCENT = '1F3A5F';

const INLINE_SEPARATOR = ' · ';

/** 1 mm = 56.7 twips. Valores canónicos del papel, no redondeos del conversor. */
const PAPER = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
} as const;

/** Mismos márgenes que el CSS de impresión: 14 mm vertical, 18 mm horizontal. */
const MARGIN_Y_MM = 14;
const MARGIN_X_MM = 18;

/** Escalones del fit-loop: sólo afectan al ritmo vertical y al cuerpo. */
const DENSITY_SCALE = {
  comfortable: 1.1,
  normal: 1,
  dense: 0.85,
  ultra: 0.72,
} as const;

type Density = ViewModel['density'];

type Typography = {
  /** Tamaños en medios puntos, que es la unidad de OOXML. */
  body: number;
  name: number;
  section: number;
  meta: number;
  micro: number;
  /** Interlineado en 240-avos de línea, con lineRule automático. */
  line: number;
};

function typography(density: Density): Typography {
  const compact = density === 'dense' || density === 'ultra';
  return {
    body: compact ? 20 : 21,
    name: 42,
    section: 22,
    meta: 18,
    micro: 17,
    line: density === 'ultra' ? 298 : 317,
  };
}

function sanitize(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function joinNonEmpty(parts: Array<string | undefined>, separator: string): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(separator);
}

function buildStyles(t: Typography, space: (mm: number) => number): IStylesOptions {
  return {
    default: {
      document: {
        run: { font: BODY_FONT, size: t.body, color: INK },
        paragraph: {
          alignment: AlignmentType.LEFT,
          spacing: { line: t.line, lineRule: LineRuleType.AUTO, after: space(1.6) },
        },
      },
      heading1: {
        run: { font: DISPLAY_FONT, size: t.name, bold: true, color: ACCENT },
        paragraph: {
          keepNext: true,
          spacing: { before: 0, after: space(1.5), line: 240, lineRule: LineRuleType.AUTO },
        },
      },
      heading2: {
        run: { font: DISPLAY_FONT, size: t.section, bold: true, color: ACCENT },
        paragraph: {
          keepNext: true,
          spacing: { before: space(5), after: space(2), line: 276, lineRule: LineRuleType.AUTO },
          // Filete de 0.75pt (size va en octavos de punto), el mismo del PDF.
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 2 } },
        },
      },
      heading3: {
        run: { font: BODY_FONT, size: t.body, bold: true, color: INK },
        paragraph: {
          keepNext: true,
          keepLines: true,
          spacing: { before: space(3.5), after: 0, line: t.line, lineRule: LineRuleType.AUTO },
        },
      },
      hyperlink: {
        run: { color: ACCENT, underline: { type: UnderlineType.SINGLE } },
      },
    },
    paragraphStyles: [
      {
        // "List Bullet" es un estilo built-in de Word: los parsers lo reconocen
        // como lista aunque ignoren por completo la numeración.
        id: 'ListBullet',
        name: 'List Bullet',
        basedOn: 'Normal',
        next: 'ListBullet',
        quickFormat: true,
        paragraph: {
          spacing: { before: 0, after: space(0.8), line: t.line, lineRule: LineRuleType.AUTO },
          indent: { left: convertMillimetersToTwip(5), hanging: convertMillimetersToTwip(3) },
        },
      },
    ],
  };
}

function metaRun(text: string, t: Typography): TextRun {
  return new TextRun({ text, size: t.meta, color: INK_MUTED });
}

/** Fecha pegada al margen derecho por tab stop, nunca por una tabla de una fila. */
function tabbedDate(dateRange: string, t: Typography): ParagraphChild[] {
  if (!dateRange) return [];
  return [
    new TextRun({ children: [new Tab(), sanitize(dateRange)], bold: false, size: t.meta, color: INK_MUTED }),
  ];
}

function entryParagraphs(entry: VMEntry, t: Typography, tabStop: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  paragraphs.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_3,
      tabStops: [{ type: TabStopType.RIGHT, position: tabStop }],
      children: [new TextRun({ text: sanitize(entry.title) }), ...tabbedDate(entry.dateRange, t)],
    }),
  );

  const subtitle = joinNonEmpty([entry.subtitle, entry.meta], INLINE_SEPARATOR);
  if (subtitle) {
    paragraphs.push(
      new Paragraph({
        keepNext: true,
        spacing: { after: 0 },
        children: [new TextRun({ text: sanitize(subtitle), color: INK_MUTED })],
      }),
    );
  }

  for (const position of entry.extraPositions) {
    paragraphs.push(
      new Paragraph({
        keepNext: true,
        spacing: { after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: tabStop }],
        children: [
          new TextRun({ text: sanitize(position.title), italics: true, size: t.meta }),
          ...tabbedDate(position.dateRange, t),
        ],
      }),
    );
  }

  if (entry.summary) {
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: sanitize(entry.summary) })] }));
  }

  for (const bullet of entry.bullets) {
    paragraphs.push(
      new Paragraph({
        style: 'ListBullet',
        numbering: { reference: 'cv-bullets', level: 0 },
        children: [new TextRun({ text: sanitize(bullet) })],
      }),
    );
  }

  return paragraphs;
}

function sectionParagraphs(section: VMSection, t: Typography, tabStop: number): Paragraph[] {
  switch (section.kind) {
    case 'entries':
      return section.entries.flatMap((entry) => entryParagraphs(entry, t, tabStop));
    case 'skills':
      return section.groups.map(
        (group) =>
          new Paragraph({
            spacing: { after: 0 },
            children: [
              new TextRun({ text: `${sanitize(group.label)}: `, bold: true }),
              new TextRun({ text: sanitize(group.items.join(', ')) }),
            ],
          }),
      );
    case 'inline-list':
      return [
        new Paragraph({
          children: [new TextRun({ text: sanitize(section.items.join(INLINE_SEPARATOR)) })],
        }),
      ];
    case 'text':
      return section.text
        ? [new Paragraph({ children: [new TextRun({ text: sanitize(section.text) })] })]
        : [];
  }
}

function hasContent(section: VMSection): boolean {
  return (
    section.entries.length > 0 ||
    section.groups.length > 0 ||
    section.items.length > 0 ||
    Boolean(section.text)
  );
}

function headerParagraphs(vm: ViewModel, t: Typography): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: sanitize(vm.header.name) })],
    }),
  ];

  if (vm.header.headline) {
    paragraphs.push(
      new Paragraph({
        spacing: { after: 0 },
        children: [new TextRun({ text: sanitize(vm.header.headline), size: t.section })],
      }),
    );
  }

  // El contacto va en los primeros párrafos del cuerpo, nunca en un header de
  // sección: ahí queda fuera de lo que el parser recorre (ATS-074).
  if (vm.header.contactLines.length > 0) {
    paragraphs.push(
      new Paragraph({
        spacing: { after: 0 },
        children: [metaRun(sanitize(vm.header.contactLines.join(INLINE_SEPARATOR)), t)],
      }),
    );
  }

  if (vm.header.links.length > 0) {
    const children: ParagraphChild[] = [];
    for (const item of vm.header.links) {
      if (children.length > 0) children.push(metaRun(INLINE_SEPARATOR, t));
      children.push(
        new ExternalHyperlink({
          link: item.href,
          // El texto visible es la URL completa, no la palabra "LinkedIn" (ATS-060).
          children: [new TextRun({ text: sanitize(item.text), style: 'Hyperlink', size: t.meta })],
        }),
      );
    }
    paragraphs.push(new Paragraph({ children }));
  }

  return paragraphs;
}

export function buildDocxDocument(vm: ViewModel, opts?: RenderOptions): Document {
  const density = opts?.density ?? vm.density;
  const t = typography(density);
  const scale = DENSITY_SCALE[density];
  const space = (mm: number) => Math.round(convertMillimetersToTwip(mm) * scale);

  const paper = PAPER[vm.paper];
  const marginX = convertMillimetersToTwip(MARGIN_X_MM);
  const marginY = convertMillimetersToTwip(MARGIN_Y_MM);
  const tabStop = paper.width - marginX * 2;

  const children: Paragraph[] = [...headerParagraphs(vm, t)];

  for (const section of vm.sections) {
    if (!hasContent(section)) continue;
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: sanitize(section.heading) })],
      }),
    );
    children.push(...sectionParagraphs(section, t, tabStop));
  }

  if (vm.consentClause) {
    children.push(
      new Paragraph({
        spacing: { before: space(5) },
        children: [
          new TextRun({ text: sanitize(vm.consentClause), size: t.micro, color: INK_MUTED }),
        ],
      }),
    );
  }

  const section: ISectionOptions = {
    properties: {
      page: {
        size: { width: paper.width, height: paper.height },
        margin: { top: marginY, bottom: marginY, left: marginX, right: marginX },
      },
    },
    children,
  };

  return new Document({
    // `/Title` neutro y determinista: nunca la empresa objetivo ni la variante.
    title: vm.documentTitle,
    subject: vm.meta.subject,
    creator: vm.meta.author,
    lastModifiedBy: vm.meta.author,
    keywords: vm.meta.keywords.join(', '),
    description: vm.meta.subject,
    styles: buildStyles(t, space),
    numbering: {
      config: [
        {
          reference: 'cv-bullets',
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: {
                    left: convertMillimetersToTwip(5),
                    hanging: convertMillimetersToTwip(3),
                  },
                },
              },
            },
          ],
        },
      ],
    },
    sections: [section],
  });
}

export async function renderDocx(vm: ViewModel, opts?: RenderOptions): Promise<Buffer> {
  return Packer.toBuffer(buildDocxDocument(vm, opts));
}

export const docxRenderer: Renderer = {
  format: 'docx',
  extension: 'docx',
  async render(vm: ViewModel, opts?: RenderOptions): Promise<RenderResult> {
    return { format: 'docx', content: await renderDocx(vm, opts), extension: 'docx' };
  },
};
