import fs from 'node:fs/promises';
import path from 'node:path';
import type { LintFinding, LintReport } from '../core/types.ts';

/**
 * Lint estático del CSS de impresión (ATS-001..020 y la mitad de ATS-063).
 *
 * La causa raíz de casi toda esta blocklist es CSS 2.1 Apéndice E: Chrome emite
 * el content stream en **orden de pintado**, no de DOM. Cualquier propiedad que
 * MDN describa como "creates a stacking context" reordena el texto extraído sin
 * cambiar un pixel del PDF impreso. Criterio de mantenimiento: si MDN lo dice,
 * va a la blocklist.
 *
 * El parseo es propio y deliberadamente pequeño. No se necesita un AST completo
 * de CSS para decidir si una declaración existe y qué valor tiene, y agregar
 * postcss para eso sería sumar un árbol de dependencias al camino crítico de un
 * CLI sin build step.
 */

/* ========================================================================== *
 * Mini-parser de CSS
 * ========================================================================== */

export type CssSource = { name: string; css: string };

export type CssDeclaration = {
  property: string;
  value: string;
  /** Selector más interno que no sea una at-rule. */
  selector: string;
  /** At-rules que envuelven la declaración, de la más externa a la más interna. */
  atRules: string[];
  line: number;
  source: string;
};

export type CssBlock = {
  prelude: string;
  atRules: string[];
  declarations: CssDeclaration[];
  line: number;
  source: string;
};

type ParsedCss = { declarations: CssDeclaration[]; blocks: CssBlock[] };

/**
 * Recorre el CSS como texto llevando la cuenta de comillas, paréntesis y llaves.
 * Los paréntesis importan más de lo que parece: un `data:font/woff2;base64,…`
 * dentro de un `url()` trae un `;` que partiría la declaración en dos.
 */
export function parseCss(css: string, sourceName: string): ParsedCss {
  const declarations: CssDeclaration[] = [];
  const blocks: CssBlock[] = [];
  const stack: CssBlock[] = [];

  let buffer = '';
  let bufferLine = 1;
  let line = 1;
  let parens = 0;
  let index = 0;

  const startBuffer = () => {
    if (buffer.trim().length === 0) bufferLine = line;
  };

  const context = () => {
    const preludes = stack.map((block) => block.prelude);
    const atRules = preludes.filter((prelude) => prelude.startsWith('@'));
    const plain = preludes.filter((prelude) => !prelude.startsWith('@'));
    const selector = plain.at(-1) ?? preludes.at(-1) ?? '';
    return { selector, atRules };
  };

  const flushDeclaration = () => {
    const raw = buffer.trim();
    buffer = '';
    if (raw.length === 0) return;
    // At-rules sin bloque (`@import`, `@charset`) no son declaraciones.
    if (raw.startsWith('@')) return;
    const colon = raw.indexOf(':');
    if (colon < 0) return;
    const { selector, atRules } = context();
    const declaration: CssDeclaration = {
      property: raw.slice(0, colon).trim().toLowerCase(),
      value: raw.slice(colon + 1).trim(),
      selector,
      atRules,
      line: bufferLine,
      source: sourceName,
    };
    declarations.push(declaration);
    stack.at(-1)?.declarations.push(declaration);
  };

  while (index < css.length) {
    const char = css[index] ?? '';

    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let i = index; i < stop; i += 1) if (css[i] === '\n') line += 1;
      index = stop;
      continue;
    }

    if (char === '"' || char === "'") {
      startBuffer();
      const quote = char;
      buffer += char;
      index += 1;
      while (index < css.length) {
        const inner = css[index] ?? '';
        buffer += inner;
        index += 1;
        if (inner === '\\') {
          buffer += css[index] ?? '';
          index += 1;
          continue;
        }
        if (inner === '\n') line += 1;
        if (inner === quote) break;
      }
      continue;
    }

    if (char === '\n') {
      line += 1;
      buffer += ' ';
      index += 1;
      continue;
    }

    if (char === '(') {
      startBuffer();
      parens += 1;
      buffer += char;
      index += 1;
      continue;
    }

    if (char === ')') {
      parens = Math.max(0, parens - 1);
      buffer += char;
      index += 1;
      continue;
    }

    if (parens === 0 && char === '{') {
      const prelude = buffer.trim().replace(/\s+/g, ' ');
      buffer = '';
      const { atRules } = context();
      const block: CssBlock = {
        prelude,
        atRules: prelude.startsWith('@') ? [...atRules, prelude] : atRules,
        declarations: [],
        line: bufferLine,
        source: sourceName,
      };
      blocks.push(block);
      stack.push(block);
      index += 1;
      continue;
    }

    if (parens === 0 && char === '}') {
      flushDeclaration();
      stack.pop();
      index += 1;
      continue;
    }

    if (parens === 0 && char === ';') {
      flushDeclaration();
      index += 1;
      continue;
    }

    startBuffer();
    buffer += char;
    index += 1;
  }

  flushDeclaration();
  return { declarations, blocks };
}

/* ========================================================================== *
 * Utilidades de valores
 * ========================================================================== */

/** Tamaño de cuerpo de referencia del sistema de tokens (§6.2 del dossier). */
const BODY_PT = 10.5;
const BODY_PX = 14;

function normalizeValue(value: string): string {
  return value.replace(/!important/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseLength(value: string): { amount: number; unit: string } | undefined {
  const match = /^(-?\d*\.?\d+)(px|pt|em|rem|ex|ch|%|in|cm|mm|pc|q)?$/.exec(normalizeValue(value));
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return { amount, unit: match[2] ?? '' };
}

/** Convierte a `em` asumiendo el cuerpo de 10,5pt del tema. */
function toEm(value: string): number | undefined {
  const normalized = normalizeValue(value);
  if (normalized === 'normal' || normalized === 'initial') return 0;
  const length = parseLength(normalized);
  if (!length) return undefined;
  switch (length.unit) {
    case 'em':
    case 'rem':
    case '':
      return length.amount;
    case 'px':
      return length.amount / BODY_PX;
    case 'pt':
      return length.amount / BODY_PT;
    case '%':
      return length.amount / 100;
    default:
      return undefined;
  }
}

function toPt(value: string): number | undefined {
  const length = parseLength(value);
  if (!length) return undefined;
  switch (length.unit) {
    case 'pt':
      return length.amount;
    case 'px':
      return length.amount * 0.75;
    case 'em':
    case 'rem':
      return length.amount * BODY_PT;
    case '%':
      return (length.amount / 100) * BODY_PT;
    case 'in':
      return length.amount * 72;
    case 'cm':
      return (length.amount * 72) / 2.54;
    case 'mm':
      return (length.amount * 72) / 25.4;
    case 'pc':
      return length.amount * 12;
    default:
      return undefined;
  }
}

/* ========================================================================== *
 * Color y contraste (ATS-063)
 * ========================================================================== */

const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  whitesmoke: [245, 245, 245],
  ghostwhite: [248, 248, 255],
  snow: [255, 250, 250],
  ivory: [255, 255, 240],
};

export type Rgba = { r: number; g: number; b: number; a: number };

export function parseColor(input: string): Rgba | undefined {
  const value = normalizeValue(input);
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS[value];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };

  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1] ?? '';
    const expand = (part: string) => Number.parseInt(part.length === 1 ? part + part : part, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0] ?? '0'),
        g: expand(digits[1] ?? '0'),
        b: expand(digits[2] ?? '0'),
        a: digits.length === 4 ? expand(digits[3] ?? 'f') / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      };
    }
    return undefined;
  }

  const functional = /^rgba?\(([^)]+)\)$/.exec(value);
  if (functional) {
    const parts = (functional[1] ?? '').split(/[\s,/]+/).filter(Boolean);
    const channel = (raw: string | undefined) => {
      if (!raw) return 0;
      if (raw.endsWith('%')) return (Number.parseFloat(raw) / 100) * 255;
      return Number.parseFloat(raw);
    };
    const alphaRaw = parts[3];
    const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
    return {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a: Number.isFinite(alpha) ? alpha : 1,
    };
  }

  return undefined;
}

function relativeLuminance(color: Rgba): number {
  const channel = (raw: number) => {
    const value = Math.min(255, Math.max(0, raw)) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Compone sobre el fondo antes de medir: `rgba(0,0,0,0.02)` sobre blanco es casi blanco. */
function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = Math.min(1, Math.max(0, foreground.a));
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
}

export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const front = relativeLuminance(composite(foreground, background));
  const back = relativeLuminance(background);
  const lighter = Math.max(front, back);
  const darker = Math.min(front, back);
  return (lighter + 0.05) / (darker + 0.05);
}

/* ========================================================================== *
 * Inspección de fuentes (ATS-020)
 * ========================================================================== */

/** Orden canónico de la tabla de tags conocidos del formato WOFF2. */
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
] as const;

const VARIABLE_TABLES = new Set(['fvar', 'gvar', 'avar', 'cvar', 'HVAR', 'VVAR', 'MVAR', 'STAT']);

function readUIntBase128(buffer: Buffer, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let cursor = offset;
  for (let i = 0; i < 5; i += 1) {
    const byte = buffer[cursor];
    if (byte === undefined) return undefined;
    cursor += 1;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: cursor };
  }
  return undefined;
}

/** Lee la table directory de un woff2 sin descomprimir el cuerpo Brotli. */
function woff2Tables(buffer: Buffer): string[] | undefined {
  if (buffer.length < 48) return undefined;
  const numTables = buffer.readUInt16BE(12);
  let cursor = 48;
  const tags: string[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const flags = buffer[cursor];
    if (flags === undefined) return undefined;
    cursor += 1;
    const known = flags & 0x3f;
    let tag: string;
    if (known === 0x3f) {
      tag = buffer.toString('latin1', cursor, cursor + 4);
      cursor += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[known] ?? '????';
    }
    const originalLength = readUIntBase128(buffer, cursor);
    if (!originalLength) return undefined;
    cursor = originalLength.next;
    const transform = (flags >> 6) & 0x03;
    const trimmed = tag.trim();
    const isGlyfOrLoca = trimmed === 'glyf' || trimmed === 'loca';
    const hasTransformLength = isGlyfOrLoca ? transform === 0 : transform !== 0;
    if (hasTransformLength) {
      const transformLength = readUIntBase128(buffer, cursor);
      if (!transformLength) return undefined;
      cursor = transformLength.next;
    }
    tags.push(trimmed);
  }
  return tags;
}

function sfntTables(buffer: Buffer, tableDirectoryOffset: number, numTables: number): string[] {
  const tags: string[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const offset = tableDirectoryOffset + i * 16;
    if (offset + 4 > buffer.length) break;
    tags.push(buffer.toString('latin1', offset, offset + 4).trim());
  }
  return tags;
}

/**
 * Verdadero si la fuente trae tablas de variación. Chromium **no embebe**
 * fuentes variables: los `/FontDescriptor` salen sin `/FontFile2` y el PDF
 * termina con otra tipografía —y otra paginación— en la máquina del reclutador.
 */
export function fontTableTags(buffer: Buffer): string[] | undefined {
  if (buffer.length < 12) return undefined;
  const signature = buffer.toString('latin1', 0, 4);
  if (signature === 'wOF2') return woff2Tables(buffer);
  if (signature === 'wOFF') {
    const numTables = buffer.readUInt16BE(12);
    const tags: string[] = [];
    for (let i = 0; i < numTables; i += 1) {
      const offset = 44 + i * 20;
      if (offset + 4 > buffer.length) break;
      tags.push(buffer.toString('latin1', offset, offset + 4).trim());
    }
    return tags;
  }
  if (signature === 'OTTO' || signature === 'true' || signature === 'ttcf' || buffer.readUInt32BE(0) === 0x00010000) {
    return sfntTables(buffer, 12, buffer.readUInt16BE(4));
  }
  return undefined;
}

export function isVariableFont(buffer: Buffer): boolean | undefined {
  const tags = fontTableTags(buffer);
  if (!tags) return undefined;
  return tags.some((tag) => VARIABLE_TABLES.has(tag));
}

/* ========================================================================== *
 * Reglas
 * ========================================================================== */

export type CssLintOptions = {
  /** Familias permitidas en `@font-face`; se comparan sin distinguir mayúsculas. */
  fontAllowlist?: string[];
  /** Directorio donde viven las fuentes vendorizadas (`assets/fonts`). */
  fontsDir?: string;
  /** Directorio del CSS, para resolver `url()` relativas. */
  baseDir?: string;
  /** Techo de `letter-spacing` en em. La ruptura de extracción está verificada en 0.15em. */
  maxLetterSpacingEm?: number;
  /** Mínimo de cuerpo en pt. */
  minBodyFontPt?: number;
  /** Debajo de esto ya no es un problema de legibilidad: es texto oculto. */
  fraudFontPt?: number;
  /** Color de fondo del papel, contra el que se mide el contraste. */
  pageBackground?: string;
  minContrastRatio?: number;
};

const DEFAULTS = {
  fontAllowlist: ['source sans 3', 'eb garamond'],
  maxLetterSpacingEm: 0.12,
  minBodyFontPt: 9,
  fraudFontPt: 6,
  pageBackground: '#ffffff',
  minContrastRatio: 1.5,
} as const;

const MARGIN_BOXES = new Set([
  '@top-left-corner', '@top-left', '@top-center', '@top-right', '@top-right-corner',
  '@bottom-left-corner', '@bottom-left', '@bottom-center', '@bottom-right', '@bottom-right-corner',
  '@left-top', '@left-middle', '@left-bottom', '@right-top', '@right-middle', '@right-bottom',
]);

const STACKING_PROPERTIES: Record<string, string> = {
  filter: 'filter',
  'backdrop-filter': 'backdrop-filter',
  'mix-blend-mode': 'mix-blend-mode',
  isolation: 'isolation',
  'will-change': 'will-change',
  contain: 'contain',
  perspective: 'perspective',
  mask: 'mask',
  'mask-image': 'mask-image',
  'clip-path': 'clip-path',
  'view-transition-name': 'view-transition-name',
};

const BODY_SELECTOR = /(^|[\s,>+~])(body|p|li|ul|ol|dd|dt|td|article|section|main)\b|\.(body|bullet|bullets|summary|entry|text)\b|:root/i;
const BODY_CUSTOM_PROPERTY = /^--(fs-body|fs-bullet|fs-text|font-size-body)$/;

function where(declaration: CssDeclaration): string {
  const scope = [...declaration.atRules, declaration.selector].filter(Boolean).join(' ');
  return `${declaration.source}:${declaration.line} · ${scope || '(raíz)'} { ${declaration.property} }`;
}

function finding(
  rule: string,
  severity: 'error' | 'warning',
  message: string,
  declaration: CssDeclaration,
  fix: string,
): LintFinding {
  return { rule, severity, message, where: where(declaration), fix };
}

function urlsIn(value: string): string[] {
  const urls: string[] = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
  let match = pattern.exec(value);
  while (match) {
    urls.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = pattern.exec(value);
  }
  return urls;
}

const CONTACT_IN_PAGE = [
  { label: 'un email', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { label: 'una URL', pattern: /(https?:\/\/|www\.)\S+/i },
  { label: 'un teléfono', pattern: /\+?\d[\d\s().-]{7,}/ },
];

function lintDeclarations(declarations: CssDeclaration[], options: Required<Omit<CssLintOptions, 'fontsDir' | 'baseDir'>>): LintFinding[] {
  const findings: LintFinding[] = [];
  const background = parseColor(options.pageBackground) ?? { r: 255, g: 255, b: 255, a: 1 };
  let sawExplicitHyphens = false;

  for (const declaration of declarations) {
    const property = declaration.property;
    const value = normalizeValue(declaration.value);
    const inPage = declaration.atRules.some((rule) => rule === '@page' || rule.startsWith('@page '));
    const inMarginBox = declaration.atRules.some((rule) => MARGIN_BOXES.has(rule.split(' ')[0] ?? ''));

    // ── ATS-001 ────────────────────────────────────────────────────────────
    if (property === 'float' && value !== 'none') {
      findings.push(
        finding(
          'ATS-001',
          'error',
          `float: ${value} adelanta la caja al principio del content stream. Es el patrón más común de los templates de CV y el que desprende la fecha de su entrada.`,
          declaration,
          'Alineá la fecha con `display: grid; grid-template-columns: 1fr auto`, con el título primero en el DOM.',
        ),
      );
    }

    // ── ATS-002 ────────────────────────────────────────────────────────────
    if (property === 'position' && value !== 'static' && value !== '') {
      findings.push(
        finding(
          'ATS-002',
          'error',
          `position: ${value} crea un stacking context. Verificado: incluso \`relative\` empuja la experiencia entera al final del texto extraído.`,
          declaration,
          'Resolvé la posición con grid o flujo normal. `relative` sin desplazamiento tampoco es inocuo.',
        ),
      );
    }

    // ── ATS-003 ────────────────────────────────────────────────────────────
    if (property === 'opacity') {
      const amount = Number.parseFloat(value.endsWith('%') ? String(Number.parseFloat(value) / 100) : value);
      if (Number.isFinite(amount) && amount < 1) {
        const severity = amount === 0 ? 'error' : 'error';
        findings.push(
          finding(
            'ATS-003',
            severity,
            amount === 0
              ? 'opacity: 0 oculta texto que igual se extrae: eso es fraude y es detectable (ATS-063).'
              : `opacity: ${amount} crea un stacking context. Un 0.7 decorativo en las fechas las apila al final del texto extraído sin que el PDF cambie.`,
            declaration,
            'Para atenuar usá un color más claro (`--ink-muted: #4A5058`, 8,1:1), nunca opacidad.',
          ),
        );
      }
    }

    // ── ATS-004 ────────────────────────────────────────────────────────────
    if ((property === 'transform' || property === 'translate' || property === 'rotate' || property === 'scale') && value !== 'none' && value !== '') {
      findings.push(
        finding(
          'ATS-004',
          'error',
          `${property}: ${value} crea un stacking context. Incluso \`translateY(0)\`, que visualmente no hace nada, reordena el content stream.`,
          declaration,
          'Ajustá con margin/padding. Ninguna transformación es "neutra" para el extractor.',
        ),
      );
    }

    // ── ATS-005 ────────────────────────────────────────────────────────────
    const stacking = STACKING_PROPERTIES[property];
    if (stacking) {
      const neutral =
        value === 'none' ||
        value === 'normal' ||
        value === 'auto' ||
        value === '' ||
        (property === 'isolation' && value === 'auto') ||
        (property === 'contain' && !/\b(paint|layout|content|strict)\b/.test(value));
      if (!neutral) {
        findings.push(
          finding(
            'ATS-005',
            'error',
            `${property}: ${value} crea un stacking context (criterio: MDN lo documenta como tal) y reordena el texto extraído.`,
            declaration,
            'Quitá la propiedad. En un documento de una columna ninguna de estas aporta nada al PDF impreso.',
          ),
        );
      }
    }

    // ── ATS-006 ────────────────────────────────────────────────────────────
    if ((property === 'column-count' || property === 'columns' || property === 'column-width') && value !== 'auto' && value !== '' && value !== '1') {
      findings.push(
        finding(
          'ATS-006',
          'error',
          `${property}: ${value} produce un layout multicolumna: el extractor por orden geométrico lee las dos columnas entrelazadas línea a línea.`,
          declaration,
          'Una sola columna. Es la única topología que se lee igual en las dos familias de extractores.',
        ),
      );
    }

    // ── ATS-007 ────────────────────────────────────────────────────────────
    if (property === 'order' && value !== '0' && value !== '') {
      findings.push(
        finding('ATS-007', 'error', `order: ${value} separa el orden visual del orden del DOM, que es el que se extrae.`, declaration, 'Reordená en el ViewModel, no en el CSS.'),
      );
    }
    if ((property === 'flex-direction' || property === 'flex-flow' || property === 'grid-auto-flow') && /reverse/.test(value)) {
      findings.push(
        finding('ATS-007', 'error', `${property}: ${value} invierte el orden visual respecto del DOM.`, declaration, 'Emitá los elementos en el orden final desde el ViewModel.'),
      );
    }
    if (property === 'grid-auto-flow' && /\bdense\b/.test(value)) {
      findings.push(
        finding('ATS-007', 'error', 'grid-auto-flow: dense reubica ítems para tapar huecos y rompe la correspondencia DOM/visual.', declaration, 'Usá el flujo por defecto.'),
      );
    }

    // ── ATS-008 ────────────────────────────────────────────────────────────
    if (property === 'direction' && value === 'rtl') {
      findings.push(finding('ATS-008', 'error', 'direction: rtl invierte el orden de los caracteres extraídos.', declaration, 'Dejá `direction: ltr`.'));
    }
    if (property === 'unicode-bidi' && value !== 'normal' && value !== '') {
      findings.push(finding('ATS-008', 'error', `unicode-bidi: ${value} altera el orden lógico del texto.`, declaration, 'Dejá `unicode-bidi: normal`.'));
    }

    // ── ATS-009 ────────────────────────────────────────────────────────────
    if ((property === 'text-align' || property === 'text-align-last') && /justify/.test(value)) {
      findings.push(
        finding(
          'ATS-009',
          'error',
          'text-align: justify hace que Chrome emita una operación de texto por palabra: la extracción devuelve una palabra por línea y parte las frases clave.',
          declaration,
          'Alineá a la izquierda. En una medida de ~100 caracteres el justificado además abre ríos.',
        ),
      );
    }

    // ── ATS-010 ────────────────────────────────────────────────────────────
    if (property === 'hyphens' || property === '-webkit-hyphens') {
      if (value === 'manual') sawExplicitHyphens = true;
      else {
        findings.push(
          finding(
            'ATS-010',
            'error',
            `hyphens: ${value} inserta guiones blandos que sobreviven a la extracción y parten palabras clave por la mitad.`,
            declaration,
            'Poné `hyphens: manual` explícito.',
          ),
        );
      }
    }

    // ── ATS-011 ────────────────────────────────────────────────────────────
    if (property === 'letter-spacing') {
      const em = toEm(value);
      if (em !== undefined && em > options.maxLetterSpacingEm) {
        findings.push(
          finding(
            'ATS-011',
            'error',
            `letter-spacing: ${declaration.value} (≈${em.toFixed(3)}em) supera el techo de ${options.maxLetterSpacingEm}em. La ruptura de extracción está verificada en 0.15em: "E X P E R I E N C E" no matchea ningún label y rompe justo lo que el parser usa para segmentar.`,
            declaration,
            'Bajá a ≤0.08em, o mejor: `font-variant: all-small-caps`, que conserva la capitalización original en el texto extraído.',
          ),
        );
      }
    }

    // ── ATS-012 ────────────────────────────────────────────────────────────
    if (property === 'word-spacing' && value !== 'normal' && value !== '' && toEm(value) !== 0) {
      findings.push(
        finding('ATS-012', 'error', `word-spacing: ${declaration.value} altera los avances y hace que el extractor invente o pierda separadores.`, declaration, 'Dejá `word-spacing: normal`.'),
      );
    }

    // ── ATS-013 ────────────────────────────────────────────────────────────
    if (property === 'content' && !inPage && !inMarginBox) {
      const isMarker = /::?marker\b/.test(declaration.selector);
      const isPseudoElement = /::?(before|after)\b/.test(declaration.selector);
      const injectsText = /"[^"]*\S[^"]*"|'[^']*\S[^']*'|attr\(/.test(declaration.value);
      if (isPseudoElement && !isMarker && injectsText) {
        findings.push(
          finding(
            'ATS-013',
            'error',
            `content: ${declaration.value} inyecta texto que no existe en el modelo de datos: aparece en el PDF, no en cv.txt, y rompe el recall de ATS-050 por los dos lados.`,
            declaration,
            'Emitá los separadores como texto real desde el ViewModel (" · ", " — ").',
          ),
        );
      }
    }

    // ── ATS-014 ────────────────────────────────────────────────────────────
    if (inMarginBox && property === 'content') {
      for (const contact of CONTACT_IN_PAGE) {
        if (contact.pattern.test(declaration.value)) {
          findings.push(
            finding(
              'ATS-014',
              'error',
              `El margin-box de @page contiene ${contact.label}. Ese texto queda fuera del árbol de estructura —ni siquiera como /Artifact— y falló en 6 de 8 ATS: el candidato aplica literalmente sin datos de contacto.`,
              declaration,
              'En @page sólo `counter(page)` / `counter(pages)`. El contacto va en el flujo del documento, en las primeras 5 líneas.',
            ),
          );
        }
      }
    }

    // ── ATS-015 ────────────────────────────────────────────────────────────
    if (property === 'font-size' || BODY_CUSTOM_PROPERTY.test(property)) {
      const pt = toPt(value);
      if (pt !== undefined && pt > 0) {
        if (pt < options.fraudFontPt) {
          findings.push(
            finding(
              'ATS-015',
              'error',
              `font-size ${declaration.value} (≈${pt.toFixed(1)}pt) es texto que nadie puede leer pero el extractor sí: es keyword stuffing y es detectable.`,
              declaration,
              'Borrá la regla. No existe un uso legítimo de texto de menos de 6pt en un CV.',
            ),
          );
        } else if (pt < options.minBodyFontPt) {
          const isBody = BODY_CUSTOM_PROPERTY.test(property) || BODY_SELECTOR.test(declaration.selector);
          findings.push(
            finding(
              'ATS-015',
              isBody ? 'error' : 'warning',
              `font-size ${declaration.value} (≈${pt.toFixed(1)}pt) está por debajo del mínimo de ${options.minBodyFontPt}pt${isBody ? ' para cuerpo de texto' : ''}.`,
              declaration,
              isBody ? 'El rango legible del cuerpo es 10-11pt; usá el escalón `dense` del fit-loop antes de bajar de ahí.' : 'Aceptable sólo en pie de página (--fs-micro: 8.5pt).',
            ),
          );
        }
      }
    }

    // ── ATS-016 ────────────────────────────────────────────────────────────
    if (property === 'display' && /^(inline-)?table(-|$)/.test(value)) {
      findings.push(
        finding(
          'ATS-016',
          'error',
          `display: ${value} reconstruye una tabla de layout: varios ATS leen las celdas en orden de columna y mezclan empresas con fechas.`,
          declaration,
          'Usá grid con `grid-template-columns: 1fr auto`.',
        ),
      );
    }

    // ── ATS-017 ────────────────────────────────────────────────────────────
    if (property === 'writing-mode' && value !== 'horizontal-tb' && value !== '') {
      findings.push(finding('ATS-017', 'warning', `writing-mode: ${value} produce texto vertical que casi ningún extractor ordena bien.`, declaration, 'Dejá `horizontal-tb`.'));
    }

    // ── ATS-019 ────────────────────────────────────────────────────────────
    if (inPage) {
      for (const url of urlsIn(declaration.value)) {
        if (url && !url.startsWith('data:')) {
          findings.push(
            finding(
              'ATS-019',
              'error',
              `url(${url}) dentro de @page no carga. Verificado en Chrome 151: un file:/// absoluto en un margin-box produce un PDF byte-idéntico al del archivo inexistente, sin ningún error.`,
              declaration,
              'Embebé el recurso como data: URI, o sacalo de @page.',
            ),
          );
        }
      }
    }

    // ── ATS-063 (mitad CSS) ────────────────────────────────────────────────
    if (property === 'color') {
      const color = parseColor(value);
      if (color && color.a === 0) {
        findings.push(
          finding(
            'ATS-063',
            'error',
            'color: transparent deja texto invisible que el extractor sí lee. Técnicamente funciona, y es exactamente por eso que es fraude y es detectable.',
            declaration,
            'Si el texto no debe estar, sacalo del modelo de datos.',
          ),
        );
      } else if (color) {
        const ratio = contrastRatio(color, background);
        if (ratio < options.minContrastRatio) {
          findings.push(
            finding(
              'ATS-063',
              'error',
              `color ${declaration.value} sobre el fondo del papel da ${ratio.toFixed(2)}:1, por debajo de ${options.minContrastRatio}:1. Es texto invisible al ojo y legible por el parser.`,
              declaration,
              'Contraste mínimo del cuerpo: usá --ink (#16181D, 17,8:1) o --ink-muted (#4A5058, 8,1:1).',
            ),
          );
        }
      }
    }
  }

  if (!sawExplicitHyphens) {
    findings.push({
      rule: 'ATS-010',
      severity: 'warning',
      message:
        'No hay ninguna declaración `hyphens: manual` explícita. El valor inicial de CSS ya es `manual`, pero declararlo evita que una regla heredada o un reset lo cambien sin que nadie lo note.',
      where: 'hoja de estilos del tema',
      fix: 'Agregá `* { hyphens: manual; }` al reset del tema.',
    });
  }

  return findings;
}

/** ATS-063: texto y fondo declarados en la misma regla. */
function lintBlockContrast(blocks: CssBlock[], minRatio: number): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const block of blocks) {
    const colorDeclaration = block.declarations.findLast((d) => d.property === 'color');
    const backgroundDeclaration = block.declarations.findLast(
      (d) => d.property === 'background-color' || d.property === 'background',
    );
    if (!colorDeclaration || !backgroundDeclaration) continue;
    const foreground = parseColor(colorDeclaration.value);
    const background = parseColor(backgroundDeclaration.value.split(/\s+/)[0] ?? '');
    if (!foreground || !background || background.a === 0) continue;
    const ratio = contrastRatio(foreground, background);
    if (ratio < minRatio) {
      findings.push(
        finding(
          'ATS-063',
          'error',
          `El selector "${block.prelude}" pinta texto ${colorDeclaration.value} sobre ${backgroundDeclaration.value}: ${ratio.toFixed(2)}:1. Invisible al ojo, perfectamente legible para el extractor.`,
          colorDeclaration,
          'Si el bloque no debe verse, no lo emitas.',
        ),
      );
    }
  }
  return findings;
}

/** ATS-018 y ATS-020: familias permitidas y ninguna fuente variable. */
async function lintFontFaces(
  blocks: CssBlock[],
  options: CssLintOptions,
): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  const allowlist = (options.fontAllowlist ?? [...DEFAULTS.fontAllowlist]).map((name) => name.toLowerCase());

  for (const block of blocks) {
    if (!block.prelude.startsWith('@font-face')) continue;
    const familyDeclaration = block.declarations.find((d) => d.property === 'font-family');
    const srcDeclaration = block.declarations.find((d) => d.property === 'src');
    const family = (familyDeclaration?.value ?? '').replace(/["']/g, '').trim();

    if (!familyDeclaration) {
      findings.push({
        rule: 'ATS-018',
        severity: 'error',
        message: '@font-face sin font-family. Un error de sintaxis acá descarta TODO el stylesheet sin emitir ningún error y el PDF sale en Times New Roman 12pt con el build en verde.',
        where: `${block.source}:${block.line} · @font-face`,
        fix: 'Declará font-family y src con rutas relativas a assets/fonts/.',
      });
      continue;
    }

    if (!allowlist.includes(family.toLowerCase())) {
      findings.push({
        rule: 'ATS-018',
        severity: 'error',
        message: `La familia "${family}" no está en la allowlist del tema (${allowlist.join(', ')}). Sólo se cargan fuentes vendorizadas en assets/fonts/ con su LICENSE al lado.`,
        where: `${block.source}:${block.line} · @font-face`,
        fix: 'Agregá la familia a theme.yaml si es legítima, o usá una de las vendorizadas.',
      });
    }

    if (!srcDeclaration) {
      findings.push({
        rule: 'ATS-018',
        severity: 'error',
        message: `@font-face de "${family}" sin src.`,
        where: `${block.source}:${block.line} · @font-face`,
        fix: 'Agregá `src: url("…woff2") format("woff2")`.',
      });
      continue;
    }

    for (const url of urlsIn(srcDeclaration.value)) {
      if (!url || url.startsWith('data:')) continue;
      const baseDir = options.baseDir;
      if (!baseDir) continue;
      const resolved = path.resolve(baseDir, url.split('#')[0]?.split('?')[0] ?? url);

      if (options.fontsDir) {
        const fontsDir = path.resolve(options.fontsDir);
        const relative = path.relative(fontsDir, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          findings.push({
            rule: 'ATS-018',
            severity: 'error',
            message: `El src de "${family}" apunta fuera de assets/fonts/: ${resolved}`,
            where: `${srcDeclaration.source}:${srcDeclaration.line} · @font-face`,
            fix: 'Vendorizá la fuente dentro de assets/fonts/<familia>/ junto a su LICENSE.',
          });
          continue;
        }
      }

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(resolved);
      } catch {
        findings.push({
          rule: 'ATS-018',
          severity: 'error',
          message: `El archivo de fuente no existe: ${resolved}. Chrome no falla: sustituye en silencio por la siguiente del stack, con otras métricas y otra paginación.`,
          where: `${srcDeclaration.source}:${srcDeclaration.line} · @font-face`,
          fix: 'Corregí la ruta o instalá la fuente vendorizada.',
        });
        continue;
      }

      const variable = isVariableFont(buffer);
      if (variable === true) {
        findings.push({
          rule: 'ATS-020',
          severity: 'error',
          message: `"${family}" (${path.basename(resolved)}) es una fuente variable. Verificado: Chromium no embebe fuentes con tabla fvar — los /FontDescriptor salen sin /FontFile2 y el reclutador ve otra tipografía y otra paginación.`,
          where: `${srcDeclaration.source}:${srcDeclaration.line} · @font-face`,
          fix: 'Usá instancias estáticas: @fontsource/source-sans-3, nunca @fontsource-variable/source-sans-3.',
        });
      } else if (variable === undefined) {
        findings.push({
          rule: 'ATS-020',
          severity: 'warning',
          message: `No se pudo leer la table directory de ${path.basename(resolved)}; no se pudo descartar que sea una fuente variable.`,
          where: `${srcDeclaration.source}:${srcDeclaration.line} · @font-face`,
          fix: 'Verificá el archivo a mano o reemplazalo por el woff2 estático de @fontsource.',
        });
      }
    }
  }

  return findings;
}

/* ========================================================================== *
 * HTML del template
 * ========================================================================== */

/** Estilos embebidos y atributos `style=`, envueltos para pasar por el mismo parser. */
export function extractInlineStyles(html: string, sourceName = 'template.html'): CssSource[] {
  const sources: CssSource[] = [];

  const styleBlocks = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match = styleBlocks.exec(html);
  let index = 0;
  while (match) {
    sources.push({ name: `${sourceName} <style#${index}>`, css: match[1] ?? '' });
    index += 1;
    match = styleBlocks.exec(html);
  }

  const inlineAttributes = /<([a-z][\w-]*)\b[^>]*?\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let attribute = inlineAttributes.exec(html);
  let attributeIndex = 0;
  while (attribute) {
    const declarations = attribute[3] ?? attribute[4] ?? '';
    sources.push({
      name: `${sourceName} style=<${attribute[1]}#${attributeIndex}>`,
      css: `[style-inline] { ${declarations} }`,
    });
    attributeIndex += 1;
    attribute = inlineAttributes.exec(html);
  }

  return sources;
}

/** Reglas que se verifican sobre el HTML y no sobre el CSS. */
export function lintTemplateHtml(html: string, sourceName = 'template.html'): LintFinding[] {
  const findings: LintFinding[] = [];

  if (/<table\b/i.test(html)) {
    findings.push({
      rule: 'ATS-016',
      severity: 'error',
      message: '<table> en el template. Varios ATS recorren las celdas por columna y entregan empresas y fechas mezcladas.',
      where: sourceName,
      fix: 'Reemplazalo por grid de una columna. La tabla nunca es necesaria en un CV de una columna.',
    });
  }

  const entities: Array<{ pattern: RegExp; codepoint: string; rule: string }> = [
    { pattern: /&nbsp;|&#160;|&#xa0;/i, codepoint: 'U+00A0', rule: 'ATS-054' },
    { pattern: /&shy;|&#173;|&#xad;/i, codepoint: 'U+00AD', rule: 'ATS-054' },
    { pattern: /&zwnj;|&zwj;|&#8203;|&#x200b;/i, codepoint: 'U+200B/C/D', rule: 'ATS-054' },
  ];
  for (const entity of entities) {
    if (entity.pattern.test(html)) {
      findings.push({
        rule: entity.rule,
        severity: 'error',
        message: `El template emite ${entity.codepoint}. Sobrevive intacto a la extracción: "March${' '}2022" no matchea "March 2022" ni sobrevive a un split(" ").`,
        where: sourceName,
        fix: 'Usá una clase `.nowrap { white-space: nowrap }` en vez de la entidad.',
      });
    }
  }

  if (!/<html[^>]*\blang\s*=/i.test(html)) {
    findings.push({
      rule: 'ATS-035',
      severity: 'error',
      message: 'Falta <html lang>. Sin él Chrome estampa el locale del sistema en /Lang (verificado es-419 en un CV en inglés) y un parser con detección de locale lee 03/09/2024 como 9 de marzo.',
      where: sourceName,
      fix: 'Emití <html lang="{vm.locale}">.',
    });
  }

  if (!/<title\b/i.test(html)) {
    findings.push({
      rule: 'ATS-038',
      severity: 'error',
      message: 'Falta <title>. Chrome lo copia literal a /Title y con /ViewerPreferences /DisplayDocTitle es lo que ve el reclutador en el visor.',
      where: sourceName,
      fix: 'Emití <title>{Nombre Apellido} — Resume</title>, neutro y determinista.',
    });
  }

  if (!/<h1\b/i.test(html)) {
    findings.push({
      rule: 'ATS-036',
      severity: 'warning',
      message: 'El template no emite <h1>. Con <div> el árbol de estructura del PDF sale como 182 /NonStruct; con HTML semántico salen H1/H2/H3/P/L/LI/Lbl/Link/URI.',
      where: sourceName,
      fix: 'El nombre va en <h1>, las secciones en <h2>, los cargos en <h3>.',
    });
  }

  if (!/<ul\b|<ol\b/i.test(html)) {
    findings.push({
      rule: 'ATS-036',
      severity: 'warning',
      message: 'No hay listas nativas. Con <ul><li> Chrome dibuja los marcadores como paths vectoriales y el ATS nunca ve un "•" espurio.',
      where: sourceName,
      fix: 'Emití los bullets con <ul><li>, no con un "•" de texto.',
    });
  }

  return findings;
}

/* ========================================================================== *
 * Entrada pública
 * ========================================================================== */

export async function lintCssSources(sources: CssSource[], options: CssLintOptions = {}): Promise<LintFinding[]> {
  const resolved = {
    fontAllowlist: options.fontAllowlist ?? [...DEFAULTS.fontAllowlist],
    maxLetterSpacingEm: options.maxLetterSpacingEm ?? DEFAULTS.maxLetterSpacingEm,
    minBodyFontPt: options.minBodyFontPt ?? DEFAULTS.minBodyFontPt,
    fraudFontPt: options.fraudFontPt ?? DEFAULTS.fraudFontPt,
    pageBackground: options.pageBackground ?? DEFAULTS.pageBackground,
    minContrastRatio: options.minContrastRatio ?? DEFAULTS.minContrastRatio,
  };

  const declarations: CssDeclaration[] = [];
  const blocks: CssBlock[] = [];
  for (const source of sources) {
    const parsed = parseCss(source.css, source.name);
    declarations.push(...parsed.declarations);
    blocks.push(...parsed.blocks);
  }

  return [
    ...lintDeclarations(declarations, resolved),
    ...lintBlockContrast(blocks, resolved.minContrastRatio),
    ...(await lintFontFaces(blocks, options)),
  ];
}

export type ThemeLintInput = {
  sources: CssSource[];
  html?: string;
  htmlName?: string;
  options?: CssLintOptions;
};

/** Corre la batería completa de CSS + HTML del tema. */
export async function lintTheme(input: ThemeLintInput): Promise<LintReport> {
  const inline = input.html ? extractInlineStyles(input.html, input.htmlName) : [];
  const findings = [
    ...(await lintCssSources([...input.sources, ...inline], input.options)),
    ...(input.html ? lintTemplateHtml(input.html, input.htmlName) : []),
  ];
  return {
    format: 'css',
    findings,
    passed: findings.every((f) => f.severity !== 'error'),
  };
}
