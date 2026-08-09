import { h } from 'preact';
import type { ComponentChildren, VNode } from 'preact';
import { render } from 'preact-render-to-string';
import type { ViewModel, VMEntry, VMSection } from '../../core/types.ts';

/**
 * Plantilla de `ats-classic`: ViewModel → HTML semántico.
 *
 * El HTML es lo único que define la calidad del PDF etiquetado. Verificado:
 * la misma página maquetada con `<div>` produce un árbol de estructura de 182
 * nodos `/NonStruct`; con `<h1>/<h2>/<h3>/<ul><li>/<p>/<a>` produce
 * `H1/H2/H3/P/L/LI/Lbl/Link/URI`. El flag `tagged` de Playwright no cambia
 * eso: sólo enciende el árbol, no lo llena de semántica.
 *
 * Se escribe con `h()` y no con JSX porque Node 24 no puede ejecutar `.tsx`:
 * falla con ERR_UNKNOWN_FILE_EXTENSION antes de mirar el contenido, y el
 * workspace no tiene build step (ADR-004). El árbol Preact es idéntico.
 */

/**
 * Separador textual REAL entre cajas hermanas. Un `gap` de CSS no genera
 * ningún carácter: sin esto, la extracción devuelve las cajas pegadas
 * ("EngineerApr 2023") y el matcher de la vacante pierde el token.
 * U+00B7 es visible y no está en la lista de codepoints invisibles prohibidos.
 */
const SEP = ' · ';

export type AccentMode = 'color' | 'none';

export type TemplateOptions = {
  /** CSS ya resuelto (con las fuentes inlineadas), en orden de cascada. */
  styles?: string[];
  /** Sobrescribe `vm.density`: el fit-loop itera sin reconstruir el ViewModel. */
  density?: ViewModel['density'];
  /** `none` apaga el acento cromático (finanzas, legal, consultoría, gobierno). */
  accent?: AccentMode;
};

type Attrs = Record<string, unknown>;

/**
 * Envoltorio sobre `h` con el tag como string libre. El cast es necesario
 * porque la sobrecarga de `h` para tags conocidos devuelve un VNode con los
 * props del elemento HTML, incompatible con el `VNode<{}>` genérico que
 * componen el resto de los helpers de este archivo.
 */
function el(tag: string, attrs: Attrs | null, ...children: ComponentChildren[]): VNode {
  return h(tag as never, attrs as never, ...children) as VNode;
}

/** Intercala un separador textual entre nodos hermanos. */
function joinNodes(nodes: ComponentChildren[], separator: string = SEP): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  for (const [index, node] of nodes.entries()) {
    if (index > 0) out.push(separator);
    out.push(node);
  }
  return out;
}

/**
 * Fecha alineada a la derecha de su título. El separador va DENTRO de la celda
 * de fecha porque el título tiene que ser el primer nodo del DOM: es lo que
 * mantiene el orden en el content stream del PDF.
 */
function dateCell(dateRange: string): VNode | null {
  if (!dateRange) return null;
  return el('span', { class: 'entry-date date' }, el('span', { class: 'sep' }, SEP), dateRange);
}

function entryHead(
  title: string,
  dateRange: string,
  subtitle: ComponentChildren[] | null,
  extra: boolean,
): VNode {
  return el(
    'div',
    { class: extra ? 'entry-head entry-head--extra' : 'entry-head' },
    el('h3', { class: 'entry-title' }, title),
    dateCell(dateRange),
    subtitle ? el('p', { class: 'entry-subtitle' }, subtitle) : null,
  );
}

function entryNode(entry: VMEntry): VNode {
  const subtitleParts: ComponentChildren[] = [];
  if (entry.subtitle) {
    // La URL de la empresa se ancla sobre su nombre y no se imprime como
    // texto: el par Link/URI enriquece el árbol de estructura sin ensuciar la
    // línea. Las URLs que el reclutador tiene que poder leer y tipear son las
    // del encabezado, y ésas sí van completas como texto visible.
    subtitleParts.push(entry.url ? el('a', { href: entry.url }, entry.subtitle) : entry.subtitle);
  }
  if (entry.meta) {
    if (subtitleParts.length > 0) subtitleParts.push(SEP);
    subtitleParts.push(entry.meta);
  }

  const children: ComponentChildren[] = [
    entryHead(entry.title, entry.dateRange, subtitleParts.length > 0 ? subtitleParts : null, false),
  ];

  for (const position of entry.extraPositions) {
    children.push(entryHead(position.title, position.dateRange, null, true));
  }

  if (entry.summary) {
    children.push(el('p', { class: 'entry-summary' }, entry.summary));
  }

  if (entry.bullets.length > 0) {
    children.push(
      el(
        'ul',
        { class: 'bullets' },
        entry.bullets.map((bullet) => el('li', null, bullet)),
      ),
    );
  }

  return el('article', { class: 'entry' }, children);
}

/**
 * El cuerpo de la sección depende exclusivamente de `kind`. No hay fallback a
 * otro campo: si el ViewModel declara `entries` y manda `groups`, el error es
 * del constructor del ViewModel y tiene que verse, no taparse acá.
 */
function sectionBody(section: VMSection): ComponentChildren[] {
  switch (section.kind) {
    case 'entries':
      return section.entries.map(entryNode);

    case 'skills':
      return section.groups
        .filter((group) => group.items.length > 0)
        .map((group) =>
          el(
            'p',
            { class: 'skill-group' },
            el('span', { class: 'skill-label' }, `${group.label}: `),
            group.items.join(', '),
          ),
        );

    case 'text':
      return section.text ? [el('p', { class: 'section-text' }, section.text)] : [];

    case 'inline-list':
      return section.items.length > 0
        ? [el('p', { class: 'inline-list' }, section.items.join(SEP))]
        : [];
  }
}

function sectionNode(section: VMSection): VNode | null {
  // `contact` ya está impreso como encabezado del documento: repetirlo
  // duplicaría email y teléfono y ensuciaría el orden de aparición que el
  // linter verifica como monótono creciente.
  if (section.name === 'contact') return null;

  const body = sectionBody(section);
  if (body.length === 0) return null;

  return el(
    'section',
    { class: `section section--${section.name}` },
    el('h2', { class: 'section-heading' }, section.heading),
    body,
  );
}

function docHead(vm: ViewModel): VNode {
  const children: ComponentChildren[] = [el('h1', { class: 'name' }, vm.header.name)];

  if (vm.header.headline) {
    children.push(el('p', { class: 'headline' }, vm.header.headline));
  }
  if (vm.header.contactLines.length > 0) {
    children.push(el('p', { class: 'contact' }, vm.header.contactLines.join(SEP)));
  }
  if (vm.header.links.length > 0) {
    // El texto visible es la URL completa, nunca la palabra "LinkedIn": el
    // reclutador que imprime el CV tiene que poder tipearla.
    const anchors = vm.header.links.map((link) => el('a', { href: link.href }, link.text));
    children.push(el('p', { class: 'links' }, joinNodes(anchors)));
  }

  return el('header', { class: 'doc-head' }, children);
}

function bodyChildren(vm: ViewModel): VNode[] {
  const nodes: VNode[] = [docHead(vm)];

  const sections = vm.sections
    .map(sectionNode)
    .filter((node): node is VNode => node !== null);
  nodes.push(el('main', { class: 'doc-body' }, sections));

  if (vm.consentClause) {
    nodes.push(el('p', { class: 'consent' }, vm.consentClause));
  }

  return nodes;
}

/** Sólo el contenido del `<body>`. Lo consume el renderer de HTML. */
export function renderBody(vm: ViewModel): string {
  return bodyChildren(vm)
    .map((node) => render(node))
    .join('\n');
}

/** Documento completo listo para `page.setContent()`. */
export function renderDocument(vm: ViewModel, opts: TemplateOptions = {}): string {
  const styles = opts.styles ?? [];

  const htmlAttrs: Attrs = {
    // Sin `lang` Chrome estampa el locale del sistema operativo en /Lang: un
    // parser con detección de idioma leería 03/09/2024 como 9 de marzo.
    lang: vm.locale,
    'data-density': opts.density ?? vm.density,
    'data-paper': vm.paper,
  };
  if (opts.accent) htmlAttrs['data-accent'] = opts.accent;

  const head = el(
    'head',
    null,
    el('meta', { charset: 'utf-8' }),
    el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
    // Chrome copia el <title> literal a /Title y con DisplayDocTitle es lo que
    // el reclutador ve en la barra del visor: neutro y determinista, jamás la
    // empresa objetivo ni el identificador de la variante.
    el('title', null, vm.documentTitle),
    // dangerouslySetInnerHTML y no un hijo de texto: el renderer escaparía
    // los `>` de los selectores y rompería el CSS.
    styles.map((css) => el('style', { dangerouslySetInnerHTML: { __html: css } })),
  );

  const document = el('html', htmlAttrs, head, el('body', null, bodyChildren(vm)));

  return `<!doctype html>\n${render(document)}\n`;
}
