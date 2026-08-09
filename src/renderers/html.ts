import type { SectionName } from '../core/schema/tailoring.ts';
import type { Renderer, RenderResult, ViewModel, VMSection } from '../core/types.ts';

/**
 * Renderer HTML autocontenido: un único archivo con el CSS embebido y sin un
 * solo recurso externo (ni fuentes, ni scripts, ni imágenes remotas). Se abre
 * con doble clic, se sube a cualquier hosting estático y se archiva tal cual.
 *
 * NO es el HTML que alimenta al PDF. Ese vive en `src/themes/<tema>/` y está
 * sujeto a las reglas de lint de impresión (nada de float, position, columnas
 * ni transform). Éste es una página web: puede usar flex, grid y media queries
 * sin consecuencias para ningún parser, porque nadie extrae texto de acá.
 *
 * Es además la PROYECCIÓN PÚBLICA del CV: se publica en internet, así que
 * descarta el teléfono, cualquier dato de contacto directo y la sección de
 * referencias. Los campos `address` y `postalCode` ya vienen marcados como
 * privados por el schema y no llegan hasta acá; el teléfono sí puede venir en
 * la línea de contacto del PDF, y se filtra explícitamente. El mismo filtro se
 * aplica al modelo embebido en `<script type="application/json">`: publicar la
 * página con el teléfono escondido en el JSON sería peor que imprimirlo.
 */

const INLINE_SEPARATOR = ' · ';

/** Secciones que nunca salen a la web, cualquiera sea el perfil regional. */
const PRIVATE_SECTIONS: ReadonlySet<SectionName> = new Set<SectionName>(['references']);

/** Etiquetas con las que un humano prefija un teléfono en la línea de contacto. */
const PHONE_LABEL = /^(tel|tel\.|phone|telephone|teléfono|telefono|móvil|movil|mobile|cel|celular|whatsapp)\s*[:.]?\s*/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serializa para un `<script>`: escapar `<` impide que un `</script>` dentro de
 * un dato cierre el bloque y convierta contenido en marcado ejecutable.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

function isPhone(value: string): boolean {
  const candidate = value.trim().replace(PHONE_LABEL, '');
  const digits = candidate.replace(/\D/g, '');
  return digits.length >= 7 && /^[+()\d\s./-]+$/.test(candidate);
}

function findEmail(lines: string[]): string | undefined {
  return lines.find((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line.trim()))?.trim();
}

/** La línea de contacto que no es ni mail ni teléfono ni URL: la localidad. */
function findLocality(lines: string[]): string | undefined {
  return lines.find(
    (line) => !isPhone(line) && !line.includes('@') && !/^https?:\/\//i.test(line.trim()),
  );
}

/** Quita del ViewModel todo lo que no puede publicarse en una página abierta. */
export function toPublicViewModel(vm: ViewModel): ViewModel {
  return {
    ...vm,
    header: {
      ...vm.header,
      contactLines: vm.header.contactLines.filter((line) => !isPhone(line)),
      links: vm.header.links.filter((link) => !/^tel:/i.test(link.href)),
    },
    sections: vm.sections.filter((section) => !PRIVATE_SECTIONS.has(section.name)),
  };
}

function hasContent(section: VMSection): boolean {
  return (
    section.entries.length > 0 ||
    section.groups.length > 0 ||
    section.items.length > 0 ||
    Boolean(section.text)
  );
}

function findSection(vm: ViewModel, name: SectionName): VMSection | undefined {
  return vm.sections.find((section) => section.name === name);
}

function joinNonEmpty(parts: Array<string | undefined>, separator: string): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(separator);
}

/* ========================================================================== *
 * JSON-LD
 * ========================================================================== */

function buildJsonLd(vm: ViewModel): Record<string, unknown> {
  const email = findEmail(vm.header.contactLines);
  const locality = findLocality(vm.header.contactLines);
  const work = findSection(vm, 'work');
  const education = findSection(vm, 'education');
  const languages = findSection(vm, 'languages');

  const person: Record<string, unknown> = {
    '@type': 'Person',
    name: vm.header.name,
    jobTitle: vm.header.headline || undefined,
    description: findSection(vm, 'summary')?.text,
    email: email ? `mailto:${email}` : undefined,
    address: locality ? { '@type': 'PostalAddress', addressLocality: locality } : undefined,
    url: vm.header.links[0]?.href,
    sameAs: vm.header.links.map((link) => link.href),
    knowsAbout: vm.meta.keywords,
    knowsLanguage: languages?.items,
    worksFor: work?.entries[0]
      ? { '@type': 'Organization', name: work.entries[0].subtitle }
      : undefined,
    alumniOf: education?.entries.map((entry) => ({
      '@type': 'EducationalOrganization',
      name: entry.subtitle,
    })),
  };

  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    inLanguage: vm.locale,
    name: vm.documentTitle,
    mainEntity: prune(person),
  };
}

/** Sin esto el JSON-LD sale con claves vacías y `undefined` serializado a null. */
function prune(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '') continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return out;
}

/* ========================================================================== *
 * Marcado
 * ========================================================================== */

function renderEntries(section: VMSection): string {
  return section.entries
    .map((entry) => {
      const parts: string[] = ['<article class="entry">'];

      const title = entry.url
        ? `<a href="${escapeHtml(entry.url)}" rel="noopener">${escapeHtml(entry.title)}</a>`
        : escapeHtml(entry.title);
      parts.push('<div class="entry-head">');
      parts.push(`<h3>${title}</h3>`);
      if (entry.dateRange) parts.push(`<p class="date">${escapeHtml(entry.dateRange)}</p>`);
      parts.push('</div>');

      const subtitle = joinNonEmpty([entry.subtitle, entry.meta], INLINE_SEPARATOR);
      if (subtitle) parts.push(`<p class="subtitle">${escapeHtml(subtitle)}</p>`);

      if (entry.extraPositions.length > 0) {
        const positions = entry.extraPositions
          .map(
            (position) =>
              `<li>${escapeHtml(position.title)}<span class="date">${escapeHtml(position.dateRange)}</span></li>`,
          )
          .join('');
        parts.push(`<ul class="positions">${positions}</ul>`);
      }

      if (entry.summary) parts.push(`<p class="summary">${escapeHtml(entry.summary)}</p>`);

      if (entry.bullets.length > 0) {
        const bullets = entry.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('');
        parts.push(`<ul class="bullets">${bullets}</ul>`);
      }

      parts.push('</article>');
      return parts.join('\n');
    })
    .join('\n');
}

function renderSectionBody(section: VMSection): string {
  switch (section.kind) {
    case 'entries':
      return renderEntries(section);
    case 'skills':
      return `<dl class="skills">${section.groups
        .map(
          (group) =>
            `<dt>${escapeHtml(group.label)}</dt><dd>${escapeHtml(group.items.join(', '))}</dd>`,
        )
        .join('')}</dl>`;
    case 'inline-list':
      return `<ul class="inline-list">${section.items
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`;
    case 'text':
      return section.text ? `<p class="prose">${escapeHtml(section.text)}</p>` : '';
  }
}

const STYLESHEET = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --surface: #f6f7f9;
  --ink: #16181d;
  --ink-muted: #4a5058;
  --rule: #d9dde2;
  --accent: #1f3a5f;
  --measure: 46rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --surface: #1b1e24;
    --ink: #e6e9ed;
    --ink-muted: #a3aab3;
    --rule: #2c3138;
    --accent: #9dbbe4;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: clamp(1.5rem, 5vw, 3.5rem) 1.25rem 4rem;
  background: var(--bg);
  color: var(--ink);
  font: 400 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-variant-numeric: lining-nums tabular-nums;
}
.cv { max-width: var(--measure); margin: 0 auto; }
h1, h2, h3 { line-height: 1.2; margin: 0; font-weight: 600; }
h1 { font-size: clamp(1.9rem, 5vw, 2.4rem); letter-spacing: -0.01em; color: var(--accent); }
h2 {
  font-size: 0.95rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 1rem;
}
h3 { font-size: 1rem; }
p { margin: 0; }
a { color: inherit; text-decoration-color: var(--rule); text-underline-offset: 0.15em; }
a:hover { text-decoration-color: currentColor; }
ul { margin: 0; padding: 0; list-style: none; }

.cv-header { margin-bottom: 2.5rem; }
.headline { margin-top: 0.35rem; font-size: 1.05rem; color: var(--ink-muted); }
.contact, .links {
  display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem;
  margin-top: 0.9rem; font-size: 0.92rem; color: var(--ink-muted);
}
.links a { color: var(--accent); }

.section { margin-bottom: 2.25rem; }
.entry + .entry { margin-top: 1.5rem; }
.entry-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.25rem 1rem; }
.date { font-size: 0.85rem; color: var(--ink-muted); white-space: nowrap; }
.subtitle { margin-top: 0.15rem; color: var(--ink-muted); font-size: 0.95rem; }
.summary, .prose { margin-top: 0.6rem; }
.positions { margin-top: 0.4rem; font-size: 0.92rem; color: var(--ink-muted); }
.positions li { display: flex; justify-content: space-between; gap: 1rem; }
.bullets { margin-top: 0.7rem; }
.bullets li { position: relative; padding-left: 1.1rem; margin-top: 0.35rem; }
.bullets li::before { content: ""; position: absolute; left: 0.15rem; top: 0.62em; width: 0.3rem; height: 0.3rem; border-radius: 50%; background: var(--rule); }

.skills { display: grid; grid-template-columns: minmax(7rem, max-content) 1fr; gap: 0.4rem 1.25rem; margin: 0; }
.skills dt { font-weight: 600; }
.skills dd { margin: 0; }
.inline-list { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; }

.consent { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: 0.8rem; color: var(--ink-muted); }

@media (max-width: 32rem) {
  .skills { grid-template-columns: 1fr; gap: 0.15rem; }
  .skills dd { margin-bottom: 0.6rem; }
  .entry-head { display: block; }
  .date { display: block; margin-top: 0.15rem; }
}
@media print {
  body { padding: 0; background: #fff; color: #000; }
  a { text-decoration: none; }
}
`.trim();

export function renderHtml(viewModel: ViewModel): string {
  const vm = toPublicViewModel(viewModel);
  const description = findSection(vm, 'summary')?.text ?? vm.header.headline;

  const body: string[] = ['<main class="cv">', '<header class="cv-header">'];
  body.push(`<h1>${escapeHtml(vm.header.name)}</h1>`);
  if (vm.header.headline) body.push(`<p class="headline">${escapeHtml(vm.header.headline)}</p>`);

  if (vm.header.contactLines.length > 0) {
    const items = vm.header.contactLines
      .map((line) => {
        const value = line.trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          ? `<li><a href="mailto:${escapeHtml(value)}">${escapeHtml(value)}</a></li>`
          : `<li>${escapeHtml(value)}</li>`;
      })
      .join('');
    body.push(`<ul class="contact">${items}</ul>`);
  }

  if (vm.header.links.length > 0) {
    const items = vm.header.links
      .map(
        (link) =>
          `<li><a href="${escapeHtml(link.href)}" rel="me noopener">${escapeHtml(link.text)}</a></li>`,
      )
      .join('');
    body.push(`<ul class="links">${items}</ul>`);
  }
  body.push('</header>');

  for (const section of vm.sections) {
    if (!hasContent(section)) continue;
    body.push(`<section class="section" id="section-${section.name}">`);
    body.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    body.push(renderSectionBody(section));
    body.push('</section>');
  }

  if (vm.consentClause) body.push(`<p class="consent">${escapeHtml(vm.consentClause)}</p>`);
  body.push('</main>');

  return `<!doctype html>
<html lang="${escapeHtml(vm.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(vm.documentTitle)}</title>
<meta name="description" content="${escapeHtml(description ?? '')}">
<meta name="author" content="${escapeHtml(vm.meta.author)}">
<style>
${STYLESHEET}
</style>
<script type="application/ld+json">
${embedJson(buildJsonLd(vm))}
</script>
</head>
<body>
${body.join('\n')}
<script type="application/json" id="cv-model">
${embedJson(vm)}
</script>
</body>
</html>
`;
}

export const htmlRenderer: Renderer = {
  format: 'html',
  extension: 'html',
  async render(vm: ViewModel): Promise<RenderResult> {
    return { format: 'html', content: renderHtml(vm), extension: 'html' };
  },
};
