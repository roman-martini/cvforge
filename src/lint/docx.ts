import zlib from 'node:zlib';
import type { LintFinding, LintReport } from '../core/types.ts';
import { compareRecall, normalizeText, tokenize } from './text.ts';

/**
 * Lint del DOCX (ATS-070..075).
 *
 * El modo de falla que justifica todo este archivo es el peor posible: un DOCX
 * generado convirtiendo HTML (html-docx-js, @turbodocx/html-to-docx, cualquier
 * cosa basada en `altChunk`) se abre impecable en Word y todo parser headless
 * extrae CERO caracteres — el contenido vive en `word/afchunk.mht` codificado
 * en quoted-printable y sólo Word lo resuelve. El autor lo revisa, lo ve
 * perfecto, y el ATS recibe un documento vacío.
 *
 * Dos líneas de inspección de zip lo atrapan. De ahí que el DOCX se genere
 * nativo desde el ViewModel y se verifique acá.
 */

/* ========================================================================== *
 * Lector de ZIP mínimo (sin dependencias nuevas)
 * ========================================================================== */

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

/** Abre el .docx como zip y devuelve sus entradas descomprimidas. */
export function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();

  // El End Of Central Directory está al final, pero puede tener hasta 64 KB de
  // comentario detrás: se busca hacia atrás desde el final.
  let eocd = -1;
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === SIGNATURE_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo no es un ZIP válido: no se encontró el End Of Central Directory.');

  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (centralOffset === ZIP64_SENTINEL) {
    throw new Error('ZIP64 no soportado. Un .docx de un CV nunca debería necesitarlo: revisá qué lo generó.');
  }

  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== SIGNATURE_CENTRAL) break;

    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (compressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      throw new Error(`ZIP64 no soportado (entrada "${name}").`);
    }

    if (archive.readUInt32LE(localOffset) === SIGNATURE_LOCAL) {
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = archive.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) entries.set(name, Buffer.from(raw));
      else if (method === 8) entries.set(name, zlib.inflateRawSync(raw));
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/* ========================================================================== *
 * Extracción de texto de OOXML
 * ========================================================================== */

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Devuelve el texto del documento partido en párrafos, en orden. */
export function docxParagraphs(documentXml: string): string[] {
  const paragraphs: string[] = [];
  let current = '';
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<\/w:p>/g;

  let match = pattern.exec(documentXml);
  while (match) {
    if (match[1] !== undefined) current += decodeXml(match[1]);
    else if (match[0].startsWith('<w:tab')) current += ' ';
    else if (match[0].startsWith('<w:br')) current += ' ';
    else {
      paragraphs.push(current);
      current = '';
    }
    match = pattern.exec(documentXml);
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

export function docxText(documentXml: string): string {
  return docxParagraphs(documentXml).join('\n');
}

/* ========================================================================== *
 * Reglas
 * ========================================================================== */

const STANDARD_STYLES = new Set(
  [
    'Normal', 'NoSpacing', 'BodyText', 'Title', 'Subtitle',
    'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6',
    'ListBullet', 'ListBullet2', 'ListBullet3', 'ListNumber', 'ListParagraph',
    'Hyperlink', 'Strong', 'Emphasis', 'Caption', 'Quote', 'IntenseQuote',
  ].map((style) => style.toLowerCase()),
);

export type DocxLintOptions = {
  /** `cv.txt`: el mismo ground truth que usa el PDF. */
  plainText?: string;
  email?: string;
  phone?: string;
  /** Cuántos párrafos iniciales cuentan como "encabezado". */
  contactParagraphWindow?: number;
  /** Estilos propios del tema que sí están permitidos. */
  extraStyles?: string[];
};

export function lintDocx(docx: Buffer, options: DocxLintOptions = {}): LintReport {
  const findings: LintFinding[] = [];
  const { plainText, email, phone, contactParagraphWindow = 6, extraStyles = [] } = options;

  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(docx);
  } catch (error) {
    return {
      format: 'docx',
      findings: [
        {
          rule: 'ATS-070',
          severity: 'error',
          message: `No se pudo abrir el .docx como zip: ${(error as Error).message}`,
          where: 'DOCX',
          fix: 'Un .docx es un zip OPC. Si no abre, el archivo está corrupto o no es un DOCX.',
        },
      ],
      passed: false,
    };
  }

  const documentBuffer = entries.get('word/document.xml');
  if (!documentBuffer) {
    return {
      format: 'docx',
      findings: [
        {
          rule: 'ATS-070',
          severity: 'error',
          message: 'El paquete no contiene word/document.xml.',
          where: 'DOCX',
          fix: 'Generá el DOCX de forma nativa desde el ViewModel con `docx`, nunca convirtiendo el HTML.',
        },
      ],
      passed: false,
    };
  }

  const documentXml = documentBuffer.toString('utf8');
  const names = [...entries.keys()];

  /* ── ATS-070 — altChunk ───────────────────────────────────────────────── */
  const hasAltChunk = /<w:altChunk\b/.test(documentXml);
  const hasChunkPart = names.some((name) => /afchunk|\.mht$/i.test(name));
  if (hasAltChunk || hasChunkPart) {
    findings.push({
      rule: 'ATS-070',
      severity: 'error',
      message: `El documento usa altChunk${hasChunkPart ? ` (parte externa: ${names.filter((n) => /afchunk|\.mht$/i.test(n)).join(', ')})` : ''}. Todo parser headless extrae CERO caracteres: el contenido está en quoted-printable y sólo Microsoft Word lo resuelve. Vos lo abrís y lo ves perfecto; el ATS recibe un documento vacío.`,
      where: 'DOCX · word/document.xml',
      fix: 'Generá el DOCX nativo desde el ViewModel con `docx` (dolanmiu). El HTML nunca es la fuente intermedia: PDF, DOCX y TXT son hermanos del mismo ViewModel.',
    });
  }

  /* ── ATS-071 — hay runs de texto ──────────────────────────────────────── */
  const runCount = (documentXml.match(/<w:t(?:\s[^>]*)?>/g) ?? []).length;
  if (runCount === 0) {
    findings.push({
      rule: 'ATS-071',
      severity: 'error',
      message: 'No hay ni un solo <w:t> en word/document.xml: el documento no tiene texto extraíble.',
      where: 'DOCX · word/document.xml',
      fix: 'Es el síntoma directo de un DOCX derivado de HTML.',
    });
  }

  /* ── ATS-072 — estructuras que rompen el parseo ───────────────────────── */
  const structures: Array<{ pattern: RegExp; label: string; why: string }> = [
    { pattern: /<w:tbl\b/, label: 'tablas', why: 'varios ATS recorren las celdas por columna y devuelven empresas y fechas mezcladas' },
    { pattern: /<w:txbxContent\b|<v:textbox\b|<wps:txbx\b/, label: 'text boxes', why: 'su contenido queda fuera del flujo principal y muchos parsers ni lo miran' },
    { pattern: /<w:sdt\b/, label: 'content controls', why: 'el texto vive en una estructura que el parser tiene que entender antes de leerlo' },
    { pattern: /<w:headerReference\b|<w:footerReference\b/, label: 'headers/footers de sección', why: 'Greenhouse documenta el contacto en el header como causa de parseo fallido' },
  ];
  for (const structure of structures) {
    if (structure.pattern.test(documentXml)) {
      findings.push({
        rule: 'ATS-072',
        severity: 'error',
        message: `El documento usa ${structure.label}: ${structure.why}.`,
        where: 'DOCX · word/document.xml',
        fix: 'El DOCX es un artefacto de una columna, semántico y editable. No busca paridad visual con el PDF: eso está declarado por contrato.',
      });
    }
  }
  const headerParts = names.filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name));
  if (headerParts.length > 0) {
    findings.push({
      rule: 'ATS-072',
      severity: 'error',
      message: `El paquete trae partes de encabezado/pie: ${headerParts.join(', ')}.`,
      where: 'DOCX',
      fix: 'Todo el contenido va en el cuerpo del documento.',
    });
  }

  /* ── ATS-073 — estilos nombrados estándar ─────────────────────────────── */
  const allowed = new Set([...STANDARD_STYLES, ...extraStyles.map((style) => style.toLowerCase())]);
  const usedStyles = new Set<string>();
  const stylePattern = /<w:pStyle\s+w:val="([^"]+)"/g;
  let styleMatch = stylePattern.exec(documentXml);
  while (styleMatch) {
    usedStyles.add(styleMatch[1] ?? '');
    styleMatch = stylePattern.exec(documentXml);
  }
  const nonStandard = [...usedStyles].filter((style) => !allowed.has(style.toLowerCase()));
  if (nonStandard.length > 0) {
    findings.push({
      rule: 'ATS-073',
      severity: 'error',
      message: `Estilos no estándar en uso: ${nonStandard.join(', ')}. Los parsers de DOCX infieren la jerarquía por el nombre del estilo, no por el tamaño de la fuente.`,
      where: 'DOCX · word/document.xml',
      fix: 'Usá Heading 1/2/3, List Bullet y Normal. Si el tema necesita uno propio, declaralo en `extraStyles` y basalo en un estándar.',
    });
  }
  if (usedStyles.size === 0 && runCount > 0) {
    findings.push({
      rule: 'ATS-073',
      severity: 'error',
      message: 'Ningún párrafo declara <w:pStyle>: el documento es texto plano con formato directo y el parser no puede distinguir un heading de un bullet.',
      where: 'DOCX · word/document.xml',
      fix: 'Aplicá estilos nombrados a headings y bullets.',
    });
  }

  /* ── ATS-074 — contacto en los primeros párrafos ──────────────────────── */
  const paragraphs = docxParagraphs(documentXml).filter((paragraph) => paragraph.trim().length > 0);
  const head = paragraphs.slice(0, contactParagraphWindow).join('\n');
  if (email && !normalizeText(head).includes(normalizeText(email))) {
    findings.push({
      rule: 'ATS-074',
      severity: 'error',
      message: `El email no aparece en los primeros ${contactParagraphWindow} párrafos del DOCX.`,
      where: 'DOCX · cuerpo',
      fix: 'El bloque de contacto va primero en el cuerpo, nunca en un header de sección.',
    });
  }
  if (phone) {
    const digits = phone.replace(/\D+/g, '');
    if (digits.length >= 6 && !head.replace(/\D+/g, '').includes(digits)) {
      findings.push({
        rule: 'ATS-074',
        severity: 'warning',
        message: `El teléfono no aparece completo en los primeros ${contactParagraphWindow} párrafos del DOCX.`,
        where: 'DOCX · cuerpo',
        fix: 'Emitilo en el bloque de contacto, sin caracteres invisibles de por medio.',
      });
    }
  }

  /* ── ATS-075 — mismo recall que el PDF ────────────────────────────────── */
  if (plainText) {
    const extracted = docxText(documentXml);
    const recall = compareRecall(plainText, extracted);
    if (recall.missing.length > 0) {
      findings.push({
        rule: 'ATS-075',
        severity: 'error',
        message: `Faltan ${recall.missing.length} de ${recall.expected} tokens de cv.txt en el texto del DOCX (recall ${(recall.ratio * 100).toFixed(1)} %). Ausentes: ${recall.missing.slice(0, 25).join(', ')}${recall.missing.length > 25 ? ` … (+${recall.missing.length - 25} más)` : ''}`,
        where: 'DOCX · texto extraído',
        fix: 'PDF y DOCX salen del mismo ViewModel: cualquier diferencia es una sección que el renderer de DOCX no está emitiendo.',
      });
    }
    if (tokenize(extracted).length === 0) {
      findings.push({
        rule: 'ATS-075',
        severity: 'error',
        message: 'El texto extraído del DOCX está vacío.',
        where: 'DOCX · texto extraído',
        fix: 'Ver ATS-070: es el síntoma canónico de altChunk.',
      });
    }
  }

  return { format: 'docx', findings, passed: findings.every((f) => f.severity !== 'error') };
}
