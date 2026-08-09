import path from 'node:path';
import { PersonProfile } from './schema/sections.ts';
import { CvDataError, formatIssues, isRecord, style } from './load.ts';
import type { LoadedPerson } from './types.ts';

/**
 * Resolución de i18n: superpone la narrativa de un locale sobre el perfil
 * redactado en el locale primario.
 *
 * Dos reglas gobiernan este archivo:
 *
 * 1. La resolución es POR ID, nunca por posición. Agregar un bullet al medio de
 *    una lista no puede desplazar las traducciones de los demás.
 *
 * 2. No hay fallback silencioso. Si falta la traducción de un ítem que existe en
 *    el perfil, el build falla diciendo id y campo. Un CV a medio traducir —con
 *    tres bullets en inglés y uno en español— es peor que uno que no compila:
 *    el que falla se arregla, el mixto se manda.
 */

/* ========================================================================== *
 * Qué se traduce y qué no
 * ========================================================================== */

/**
 * Campos narrativos: si el perfil primario tiene contenido, el locale objetivo
 * DEBE traerlo traducido.
 *
 * Fuera de esta lista quedan, por definición, los hechos: nombres de empresa e
 * institución, URLs, fechas, keywords técnicas, credenciales e ids. Traducirlos
 * no es localizar, es alterar el dato.
 */
const NARRATIVE = {
  basics: ['label', 'summary'],
  work: ['summary'],
  position: ['title'],
  bullet: ['outcome', 'method'],
  education: ['area', 'studyType'],
  project: ['description'],
  award: ['summary'],
} as const;

/**
 * Campos que se imprimen pero cuya traducción es OPCIONAL, porque muchas veces
 * el valor es un nombre propio que no se traduce.
 *
 * El criterio para entrar acá es simple: si el lector del CV lo ve, tiene que
 * poder localizarse. "Certified Kubernetes Administrator" se deja igual en
 * cualquier idioma, pero "Fundamentos de seguridad en aplicaciones" no; lo
 * mismo con `skills[].category`, que se imprime como encabezado del grupo
 * ("Lenguajes" / "Languages"), o con `languages[].language`, donde dejar
 * "Español" en un CV en inglés es un error visible.
 *
 * Son opcionales y no narrativos: exigirlos obligaría a repetir en cada locale
 * decenas de valores que no cambian.
 */
const OPTIONAL_TRANSLATIONS = {
  education: ['courses'],
  project: ['name', 'roles', 'entity', 'type'],
  award: ['title'],
  skill: ['canonical', 'category', 'aliases', 'keywords'],
  certificate: ['name', 'issuer'],
  reference: ['role', 'relationship', 'company'],
  language: ['language'],
} as const;

/**
 * Campos con valor de enumeración (`skills[].level`, `languages[].fluency`).
 *
 * Su valor canónico ya es neutral respecto del idioma —`advanced`, `C1`— y el
 * texto visible lo resuelve la etapa ViewModel según el locale. Por eso el
 * override acá es OPCIONAL: exigirlo obligaría a repetir la enumeración en cada
 * archivo de i18n sin ganar nada. Si igual se declara, tiene que ser un valor
 * válido del enum o el parseo final lo rechaza.
 */
const ENUM_OVERRIDES = {
  skill: ['level'],
  language: ['fluency'],
} as const;

type Problems = {
  missing: Array<{ id: string; field: string }>;
  unknownId: string[];
  unknownField: Array<{ id: string; field: string }>;
};

type Entry = Record<string, unknown>;

function hasContent(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function mutable(value: object): Entry {
  return value as unknown as Entry;
}

function reportUnknownFields(
  entry: Entry,
  allowed: ReadonlySet<string>,
  id: string,
  problems: Problems,
): void {
  for (const field of Object.keys(entry)) {
    if (!allowed.has(field)) problems.unknownField.push({ id, field });
  }
}

/**
 * Copia los campos narrativos declarados y anota los que faltan.
 * Agregar narrativa que el locale primario no tiene es legítimo (un mercado
 * puede pedir un summary más largo); omitir la que sí tiene, no.
 */
function applyNarrative(
  entry: Entry,
  target: Entry,
  fields: readonly string[],
  id: string,
  problems: Problems,
): void {
  for (const field of fields) {
    const translated = entry[field];
    if (translated === undefined) {
      if (hasContent(target[field])) problems.missing.push({ id, field });
      continue;
    }
    target[field] = translated;
  }
}

function applyOptional(entry: Entry, target: Entry, fields: readonly string[]): void {
  for (const field of fields) {
    const translated = entry[field];
    if (translated !== undefined) target[field] = translated;
  }
}

/** Un bullet trae outcome, method y las variantes de longitud que usa el fit-loop. */
function applyBullet(entry: Entry, bullet: Entry, id: string, problems: Problems): void {
  reportUnknownFields(entry, new Set(['outcome', 'method', 'variants']), id, problems);
  applyNarrative(entry, bullet, NARRATIVE.bullet, id, problems);

  const original = isRecord(bullet['variants']) ? bullet['variants'] : undefined;
  const translated = entry['variants'];
  if (translated === undefined) {
    if (original !== undefined) {
      for (const key of ['short', 'long']) {
        if (hasContent(original[key])) problems.missing.push({ id, field: `variants.${key}` });
      }
    }
    return;
  }
  if (!isRecord(translated)) {
    // Forma inválida: se deja pasar para que el parseo final la reporte con path exacto.
    bullet['variants'] = translated;
    return;
  }
  reportUnknownFields(translated, new Set(['short', 'long']), `${id}.variants`, problems);
  const merged: Entry = {};
  for (const key of ['short', 'long']) {
    const value = translated[key];
    if (value !== undefined) {
      merged[key] = value;
      continue;
    }
    if (original !== undefined && hasContent(original[key])) {
      problems.missing.push({ id, field: `variants.${key}` });
    }
  }
  bullet['variants'] = merged;
}

/**
 * Aplica un sub-mapa indexado por id (positions, bullets, highlights).
 * Un ítem sin entrada se procesa igual, con un mapa vacío: así el reporte de lo
 * que falta sale del mismo código que la aplicación, y no puede desincronizarse.
 */
function applyById(
  container: unknown,
  items: ReadonlyArray<{ id: string }>,
  parentId: string,
  bucket: string,
  problems: Problems,
  apply: (entry: Entry, item: Entry, id: string) => void,
): void {
  const table = isRecord(container) ? container : {};
  const seen = new Set<string>();
  for (const item of items) {
    const entry = table[item.id];
    if (entry !== undefined) {
      seen.add(item.id);
      if (!isRecord(entry)) {
        problems.unknownField.push({ id: item.id, field: '(se esperaba un mapeo de campos)' });
        continue;
      }
    }
    apply(isRecord(entry) ? entry : {}, mutable(item), item.id);
  }
  for (const key of Object.keys(table)) {
    if (!seen.has(key)) problems.unknownId.push(`${parentId}.${bucket}.${key}`);
  }
}

function describe(problems: Problems, label: string): string {
  const blocks: string[] = [];
  if (problems.missing.length > 0) {
    const lines = [
      `${style.error('✖')} ${style.file(label)} — faltan ${problems.missing.length} traducciones`,
    ];
    for (const item of problems.missing) {
      lines.push(`  ${style.error('✖')} ${style.key(item.id)} · ${item.field}`);
    }
    lines.push(
      `      ${style.hint('Traducí esas claves o sacá el ítem del perfil: un CV a medio traducir se manda sin que nadie lo note.')}`,
    );
    blocks.push(lines.join('\n'));
  }
  if (problems.unknownId.length > 0) {
    const lines = [
      `${style.error('✖')} ${style.file(label)} — ${problems.unknownId.length} claves no corresponden a ningún id del perfil`,
    ];
    for (const id of problems.unknownId) lines.push(`  ${style.error('✖')} ${style.key(id)}`);
    lines.push(
      `      ${style.hint('La resolución es por id, no por posición: revisá la ortografía del id contra profile/.')}`,
    );
    blocks.push(lines.join('\n'));
  }
  if (problems.unknownField.length > 0) {
    const lines = [
      `${style.error('✖')} ${style.file(label)} — ${problems.unknownField.length} campos desconocidos`,
    ];
    for (const item of problems.unknownField) {
      lines.push(`  ${style.error('✖')} ${style.key(item.id)} · ${item.field}`);
    }
    lines.push(
      `      ${style.hint('Sólo se traduce narrativa. Empresas, URLs, fechas, keywords e ids se declaran una sola vez en profile/.')}`,
    );
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/* ========================================================================== *
 * API
 * ========================================================================== */

/**
 * Devuelve el perfil con la narrativa del locale objetivo aplicada.
 *
 * `i18n` es el mapa `locale → (id → narrativa)` que arma `loadPerson`. Cuando el
 * locale objetivo es el primario no hay nada que resolver y el perfil vuelve tal
 * cual, sin copiarse.
 */
export function applyLocale(
  profile: PersonProfile,
  i18n: Record<string, Record<string, unknown>>,
  targetLocale: string,
  primaryLocale: string,
): PersonProfile {
  if (targetLocale === primaryLocale) return profile;

  const label = path.join('i18n', `${targetLocale}.yaml`);
  const table = i18n[targetLocale];
  if (table === undefined) {
    throw new CvDataError(
      `${style.error('✖')} No hay narrativa para el locale "${targetLocale}".\n      ${style.hint(`Creá ${label}, declaralo en meta.locales, o generá el CV en "${primaryLocale}".`)}`,
    );
  }

  const draft = structuredClone(profile);
  const problems: Problems = { missing: [], unknownId: [], unknownField: [] };
  const consumed = new Set<string>();

  const take = (id: string): Entry => {
    const entry = table[id];
    if (entry === undefined) return {};
    consumed.add(id);
    if (isRecord(entry)) return entry;
    problems.unknownField.push({ id, field: '(se esperaba un mapeo de campos)' });
    return {};
  };

  const basicsEntry = take('basics');
  reportUnknownFields(basicsEntry, new Set(NARRATIVE.basics), 'basics', problems);
  applyNarrative(basicsEntry, mutable(draft.basics), NARRATIVE.basics, 'basics', problems);

  for (const work of draft.work) {
    const entry = take(work.id);
    reportUnknownFields(entry, new Set(['summary', 'positions', 'bullets']), work.id, problems);
    applyNarrative(entry, mutable(work), NARRATIVE.work, work.id, problems);
    applyById(
      entry['positions'],
      work.positions,
      work.id,
      'positions',
      problems,
      (positionEntry, position, id) => {
        reportUnknownFields(positionEntry, new Set(NARRATIVE.position), id, problems);
        applyNarrative(positionEntry, position, NARRATIVE.position, id, problems);
      },
    );
    applyById(entry['bullets'], work.bullets, work.id, 'bullets', problems, (bulletEntry, bullet, id) =>
      applyBullet(bulletEntry, bullet, id, problems),
    );
  }

  for (const education of draft.education) {
    const entry = take(education.id);
    reportUnknownFields(
      entry,
      new Set([...NARRATIVE.education, ...OPTIONAL_TRANSLATIONS.education]),
      education.id,
      problems,
    );
    applyNarrative(entry, mutable(education), NARRATIVE.education, education.id, problems);
    applyOptional(entry, mutable(education), OPTIONAL_TRANSLATIONS.education);
  }

  for (const project of draft.projects) {
    const entry = take(project.id);
    reportUnknownFields(
      entry,
      new Set(['description', 'highlights', ...OPTIONAL_TRANSLATIONS.project]),
      project.id,
      problems,
    );
    applyNarrative(entry, mutable(project), NARRATIVE.project, project.id, problems);
    applyOptional(entry, mutable(project), OPTIONAL_TRANSLATIONS.project);
    // Los highlights son bullets impresos: si quedan en el locale primario el CV
    // sale mezclado igual que si faltara la traducción de un bullet de work.
    applyById(
      entry['highlights'],
      project.highlights,
      project.id,
      'highlights',
      problems,
      (highlightEntry, highlight, id) => applyBullet(highlightEntry, highlight, id, problems),
    );
  }

  for (const award of draft.awards) {
    const entry = take(award.id);
    reportUnknownFields(
      entry,
      new Set([...NARRATIVE.award, ...OPTIONAL_TRANSLATIONS.award]),
      award.id,
      problems,
    );
    applyNarrative(entry, mutable(award), NARRATIVE.award, award.id, problems);
    applyOptional(entry, mutable(award), OPTIONAL_TRANSLATIONS.award);
  }

  for (const skill of draft.skills) {
    const entry = take(skill.id);
    const allowed = [...ENUM_OVERRIDES.skill, ...OPTIONAL_TRANSLATIONS.skill];
    reportUnknownFields(entry, new Set(allowed), skill.id, problems);
    applyOptional(entry, mutable(skill), allowed);
  }

  for (const language of draft.languages) {
    const entry = take(language.id);
    const allowed = [...ENUM_OVERRIDES.language, ...OPTIONAL_TRANSLATIONS.language];
    reportUnknownFields(entry, new Set(allowed), language.id, problems);
    applyOptional(entry, mutable(language), allowed);
  }

  for (const certificate of draft.certificates) {
    const entry = take(certificate.id);
    reportUnknownFields(entry, new Set(OPTIONAL_TRANSLATIONS.certificate), certificate.id, problems);
    applyOptional(entry, mutable(certificate), OPTIONAL_TRANSLATIONS.certificate);
  }

  for (const reference of draft.references) {
    const entry = take(reference.id);
    reportUnknownFields(entry, new Set(OPTIONAL_TRANSLATIONS.reference), reference.id, problems);
    applyOptional(entry, mutable(reference), OPTIONAL_TRANSLATIONS.reference);
  }

  // `eligibility` no es una lista de ítems con id, así que no entra en el
  // recorrido general. Lo único localizable son los nombres de región a los que
  // la persona se mudaría; el resto son enums y códigos ISO.
  if (draft.eligibility?.relocation) {
    const entry = take('eligibility');
    const relocation = isRecord(entry['relocation']) ? entry['relocation'] : undefined;
    reportUnknownFields(entry, new Set(['relocation']), 'eligibility', problems);
    if (Array.isArray(relocation?.['regions'])) {
      draft.eligibility.relocation.regions = relocation['regions'] as string[];
    }
  }

  for (const id of Object.keys(table)) {
    if (!consumed.has(id)) problems.unknownId.push(id);
  }

  if (
    problems.missing.length > 0 ||
    problems.unknownId.length > 0 ||
    problems.unknownField.length > 0
  ) {
    throw new CvDataError(describe(problems, label));
  }

  const parsed = PersonProfile.safeParse(draft);
  if (!parsed.success) {
    const note = `      ${style.hint('skills[].level y languages[].fluency son enumeraciones (advanced, C1): su texto visible lo resuelve el renderer según el locale, no i18n/.')}`;
    throw new CvDataError(
      `${formatIssues(parsed.error.issues, label, undefined, PersonProfile)}\n${note}`,
    );
  }
  return parsed.data;
}

/**
 * Envoltorio sobre `applyLocale` para quien ya tiene la persona cargada.
 *
 * `LoadedPerson` trae el perfil, la tabla de i18n y el locale primario juntos,
 * así que exigir que quien llama los desarme sólo para volver a pasarlos es
 * ruido. Ésta es la forma que usa el CLI.
 */
export function localizeProfile(person: LoadedPerson, targetLocale: string): PersonProfile {
  return applyLocale(person.profile, person.i18n, targetLocale, person.profile.meta.primaryLocale);
}
