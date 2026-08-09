import { compareFlexDates } from '../core/schema/refine.ts';
import type {
  RenderResult,
  Renderer,
  ResolvedCV,
  ResolvedEducation,
  ResolvedWork,
} from '../core/types.ts';

/**
 * Proyección al schema oficial de JSON Resume v1.3.1.
 *
 * Es el formato de INTERCAMBIO, no el modelo interno: existe para que el CV
 * entre en el ecosistema de terceros (resume-cli, themes, conversores) sin que
 * el modelo propio herede las limitaciones del oficial (cero campos requeridos,
 * sin ids, sin i18n, sin variantes, fechas que aceptan 2024-02-31).
 *
 * Tres reglas que no son negociables:
 *
 * 1. Las extensiones propias van SÓLO a nivel de ítem (`x-id`, `x-tags`, …) o
 *    dentro de `meta`. PROHIBIDO un bloque raíz `x-cv`: falla contra el schema
 *    v1.0.0 draft-04 que SchemaStore bindea solo en el editor por el nombre del
 *    archivo, que tiene `additionalProperties: false` en la raíz.
 * 2. STRIP obligatorio de claves `null` y de string vacío antes de serializar.
 *    `endDate: ""` y `endDate: null` fallan la validación oficial, y en YAML un
 *    `endDate:` sin valor produce `null`. Es el caso del 100 % de los CVs de
 *    gente que está empleada.
 * 3. Las `positions[]` del modelo propio (que modelan promociones sin duplicar
 *    el empleador) se aplanan en entradas `work[]` del formato oficial, que no
 *    tiene ese nivel. El resumen y los logros quedan colgados de la posición
 *    más reciente, no repetidos en cada una.
 *
 * Se proyecta desde el `ResolvedCV` y no desde el `ViewModel` a propósito: el
 * ViewModel ya convirtió las fechas al patrón del mercado ("March 2022") y el
 * schema oficial exige ISO. Volver a parsear una fecha ya localizada es
 * exactamente el error que este pipeline existe para no cometer.
 */

const SCHEMA_VERSION = '1.3.1';

type JsonObject = Record<string, unknown>;

/**
 * Elimina recursivamente `null`, `undefined`, strings vacíos, arrays vacíos y
 * objetos que quedaron sin claves. `false` y `0` sobreviven: son valores.
 */
function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(stripEmpty).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      const cleaned = stripEmpty(item);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/**
 * `location` es un string ya compuesto en el modelo resuelto y un objeto en el
 * oficial. Se separa por comas: el último tramo de dos mayúsculas es el país.
 */
function splitLocation(value: string): JsonObject | undefined {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;

  const last = parts[parts.length - 1]!;
  const countryCode = /^[A-Z]{2}$/.test(last) ? parts.pop() : undefined;
  const city = parts.shift();
  const region = parts.length > 0 ? parts.join(', ') : undefined;
  return { city, region, countryCode };
}

/** Índice de la posición vigente o, si no hay, la de comienzo más reciente. */
function anchorPosition(entry: ResolvedWork): number {
  let anchor = 0;
  entry.positions.forEach((position, index) => {
    const best = entry.positions[anchor]!;
    if (position.current && !best.current) anchor = index;
    else if (
      position.current === best.current &&
      compareFlexDates(position.startDate, best.startDate) > 0
    ) {
      anchor = index;
    }
  });
  return anchor;
}

function toWork(entry: ResolvedWork): JsonObject[] {
  const anchor = anchorPosition(entry);
  const tags = [...new Set(entry.bullets.flatMap((bullet) => bullet.tags))];
  const highlights = entry.bullets.map((bullet) => bullet.text);

  return entry.positions.map((position, index) => ({
    name: entry.company,
    position: position.title,
    url: entry.companyUrl,
    location: entry.location,
    // `description` en el schema oficial describe a qué se dedica la empresa.
    description: entry.industry,
    startDate: position.startDate,
    endDate: position.current ? undefined : position.endDate,
    summary: index === anchor ? entry.summary : undefined,
    highlights: index === anchor ? highlights : undefined,
    'x-id': position.id,
    'x-employer-id': entry.id,
    'x-current': position.current ? true : undefined,
    'x-tags': index === anchor ? tags : undefined,
  }));
}

function toEducation(entry: ResolvedEducation): JsonObject {
  return {
    institution: entry.institution,
    area: entry.area,
    studyType: entry.studyType,
    startDate: entry.startDate,
    endDate: entry.current ? undefined : entry.endDate,
    score: entry.score,
    courses: entry.courses,
    'x-id': entry.id,
    'x-current': entry.current ? true : undefined,
  };
}

export function toJsonResume(cv: ResolvedCV): JsonObject {
  const { contact } = cv;

  /** El alias que usa la vacante le gana al canónico: varios ATS no resuelven que son lo mismo. */
  const preferred = (name: string, id: string): string =>
    cv.preferredAliases[name] ?? cv.preferredAliases[id] ?? name;

  const document: JsonObject = {
    basics: {
      name: contact.name,
      label: contact.label,
      email: contact.email,
      phone: contact.phone,
      url: contact.url,
      summary: contact.summary,
      location: splitLocation(contact.location),
      profiles: contact.profiles.map((profile) => ({
        network: profile.network,
        username: profile.display,
        url: profile.url,
        'x-id': profile.id,
      })),
    },
    work: cv.work.flatMap(toWork),
    education: cv.education.map(toEducation),
    certificates: cv.certificates.map((certificate) => ({
      name: certificate.name,
      date: certificate.date,
      issuer: certificate.issuer,
      url: certificate.url,
      'x-id': certificate.id,
      'x-expires-at': certificate.expiresAt,
      'x-credential-id': certificate.credentialId,
    })),
    awards: cv.awards.map((award) => ({
      title: award.title,
      date: award.date,
      awarder: award.awarder,
      summary: award.summary,
      'x-id': award.id,
    })),
    publications: cv.publications.map((publication) => ({
      // El modelo guarda CSL-JSON y el ViewModel ya resolvió el estilo de cita;
      // el schema oficial sólo tiene un campo de texto donde ponerla.
      name: publication.citation,
      url: publication.url,
      'x-id': publication.id,
      'x-doi': publication.doi,
    })),
    skills: cv.skills.flatMap((group) =>
      group.items.map((item) => ({
        name: preferred(item.name, item.id),
        level: item.level,
        keywords: item.keywords,
        'x-id': item.id,
        'x-category': group.category,
      })),
    ),
    languages: cv.languages.map((language) => ({
      language: language.language,
      fluency: language.fluency,
      'x-id': language.id,
    })),
    projects: cv.projects.map((project) => ({
      name: project.name,
      description: project.description,
      highlights: project.highlights.map((highlight) => highlight.text),
      keywords: project.keywords,
      startDate: project.startDate,
      endDate: project.endDate,
      url: project.url,
      'x-id': project.id,
    })),
    // Sólo iniciales y rol: los datos de contacto de un tercero tienen otra
    // base legal bajo GDPR y Ley 25.326 y no viven en este repositorio.
    references: cv.references.map((reference) => ({
      name: reference.initials,
      reference: [reference.role, reference.company].filter(Boolean).join(', '),
      'x-id': reference.id,
    })),
    meta: {
      // `meta.version` del schema oficial versiona el CV, no el schema; sin un
      // valor propio que poner ahí, la versión del schema va como extensión.
      'x-schema-version': SCHEMA_VERSION,
      'x-generator': 'cv-workspace',
      'x-person': cv.personSlug,
      'x-locale': cv.locale,
      'x-document-type': cv.config.documentType,
      'x-target-role': cv.targetRole,
      'x-section-order': cv.sectionOrder,
    },
  };

  return (stripEmpty(document) ?? {}) as JsonObject;
}

export function renderJsonResume(cv: ResolvedCV): string {
  return `${JSON.stringify(toJsonResume(cv), null, 2)}\n`;
}

/**
 * El renderer se construye atado al `ResolvedCV` porque el `ViewModel` que
 * recibe `render()` ya no tiene ni las fechas ISO ni los ids que el schema
 * oficial necesita. El registro de `index.ts` es el que lo instancia.
 */
export function createJsonResumeRenderer(cv: ResolvedCV): Renderer {
  return {
    format: 'jsonresume',
    extension: 'json',
    async render(): Promise<RenderResult> {
      return { format: 'jsonresume', content: renderJsonResume(cv), extension: 'json' };
    },
  };
}

/**
 * Variante que cumple la interfaz uniforme de renderer.
 *
 * A diferencia del resto de los formatos, éste no puede trabajar sólo con el
 * ViewModel: el schema oficial pide fechas ISO e ids que la etapa de
 * presentación ya convirtió en texto. Los recibe entonces por opciones, que es
 * lo que permite que el registro de renderers siga siendo homogéneo en vez de
 * tener este formato como caso especial.
 */
export const jsonResumeRenderer: Renderer = {
  format: 'jsonresume',
  extension: 'json',
  async render(_vm, opts): Promise<RenderResult> {
    const cv = (opts as { resolved?: ResolvedCV } | undefined)?.resolved;
    if (!cv) {
      throw new Error(
        'El renderer de JSON Resume necesita el ResolvedCV en las opciones (opts.resolved): ' +
          'el ViewModel ya no conserva las fechas ISO ni los ids que exige el schema oficial.',
      );
    }
    return { format: 'jsonresume', content: renderJsonResume(cv), extension: 'json' };
  },
};
