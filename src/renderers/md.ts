import type { Renderer, RenderResult, ViewModel, VMSection } from '../core/types.ts';

/**
 * Renderer Markdown.
 *
 * Su caso de uso es pegar el CV en portales y formularios que renderizan
 * Markdown (campos de "About", issues, wikis internas). Por eso el texto se
 * escapa: un `*` o un `_` sin escapar en un nombre de producto convierte media
 * frase en cursiva del otro lado. Para pegar en un campo de texto plano el
 * formato correcto es `cv.txt`, no éste.
 *
 * Hermano del PDF y del DOCX, no derivado de ellos: parte del mismo ViewModel
 * y no reformatea ninguna fecha.
 */

const INLINE_SEPARATOR = ' · ';

/** Caracteres con significado sintáctico en Markdown dentro de una línea. */
const INLINE_SPECIALS = /([\\`*_[\]<>])/g;
/** Prefijos que al principio de línea abren lista, cita o heading. */
const LEADING_SPECIALS = /^(\s*)([#>+-]|\d+\.)/;

function escapeInline(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim().replace(INLINE_SPECIALS, '\\$1');
}

function escapeBlock(value: string): string {
  return escapeInline(value).replace(LEADING_SPECIALS, '$1\\$2');
}

/** Los paréntesis y espacios dentro de una URL cierran el destino del enlace antes de tiempo. */
function link(text: string, href: string): string {
  const destination = href.replace(/[()<>\s]/g, (char) => encodeURIComponent(char));
  return `[${escapeInline(text)}](${destination})`;
}

function joinNonEmpty(parts: Array<string | undefined>, separator: string): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(separator);
}

function renderEntries(section: VMSection): string[] {
  const blocks: string[] = [];

  for (const entry of section.entries) {
    const title = joinNonEmpty([entry.title, entry.subtitle], ' — ');
    blocks.push(`### ${escapeInline(title)}`);

    const meta = joinNonEmpty([entry.dateRange, entry.meta], INLINE_SEPARATOR);
    if (meta) blocks.push(escapeInline(meta));

    for (const position of entry.extraPositions) {
      blocks.push(
        `*${escapeInline(joinNonEmpty([position.title, position.dateRange], INLINE_SEPARATOR))}*`,
      );
    }

    if (entry.url) blocks.push(link(entry.url, entry.url));
    if (entry.summary) blocks.push(escapeBlock(entry.summary));
    if (entry.bullets.length > 0) {
      blocks.push(entry.bullets.map((bullet) => `- ${escapeInline(bullet)}`).join('\n'));
    }
  }

  return blocks;
}

function renderSectionBody(section: VMSection): string[] {
  switch (section.kind) {
    case 'entries':
      return renderEntries(section);
    case 'skills':
      return section.groups.map(
        (group) => `**${escapeInline(group.label)}:** ${escapeInline(group.items.join(', '))}`,
      );
    case 'inline-list':
      return [escapeInline(section.items.join(INLINE_SEPARATOR))];
    case 'text':
      return section.text ? [escapeBlock(section.text)] : [];
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

export function renderMd(vm: ViewModel): string {
  const blocks: string[] = [`# ${escapeInline(vm.header.name)}`];

  if (vm.header.headline) blocks.push(`**${escapeInline(vm.header.headline)}**`);
  if (vm.header.contactLines.length > 0) {
    blocks.push(escapeInline(vm.header.contactLines.join(INLINE_SEPARATOR)));
  }
  if (vm.header.links.length > 0) {
    blocks.push(vm.header.links.map((item) => link(item.text, item.href)).join(INLINE_SEPARATOR));
  }

  for (const section of vm.sections) {
    if (!hasContent(section)) continue;
    blocks.push(`## ${escapeInline(section.heading)}`);
    blocks.push(...renderSectionBody(section));
  }

  if (vm.consentClause) {
    blocks.push('---', `*${escapeInline(vm.consentClause)}*`);
  }

  return `${blocks.join('\n\n')}\n`;
}

export const mdRenderer: Renderer = {
  format: 'md',
  extension: 'md',
  async render(vm: ViewModel): Promise<RenderResult> {
    return { format: 'md', content: renderMd(vm), extension: 'md' };
  },
};
