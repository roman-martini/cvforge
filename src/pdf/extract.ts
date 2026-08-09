import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Extracción dual del texto de un PDF.
 *
 * Los extractores reales de los ATS se dividen en dos familias que devuelven
 * resultados OPUESTOS para el mismo archivo:
 *
 *   - orden del content stream — PDFBox con `setSortByPosition(false)` (su
 *     default), pypdf, PyMuPDF por defecto;
 *   - orden geométrico y-luego-x — `pdftotext` sin flags, PDFBox con
 *     `sortByPosition(true)`, PyMuPDF con `sort=True`.
 *
 * No hay forma de saber cuál usa el ATS de turno, así que el CV tiene que
 * leerse igual en los dos. Comparar ambos órdenes es un único test que detecta
 * de una sola vez floats, layouts de dos columnas, `position: fixed`,
 * margin-boxes de `@page`, `order` y los `*-reverse` de flex.
 */

/** Dos items cuya baseline difiere menos que esto pertenecen a la misma línea. */
const LINE_TOLERANCE_PT = 2;

/** Fracción del alto de fuente a partir de la cual un hueco horizontal es un espacio. */
const SPACE_GAP_RATIO = 0.25;

export type TextFragment = {
  /** 1-based, como las páginas del PDF. */
  page: number;
  text: string;
  /** `transform[4]`: x de la baseline en espacio de usuario. */
  x: number;
  /** `transform[5]`: y de la baseline; crece hacia arriba. */
  y: number;
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
};

export type DualExtraction = {
  /** Texto en el orden natural del array `items[]`: el del content stream. */
  stream: string;
  /** Texto reconstruido ordenando por (-y, x): el orden geométrico. */
  sorted: string;
  /** Texto por página, en orden geométrico. Índice 0 = página 1. */
  pages: string[];
  pagesStream: string[];
  pagesSorted: string[];
  /** Las mismas cadenas, ya partidas en líneas: base de la regla de proximidad. */
  streamLines: string[];
  sortedLines: string[];
  fragments: TextFragment[];
  pageCount: number;
};

type PdfJsTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
};

let cachedStandardFontDataUrl: string | undefined;

/**
 * pdf.js valida que la URL de fuentes estándar termine en barra y sea una URL,
 * no una ruta de Windows: `path.join` acá produciría `...\standard_fonts\` y
 * la librería lo rechaza con "Invalid factory url".
 */
function standardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  cachedStandardFontDataUrl = `${pathToFileURL(path.join(root, 'standard_fonts')).href}/`;
  return cachedStandardFontDataUrl;
}

/**
 * `String.prototype.trim` borra U+00A0 y U+FEFF junto con los espacios normales
 * y esos codepoints son justamente lo que buscan las reglas ATS-054/056.
 */
function trimAscii(value: string): string {
  return value.replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '');
}

function isTextItem(item: unknown): item is PdfJsTextItem {
  return typeof item === 'object' && item !== null && typeof (item as { str?: unknown }).str === 'string';
}

async function readFragments(data: Uint8Array): Promise<{ fragments: TextFragment[]; pageCount: number }> {
  const task = pdfjs.getDocument({
    data,
    standardFontDataUrl: standardFontDataUrl(),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const fragments: TextFragment[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        const transform = item.transform;
        fragments.push({
          page: pageNumber,
          text: item.str,
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          width: item.width,
          height: item.height,
          fontName: item.fontName,
          hasEOL: item.hasEOL,
        });
      }
      page.cleanup();
    }
    return { fragments, pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
}

/** Une fragmentos de una misma línea insertando el separador que el PDF no trae. */
function joinLine(fragments: TextFragment[]): string {
  let line = '';
  let previous: TextFragment | undefined;
  for (const fragment of fragments) {
    if (previous && fragment.text.length > 0 && line.length > 0) {
      const gap = fragment.x - (previous.x + previous.width);
      const reference = previous.height || fragment.height || 10;
      const needsSpace =
        gap > reference * SPACE_GAP_RATIO &&
        !/[ \t]$/.test(line) &&
        !/^[ \t]/.test(fragment.text);
      if (needsSpace) line += ' ';
    }
    line += fragment.text;
    previous = fragment;
  }
  return line;
}

/**
 * Orden del content stream: se respeta el array tal cual viene y sólo se corta
 * la línea cuando pdf.js marca fin de línea o cuando la baseline salta. Es lo
 * que hace PDFBox sin `sortByPosition`, y es donde un `float:right` adelanta la
 * fecha o un `position:relative` empuja la entrada al final del documento.
 */
function linesInStreamOrder(fragments: TextFragment[]): string[] {
  const lines: string[] = [];
  let current: TextFragment[] = [];
  let lineY: number | undefined;
  let linePage: number | undefined;

  const flush = () => {
    if (current.length === 0) return;
    const text = trimAscii(joinLine(current));
    if (text.length > 0) lines.push(text);
    current = [];
  };

  for (const fragment of fragments) {
    const pageChanged = linePage !== undefined && fragment.page !== linePage;
    const jumped = lineY !== undefined && Math.abs(fragment.y - lineY) > LINE_TOLERANCE_PT;
    if (pageChanged || jumped) {
      flush();
      lineY = undefined;
    }
    if (lineY === undefined) lineY = fragment.y;
    linePage = fragment.page;
    current.push(fragment);
    if (fragment.hasEOL) {
      flush();
      lineY = undefined;
    }
  }
  flush();
  return lines;
}

/**
 * Orden geométrico: se agrupa por baseline con tolerancia y dentro de cada
 * línea se ordena por x. Equivale a `pdftotext` sin flags.
 */
function linesInSortedOrder(fragments: TextFragment[]): string[] {
  const byPage = new Map<number, TextFragment[]>();
  for (const fragment of fragments) {
    const bucket = byPage.get(fragment.page);
    if (bucket) bucket.push(fragment);
    else byPage.set(fragment.page, [fragment]);
  }

  const lines: string[] = [];
  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageFragments = [...(byPage.get(pageNumber) ?? [])].sort((a, b) => b.y - a.y || a.x - b.x);
    let group: TextFragment[] = [];
    let lineY: number | undefined;

    const flush = () => {
      if (group.length === 0) return;
      const ordered = [...group].sort((a, b) => a.x - b.x);
      const text = trimAscii(joinLine(ordered));
      if (text.length > 0) lines.push(text);
      group = [];
    };

    for (const fragment of pageFragments) {
      if (lineY === undefined || lineY - fragment.y <= LINE_TOLERANCE_PT) {
        if (lineY === undefined) lineY = fragment.y;
        group.push(fragment);
      } else {
        flush();
        lineY = fragment.y;
        group.push(fragment);
      }
    }
    flush();
  }
  return lines;
}

function pageTexts(
  fragments: TextFragment[],
  pageCount: number,
  toLines: (fragments: TextFragment[]) => string[],
): string[] {
  const texts: string[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const ofPage = fragments.filter((fragment) => fragment.page === pageNumber);
    texts.push(toLines(ofPage).join('\n'));
  }
  return texts;
}

/** Extrae el mismo PDF en los dos órdenes que usan los ATS reales. */
export async function extractDual(pdf: Buffer): Promise<DualExtraction> {
  // pdf.js puede transferir el ArrayBuffer al worker y dejar el Buffer original
  // vacío: siempre se le pasa una copia.
  const { fragments, pageCount } = await readFragments(new Uint8Array(pdf));

  const streamLines = linesInStreamOrder(fragments);
  const sortedLines = linesInSortedOrder(fragments);
  const pagesStream = pageTexts(fragments, pageCount, linesInStreamOrder);
  const pagesSorted = pageTexts(fragments, pageCount, linesInSortedOrder);

  return {
    stream: streamLines.join('\n'),
    sorted: sortedLines.join('\n'),
    pages: pagesSorted,
    pagesStream,
    pagesSorted,
    streamLines,
    sortedLines,
    fragments,
    pageCount,
  };
}

/** Cuenta páginas sin extraer texto: lo que necesita el fit-loop en cada vuelta. */
export async function countPdfPages(pdf: Buffer): Promise<number> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl: standardFontDataUrl(),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}

/** Metadatos del catálogo que expone pdf.js, para las reglas ATS-035/036/041. */
export async function readPdfMetadata(pdf: Buffer): Promise<{
  info: Record<string, unknown>;
  marked: boolean;
  userProperties: boolean;
  structTreeRoles: string[];
}> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl: standardFontDataUrl(),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const metadata = await doc.getMetadata();
    const markInfo = await doc.getMarkInfo();
    const roles: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const tree = await page.getStructTree();
      collectRoles(tree, roles);
      page.cleanup();
    }
    return {
      info: (metadata.info ?? {}) as Record<string, unknown>,
      marked: Boolean(markInfo?.Marked),
      userProperties: Boolean(markInfo?.UserProperties),
      structTreeRoles: roles,
    };
  } finally {
    await task.destroy();
  }
}

type StructNode = { role?: string; children?: StructNode[] };

function collectRoles(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const typed = node as StructNode;
  if (typeof typed.role === 'string') out.push(typed.role);
  if (Array.isArray(typed.children)) {
    for (const child of typed.children) collectRoles(child, out);
  }
}
