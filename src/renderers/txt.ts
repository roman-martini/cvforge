import type { Renderer, RenderResult, ViewModel, VMSection } from '../core/types.ts';

/**
 * Renderer de texto plano — el GROUND TRUTH del linter.
 *
 * `cv.txt` es contra lo que se compara el texto extraído del PDF y del DOCX
 * (regla ATS-050: todo token normalizado de este archivo tiene que aparecer en
 * la extracción). De ahí tres restricciones que no son estéticas:
 *
 * 1. NO se emite el carácter de viñeta al inicio de los bullets. Chrome dibuja
 *    los marcadores de `<li>` como paths vectoriales, no como texto, así que el
 *    PDF extraído no los tiene. Si el TXT los pusiera, la comparación fallaría
 *    siempre por una diferencia cosmética. El marcador acá es la sangría.
 * 2. Se emite exactamente lo que el PDF muestra como texto visible, ni más ni
 *    menos: nunca el `href` de un enlace cuando el visible es otra cosa, nunca
 *    la URL de una entrada que el tema no imprime.
 * 3. Los rangos de fecha llegan ya formateados desde el ViewModel, con guion
 *    medio, igual que en todos los formatos. Acá no se reformatea nada.
 *
 * El subrayado de guiones bajo los headings y el separador de contacto son
 * tokens de pura puntuación: la normalización del linter (strip de puntuación
 * de borde) los reduce a vacío, así que no cuentan como texto ausente del PDF.
 */

const LINE_WIDTH = 78;
const BULLET_INDENT = '  ';
const INLINE_SEPARATOR = ' · ';

/**
 * Codepoints invisibles que sobreviven a la extracción y rompen todo match
 * exacto (ATS-054): soft hyphen, zero-width space/non-joiner/joiner, word
 * joiner y BOM. Escritos con escapes a propósito: como literales serían
 * invisibles también en este archivo.
 */
const INVISIBLE = /[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g;
const NO_BREAK_SPACE = /\u00A0/g;

function sanitize(value: string): string {
  return value
    .normalize('NFC')
    .replace(NO_BREAK_SPACE, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Corte de línea por palabras. Una palabra más larga que el ancho se deja
 * desbordar en vez de partirse: partir una URL rompería la regla ATS-060.
 */
function wrap(text: string, width: number): string[] {
  const words = sanitize(text)
    .split(' ')
    .filter((word) => word.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = words[0]!;
  for (const word of words.slice(1)) {
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function block(text: string, indent = ''): string[] {
  return wrap(text, LINE_WIDTH - indent.length).map((line) => indent + line);
}

/**
 * Título a la izquierda y fecha pegada al margen derecho. Si no entran en la
 * misma línea la fecha baja entera: abreviarla rompería ATS-061 (un único
 * patrón de fecha en todo el documento).
 */
function twoColumn(left: string, right: string, indent = ''): string[] {
  const width = LINE_WIDTH - indent.length;
  const leftText = sanitize(left);
  const rightText = sanitize(right);
  if (rightText.length === 0) return block(leftText, indent);

  if (leftText.length + 2 + rightText.length <= width) {
    const gap = ' '.repeat(width - leftText.length - rightText.length);
    return [indent + leftText + gap + rightText];
  }
  return [...block(leftText, indent), indent + rightText];
}

/** Etiqueta seguida de una lista, con sangría colgante en las continuaciones. */
function labelledList(label: string, items: string[]): string[] {
  const prefix = `${sanitize(label)}: `;
  const wrapped = wrap(items.join(', '), LINE_WIDTH - prefix.length);
  return wrapped.map((line, index) =>
    index === 0 ? prefix + line : ' '.repeat(prefix.length) + line,
  );
}

function renderEntries(section: VMSection): string[] {
  const lines: string[] = [];

  for (const entry of section.entries) {
    if (lines.length > 0) lines.push('');

    lines.push(...twoColumn(entry.title, entry.dateRange));

    // Empresa y ubicación en una sola línea: mantiene título, empresa y fecha
    // dentro de la ventana de 6 líneas que exige ATS-052.
    const subtitle = [entry.subtitle, entry.meta].filter((part): part is string => Boolean(part));
    if (subtitle.length > 0) lines.push(...block(subtitle.join(INLINE_SEPARATOR)));

    for (const position of entry.extraPositions) {
      lines.push(...twoColumn(position.title, position.dateRange, BULLET_INDENT));
    }

    if (entry.summary) {
      lines.push('');
      lines.push(...block(entry.summary));
    }

    if (entry.bullets.length > 0) {
      lines.push('');
      for (const bullet of entry.bullets) lines.push(...block(bullet, BULLET_INDENT));
    }
  }

  return lines;
}

function renderSectionBody(section: VMSection): string[] {
  switch (section.kind) {
    case 'entries':
      return renderEntries(section);
    case 'skills':
      return section.groups.flatMap((group) => labelledList(group.label, group.items));
    case 'inline-list':
      return block(section.items.join(INLINE_SEPARATOR));
    case 'text':
      return section.text ? block(section.text) : [];
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

export function renderTxt(vm: ViewModel): string {
  const lines: string[] = [];

  // Nombre en la primera línea y contacto dentro de las cinco primeras (ATS-059).
  lines.push(sanitize(vm.header.name));
  if (vm.header.headline) lines.push(sanitize(vm.header.headline));
  lines.push('');

  if (vm.header.contactLines.length > 0) {
    lines.push(...block(vm.header.contactLines.join(INLINE_SEPARATOR)));
  }
  if (vm.header.links.length > 0) {
    // El texto visible ya es la URL completa (ATS-060); el href no se imprime aparte.
    lines.push(...block(vm.header.links.map((link) => link.text).join(INLINE_SEPARATOR)));
  }

  for (const section of vm.sections) {
    if (!hasContent(section)) continue;

    const heading = sanitize(section.heading).toLocaleUpperCase(vm.locale);
    lines.push('', '', heading, '-'.repeat(heading.length), '');
    lines.push(...renderSectionBody(section));
  }

  if (vm.consentClause) {
    lines.push('', '');
    lines.push(...block(vm.consentClause));
  }

  return `${lines
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()}\n`;
}

export const txtRenderer: Renderer = {
  format: 'txt',
  extension: 'txt',
  async render(vm: ViewModel): Promise<RenderResult> {
    return { format: 'txt', content: renderTxt(vm), extension: 'txt' };
  },
};
