import type { LintFinding, LintReport, ResolvedCV, ViewModel } from '../core/types.ts';
import type { PersonProfile } from '../core/schema/sections.ts';
import type { ResolvedProfileConfig } from '../core/schema/config.ts';
import { refineProfile, type Issue } from '../core/schema/refine.ts';

/**
 * Lint del modelo de datos (ATS-080..089).
 *
 * Todo lo que se verifica acá se verifica ANTES de renderizar nada. Un id
 * duplicado, una fecha imposible o una traducción faltante tienen que romper el
 * build, no el PDF que ya está en la bandeja del reclutador.
 */

/* ========================================================================== *
 * Diccionarios y umbrales
 * ========================================================================== */

/** Abreviaturas que ningún parser resuelve contra el título canónico de la vacante. */
const TITLE_ABBREVIATIONS: Array<{ pattern: RegExp; expanded: string }> = [
  { pattern: /\bsr\.?\b/i, expanded: 'Senior' },
  { pattern: /\bjr\.?\b/i, expanded: 'Junior' },
  { pattern: /\bssr\.?\b/i, expanded: 'Semi Senior' },
  { pattern: /\bsw\b/i, expanded: 'Software' },
  { pattern: /\beng\.?\b/i, expanded: 'Engineer' },
  { pattern: /\bmgr\.?\b/i, expanded: 'Manager' },
  { pattern: /\bmgmt\.?\b/i, expanded: 'Management' },
  { pattern: /\bdev\.?\b/i, expanded: 'Developer' },
  { pattern: /\bassoc\.?\b/i, expanded: 'Associate' },
  { pattern: /\bcoord\.?\b/i, expanded: 'Coordinator' },
  { pattern: /\badmin\.?\b/i, expanded: 'Administrator' },
  { pattern: /\bsys\.?\b/i, expanded: 'Systems' },
  { pattern: /\bqa\b/i, expanded: 'Quality Assurance (QA)' },
];

/** Sufijos societarios de los mercados que cubren los perfiles regionales. */
const LEGAL_SUFFIXES =
  /(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|co\.|company|s\.?a\.?(\.?s|\.?u)?|s\.?l\.?|s\.?r\.?l\.?|gmbh|ag|b\.?v\.?|n\.?v\.?|plc|oy|ab|a\/s|pty|sas|sarl|kft|sp\.? z o\.?o\.?|s\.?p\.?a\.?)$/i;

const BULLETS_PER_ROLE = { min: 3, max: 6 };
const WORDS_PER_BULLET = { min: 15, max: 30 };
const TOTAL_WORDS = { min: 400, max: 1600 };
const MIN_MEASURED_ANCHORS = 2;

/* ========================================================================== *
 * Utilidades
 * ========================================================================== */

function countWords(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

/** Junta todos los strings que aparecen como clave en un objeto anidado. */
function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
}

/** Todos los ids declarados en el perfil, para resolver referencias de overlays. */
export function profileIds(profile: PersonProfile): Set<string> {
  const ids = new Set<string>();
  for (const entry of profile.work) {
    ids.add(entry.id);
    for (const position of entry.positions) ids.add(position.id);
    for (const bullet of entry.bullets) ids.add(bullet.id);
  }
  for (const project of profile.projects) {
    ids.add(project.id);
    for (const highlight of project.highlights) ids.add(highlight.id);
  }
  for (const list of [
    profile.education,
    profile.skills,
    profile.certificates,
    profile.awards,
    profile.languages,
    profile.publications,
    profile.references,
  ]) {
    for (const item of list as Array<{ id: string }>) ids.add(item.id);
  }
  for (const item of profile.basics.profiles) ids.add(item.id);
  return ids;
}

function resolvePath(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const segment of dotted.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function issueToFinding(issue: Issue): LintFinding {
  return {
    rule: issue.rule,
    severity: issue.severity,
    message: issue.message,
    where: issue.path,
    fix: 'Corregí el YAML de profile/ en ese path exacto.',
  };
}

/* ========================================================================== *
 * Entrada pública
 * ========================================================================== */

export type DataLintInput = {
  profile: PersonProfile;
  /** Los hechos ya seleccionados, si el lint corre después del select. */
  resolved?: ResolvedCV;
  /** El ViewModel, para contar sobre lo que realmente se imprime. */
  vm?: ViewModel;
  config?: ResolvedProfileConfig;
  /** Locale objetivo; si difiere del primario se exige narrativa traducida. */
  locale?: string;
  /** Narrativa por locale, indexada por id (LoadedPerson.i18n). */
  i18n?: Record<string, Record<string, unknown>>;
  /** Ids que un target u overlay referencia y que tienen que existir. */
  referencedIds?: string[];
};

export function lintData(input: DataLintInput): LintReport {
  const findings: LintFinding[] = [];
  const { profile, resolved, vm, config, locale, i18n = {}, referencedIds = [] } = input;

  /* ── ATS-080 / ATS-081 ────────────────────────────────────────────────── */
  findings.push(...refineProfile(profile).map(issueToFinding));

  /* ── ATS-082 — toda referencia resuelve ───────────────────────────────── */
  const known = profileIds(profile);
  for (const id of referencedIds) {
    if (!known.has(id)) {
      findings.push({
        rule: 'ATS-082',
        severity: 'error',
        message: `El id "${id}" está referenciado en el target u overlay y no existe en el perfil.`,
        where: `overlay → ${id}`,
        fix: 'Un id referenciado y ausente falla el build, no el PDF impreso. Revisá si lo renombraste en profile/.',
      });
    }
  }

  /* ── ATS-083 — narrativa en el locale objetivo ────────────────────────── */
  const primaryLocale = profile.meta.primaryLocale;
  if (locale && locale !== primaryLocale) {
    const bundle = i18n[locale];
    if (!bundle) {
      findings.push({
        rule: 'ATS-083',
        severity: 'error',
        message: `No hay i18n/${locale}.yaml y el CV se pidió en "${locale}" (el locale primario es "${primaryLocale}").`,
        where: `i18n/${locale}.yaml`,
        fix: 'Sin fallback silencioso: un CV a medio traducir es peor que uno en el idioma equivocado.',
      });
    } else {
      const translated = new Set<string>();
      collectKeys(bundle, translated);
      const selected = resolved
        ? [
            ...resolved.work.map((entry) => entry.id),
            ...resolved.work.flatMap((entry) => entry.bullets.map((bullet) => bullet.id)),
            ...resolved.education.map((entry) => entry.id),
            ...resolved.projects.map((entry) => entry.id),
          ]
        : [...known];
      const untranslated = selected.filter((id) => !translated.has(id));
      if (untranslated.length > 0) {
        findings.push({
          rule: 'ATS-083',
          severity: 'error',
          message: `Faltan traducciones al locale "${locale}" para ${untranslated.length} ids incluidos: ${untranslated.slice(0, 12).join(', ')}${untranslated.length > 12 ? ' …' : ''}`,
          where: `i18n/${locale}.yaml`,
          fix: 'Agregá el bloque de esos ids. Los campos narrativos traducibles son label, summary, title, area, studyType, level y fluency; nunca empresas, fechas, URLs ni keywords técnicas.',
        });
      }
    }
  }

  /* ── ATS-084 — campos prohibidos por el perfil regional ───────────────── */
  for (const forbidden of config?.forbiddenFields ?? []) {
    const value = resolvePath(profile, forbidden.field) ?? resolvePath(profile.basics, forbidden.field);
    const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
    if (present) {
      findings.push({
        rule: 'ATS-084',
        severity: 'error',
        message: `El campo "${forbidden.field}" está presente y el perfil regional lo prohíbe: ${forbidden.reason} (fuente: ${forbidden.source}).`,
        where: `profile → ${forbidden.field}`,
        fix: 'El campo no se suprime en silencio a propósito: la convención del mercado hay que conocerla, no esquivarla.',
      });
    }
  }

  /* ── ATS-085 — títulos sin abreviaturas ───────────────────────────────── */
  const titles: Array<{ id: string; title: string }> = resolved
    ? resolved.work.flatMap((entry) => entry.positions.map((position) => ({ id: position.id, title: position.title })))
    : profile.work.flatMap((entry) => entry.positions.map((position) => ({ id: position.id, title: position.title })));

  for (const { id, title } of titles) {
    for (const abbreviation of TITLE_ABBREVIATIONS) {
      if (abbreviation.pattern.test(title)) {
        findings.push({
          rule: 'ATS-085',
          severity: 'warning',
          message: `El cargo "${title}" usa una abreviatura. Escribilo completo: "${abbreviation.expanded}".`,
          where: `positions:${id}`,
          fix: 'La búsqueda booleana del reclutador se hace con el término completo; ningún ATS resuelve "Sr. SW Eng" contra "Senior Software Engineer".',
        });
        break;
      }
    }
  }

  /* ── ATS-086 — sufijo legal de la empresa ─────────────────────────────── */
  const companies = resolved
    ? resolved.work.map((entry) => ({ id: entry.id, name: entry.company }))
    : profile.work.map((entry) => ({ id: entry.id, name: entry.company.name }));

  for (const company of companies) {
    if (!LEGAL_SUFFIXES.test(company.name.trim())) {
      findings.push({
        rule: 'ATS-086',
        severity: 'warning',
        message: `"${company.name}" no lleva sufijo societario. Varios ATS parsean peor el nombre de la empresa sin él.`,
        where: `work:${company.id}`,
        fix: 'Si la empresa lo tiene, escribilo: "Acme Corporation Inc.", "Globex S.A.". Si no lo tiene, ignorá este aviso.',
      });
    }
  }

  /* ── ATS-087 — consistencia estructural entre entradas ────────────────── */
  if (profile.work.length > 1) {
    const keySets = profile.work.map((entry) => new Set(Object.keys(entry)));
    const union = new Set<string>();
    for (const keys of keySets) for (const key of keys) union.add(key);
    profile.work.forEach((entry, index) => {
      const missing = [...union].filter((key) => !keySets[index]?.has(key));
      if (missing.length > 0) {
        findings.push({
          rule: 'ATS-087',
          severity: 'warning',
          message: `La entrada "${entry.id}" no declara ${missing.join(', ')} y el resto de las entradas sí. Las entradas irregulares hacen que el parser infiera mal dónde termina una y empieza la otra.`,
          where: `work:${entry.id}`,
          fix: 'Mantené el mismo conjunto de campos en todas las entradas de experiencia.',
        });
      }
    });
  }

  /* ── ATS-088 — presupuesto de contenido ───────────────────────────────── */
  const roles = vm
    ? vm.sections
        .filter((section) => section.name === 'work')
        .flatMap((section) => section.entries.map((entry) => ({ id: entry.id, bullets: entry.bullets })))
    : (resolved ?? { work: profile.work }).work.map((entry) => ({
        id: entry.id,
        bullets: entry.bullets.map((bullet) => ('text' in bullet ? bullet.text : `${bullet.outcome} ${bullet.method ?? ''}`)),
      }));

  for (const role of roles) {
    if (role.bullets.length < BULLETS_PER_ROLE.min || role.bullets.length > BULLETS_PER_ROLE.max) {
      findings.push({
        rule: 'ATS-088',
        severity: 'warning',
        message: `"${role.id}" tiene ${role.bullets.length} bullets; el rango es ${BULLETS_PER_ROLE.min}-${BULLETS_PER_ROLE.max}.`,
        where: `work:${role.id}`,
        fix: 'El reclutador escanea en 6-7 segundos y rara vez pasa del tercer bullet: el más relevante para la vacante va primero, no el cronológicamente primero.',
      });
    }
    role.bullets.forEach((bullet, index) => {
      const words = countWords(bullet);
      if (words < WORDS_PER_BULLET.min || words > WORDS_PER_BULLET.max) {
        findings.push({
          rule: 'ATS-088',
          severity: 'warning',
          message: `Bullet ${index + 1} de "${role.id}": ${words} palabras (objetivo ${WORDS_PER_BULLET.min}-${WORDS_PER_BULLET.max}, es decir 1-2 líneas).`,
          where: `work:${role.id}#${index + 1}`,
          fix: words < WORDS_PER_BULLET.min ? 'Falta el método o el resultado: la fórmula es outcome + métrica + método.' : 'Usá la variante `short` del bullet.',
        });
      }
    });
  }

  const totalWords = vm
    ? vm.sections.reduce((sum, section) => {
        const fromEntries = section.entries.reduce(
          (entrySum, entry) => entrySum + countWords(entry.summary ?? '') + entry.bullets.reduce((b, bullet) => b + countWords(bullet), 0),
          0,
        );
        return sum + fromEntries + countWords(section.text ?? '');
      }, countWords(vm.header.headline))
    : profile.work.reduce(
        (sum, entry) => sum + countWords(entry.summary ?? '') + entry.bullets.reduce((b, bullet) => b + countWords(`${bullet.outcome} ${bullet.method ?? ''}`), 0),
        countWords(profile.basics.summary),
      );

  if (totalWords < TOTAL_WORDS.min || totalWords > TOTAL_WORDS.max) {
    findings.push({
      rule: 'ATS-088',
      severity: 'warning',
      message: `El CV tiene ${totalWords} palabras; el rango es ${TOTAL_WORDS.min}-${TOTAL_WORDS.max}.`,
      where: 'documento',
      fix: totalWords < TOTAL_WORDS.min ? 'Falta contenido: probablemente el overlay excluyó demasiado.' : 'Recortá con las variantes `short` antes de bajar el tamaño de fuente.',
    });
  }

  /* ── ATS-089 — anclas cuantificadas ───────────────────────────────────── */
  const measured = resolved
    ? resolved.work.flatMap((entry) => entry.bullets).filter((bullet) => bullet.metricConfidence === 'measured').length
    : profile.work.flatMap((entry) => entry.bullets).filter((bullet) => bullet.metric?.confidence === 'measured').length;

  if (measured < MIN_MEASURED_ANCHORS) {
    findings.push({
      rule: 'ATS-089',
      severity: 'warning',
      message: `Hay ${measured} anclas cuantificadas con confianza "measured" y se esperan al menos ${MIN_MEASURED_ANCHORS}.`,
      where: 'documento',
      fix: 'Es warning y no error a propósito: un bullet claro, específico y verdadero sin número le gana a uno con un número forzado. 2-4 anclas bien elegidas en todo el CV alcanzan.',
    });
  }

  return { format: 'data', findings, passed: findings.every((f) => f.severity !== 'error') };
}
