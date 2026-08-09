import type { ResolvedProfileConfig } from './schema/config.ts';
import { compareFlexDates } from './schema/refine.ts';
import type {
  AwardEntry,
  Bullet,
  CertificateEntry,
  EducationEntry,
  LanguageEntry,
  PersonProfile,
  ProjectEntry,
  PublicationEntry,
  ReferenceEntry,
  SkillEntry,
  WorkEntry,
} from './schema/sections.ts';
import type { Budget, SectionName } from './schema/tailoring.ts';
import type {
  ResolvedAward,
  ResolvedBullet,
  ResolvedCV,
  ResolvedCertificate,
  ResolvedContact,
  ResolvedEducation,
  ResolvedLanguage,
  ResolvedPosition,
  ResolvedProject,
  ResolvedPublication,
  ResolvedReference,
  ResolvedSkillGroup,
  ResolvedWork,
} from './types.ts';

/**
 * Resolución a hechos: qué entra al CV, ya elegido y ordenado, todavía sin
 * formato de presentación.
 *
 * Esta etapa decide y descarta; no inventa. El texto de un bullet sale de una
 * variante escrita a mano o de la composición literal `outcome` + `method`.
 * Las fechas siguen en ISO: el patrón único del mercado se aplica recién en el
 * ViewModel (regla ATS-061), porque un mismo hecho se imprime distinto en
 * `us` y en `de` y duplicarlo acá sería duplicar la fuente de verdad.
 *
 * Las pocas cadenas que sí se componen acá (ubicación, cita bibliográfica,
 * calificador de skill) son las que `ResolvedCV` tipa como `string` y para las
 * que no existe hueco estructural aguas abajo.
 */

export type ResolveOptions = {
  /** Idioma efectivo del documento; por defecto el primario de la persona. */
  locale?: string;
  budget?: Budget;
  /** Overlay > target > config. Por defecto el del perfil compuesto. */
  sectionOrder?: SectionName[];
  /** Variante de bullet por id de entrada, tal como la devuelve `bulletVariants()`. */
  bulletVariants?: Record<string, 'short' | 'long'>;
  /** `public` es la proyección publicable: se caen los ítems marcados private. */
  projection?: 'full' | 'public';
  targetRole?: string;
  /** Alias que usa la vacante, por id de skill (o por forma canónica). */
  preferredAliases?: Record<string, string>;
  /** Fecha de referencia para derivar antigüedad. Inyectable para tests deterministas. */
  now?: string;
};

const DEFAULT_BUDGET: Budget = {
  maxPages: 2,
  bulletsPerRole: { recent: 5, mid: 3, old: 2 },
};

/** Fecha imposible que ordena por encima de cualquier fecha real. */
const CURRENT_SENTINEL = '9999-12';

const WORK_MODE_LABELS: Record<string, Record<string, string>> = {
  en: { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' },
  es: { remote: 'Remoto', hybrid: 'Híbrido', onsite: 'Presencial' },
  de: { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Vor Ort' },
  fr: { remote: 'Télétravail', hybrid: 'Hybride', onsite: 'Sur site' },
  pt: { remote: 'Remoto', hybrid: 'Híbrido', onsite: 'Presencial' },
  it: { remote: 'Da remoto', hybrid: 'Ibrido', onsite: 'In sede' },
  nl: { remote: 'Op afstand', hybrid: 'Hybride', onsite: 'Op locatie' },
};

/**
 * Rutas reales de los campos que los perfiles regionales suelen prohibir. Se
 * declaran en tabla para que `forbiddenFields: [{ field: "photo" }]` no dependa
 * de que el YAML conozca la forma interna del modelo.
 */
const FORBIDDEN_FIELD_PATHS: Record<string, string> = {
  photo: 'basics.photo',
  birthDate: 'basics.birthDate',
  nationalId: 'basics.nationalId',
  address: 'basics.location.address',
  postalCode: 'basics.location.postalCode',
  phone: 'basics.phone',
  references: 'references',
};

/**
 * Acepta los argumentos sueltos o un único objeto con todo dentro. La segunda
 * forma es la que usa el CLI, donde el pipeline ya viene armado como un objeto
 * de contexto y desarmarlo sólo para volver a armarlo no aporta nada.
 */
export function resolveCV(
  profileOrInput: PersonProfile | (ResolveOptions & { profile: PersonProfile; config: ResolvedProfileConfig }),
  maybeConfig?: ResolvedProfileConfig,
  maybeOpts: ResolveOptions = {},
): ResolvedCV {
  const isBundled = 'profile' in profileOrInput && 'config' in profileOrInput;
  const profile = (isBundled ? profileOrInput.profile : profileOrInput) as PersonProfile;
  const config = (isBundled ? profileOrInput.config : maybeConfig) as ResolvedProfileConfig;
  const opts: ResolveOptions = isBundled ? (profileOrInput as ResolveOptions) : maybeOpts;

  const locale = opts.locale ?? profile.meta.primaryLocale;
  const projection = opts.projection ?? 'full';
  const now = opts.now ?? todayIso();
  const variants = opts.bulletVariants ?? {};

  assertNoForbiddenFields(profile, config);

  const visible = <T extends { visibility: 'public' | 'private' }>(items: T[]): T[] =>
    projection === 'public' ? items.filter((item) => item.visibility === 'public') : items;

  const work = visible(profile.work)
    .map((entry) => resolveWork(entry, variants[entry.id], locale))
    .sort((a, b) => compareFlexDates(workRank(b), workRank(a)));

  const education = visible(profile.education)
    .map(resolveEducation)
    .sort((a, b) => compareFlexDates(educationRank(b), educationRank(a)));

  const projects = visible(profile.projects)
    .map((entry) => resolveProject(entry, variants[entry.id]))
    .sort((a, b) => compareFlexDates(projectRank(b), projectRank(a)));

  const certificates = visible(profile.certificates)
    .map(resolveCertificate)
    .sort((a, b) => compareFlexDates(b.date, a.date));

  const awards = visible(profile.awards)
    .map(resolveAward)
    .sort((a, b) => compareFlexDates(b.date, a.date));

  const languages = byPriority(visible(profile.languages)).map(resolveLanguage);
  const references = byPriority(visible(profile.references)).map(resolveReference);

  const publications = visible(profile.publications)
    .slice()
    .sort((a, b) => publicationYear(b) - publicationYear(a))
    .map((entry) => resolvePublication(entry, config.citationStyle ?? 'apa'));

  const skills = groupSkills(byPriority(visible(profile.skills)), deriveSkillYears(profile, now));

  return {
    personSlug: profile.meta.slug,
    locale,
    contact: resolveContact(profile, config, projection),
    work,
    education,
    skills,
    projects,
    certificates,
    awards,
    languages,
    publications,
    references,
    sectionOrder: opts.sectionOrder ?? config.sectionOrder,
    config,
    budget: opts.budget ?? DEFAULT_BUDGET,
    ...(opts.targetRole ? { targetRole: opts.targetRole } : {}),
    preferredAliases: opts.preferredAliases ?? {},
  };
}

/**
 * Años de experiencia por skill, derivados de `work`.
 *
 * Una skill cuenta el tiempo de una empresa cuando alguno de sus términos
 * (canónico, alias, keyword o tag) aparece en los tags de esa experiencia o de
 * sus bullets. Los períodos se fusionan antes de sumar: dos empleos solapados
 * no dan el doble de antigüedad.
 */
export function deriveSkillYears(profile: PersonProfile, now?: string): Record<string, number> {
  const today = now ?? todayIso();
  const nowIndex = monthIndex(today);

  const entryTerms = profile.work.map((entry) => ({
    entry,
    terms: new Set(
      [...entry.tags, ...entry.bullets.flatMap((bullet) => bullet.tags)].map(normalizeTerm),
    ),
  }));

  const years: Record<string, number> = {};
  for (const skill of profile.skills) {
    const wanted = [skill.canonical, ...skill.aliases, ...skill.keywords, ...skill.tags].map(
      normalizeTerm,
    );
    const spans: Array<[number, number]> = [];

    for (const { entry, terms } of entryTerms) {
      if (!wanted.some((term) => terms.has(term))) continue;
      for (const position of entry.positions) {
        const start = monthIndex(position.startDate);
        const end = position.current
          ? nowIndex
          : position.endDate
            ? monthIndex(position.endDate)
            : nowIndex;
        if (end >= start) spans.push([start, end]);
      }
    }

    const months = mergeSpans(spans);
    if (months > 0) years[skill.id] = Math.floor(months / 12);
  }
  return years;
}

function assertNoForbiddenFields(profile: PersonProfile, config: ResolvedProfileConfig): void {
  for (const forbidden of config.forbiddenFields) {
    const path = FORBIDDEN_FIELD_PATHS[forbidden.field] ?? forbidden.field;
    if (!hasValue(profile, path)) continue;
    throw new Error(
      `[ATS-084] El perfil regional prohíbe "${forbidden.field}" y el dato está presente en ${path}.\n` +
        `  Motivo: ${forbidden.reason}\n` +
        `  Fuente: ${forbidden.source}\n` +
        `  Quitá el campo del perfil de la persona o generá este CV con otro perfil regional. ` +
        `No se suprime en silencio a propósito: la convención del mercado al que estás aplicando ` +
        `es parte de lo que hay que aprender antes de mandar el CV.`,
    );
  }
}

function hasValue(root: unknown, path: string): boolean {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null) return false;
  if (typeof cursor === 'string') return cursor.trim().length > 0;
  if (Array.isArray(cursor)) return cursor.length > 0;
  return true;
}

function resolveContact(
  profile: PersonProfile,
  config: ResolvedProfileConfig,
  projection: 'full' | 'public',
): ResolvedContact {
  const { basics } = profile;
  const isPublic = projection === 'public';

  const contact: ResolvedContact = {
    name: basics.name,
    label: basics.label,
    summary: basics.summary,
    email: basics.email,
    location: composeHomeLocation(basics.location, config, isPublic),
    profiles: basics.profiles
      .filter((entry) => !isPublic || entry.visibility === 'public')
      .map((entry) => ({
        id: entry.id,
        network: entry.network,
        url: entry.url,
        display: displayUrl(entry.url),
      })),
  };

  // El teléfono es dato de contacto directo: no viaja a la proyección publicable.
  if (basics.phone && !isPublic) contact.phone = basics.phone;
  if (basics.url) contact.url = basics.url;
  return contact;
}

function composeHomeLocation(
  location: PersonProfile['basics']['location'],
  config: ResolvedProfileConfig,
  isPublic: boolean,
): string {
  const parts: string[] = [];
  const addressIsCustomary = config.customaryFields.includes('address');

  if (!isPublic && addressIsCustomary && location.address) {
    parts.push(location.address);
    parts.push(compact([location.postalCode, location.city]).join(' '));
  } else {
    parts.push(location.city);
  }
  if (location.region) parts.push(location.region);
  parts.push(location.countryCode);

  return compact(parts).join(', ');
}

function resolveWork(
  entry: WorkEntry,
  variant: 'short' | 'long' | undefined,
  locale: string,
): ResolvedWork {
  const positions: ResolvedPosition[] = entry.positions
    .map((position) => {
      const resolved: ResolvedPosition = {
        id: position.id,
        title: position.title,
        startDate: position.startDate,
        current: position.current,
      };
      // `current: true` omite la clave en vez de emitirla vacía: `endDate: ''`
      // y `endDate: null` fallan la validación oficial de JSON Resume.
      if (!position.current && position.endDate) resolved.endDate = position.endDate;
      return resolved;
    })
    .sort((a, b) => compareFlexDates(positionRank(b), positionRank(a)));

  const resolved: ResolvedWork = {
    id: entry.id,
    company: entry.company.name,
    positions,
    bullets: byPriority(entry.bullets).map((bullet) => resolveBullet(bullet, variant)),
  };

  if (entry.company.url) resolved.companyUrl = entry.company.url;
  if (entry.company.industry) resolved.industry = entry.company.industry;
  if (entry.summary) resolved.summary = entry.summary;

  const location = composeWorkLocation(entry.location, locale);
  if (location) resolved.location = location;

  return resolved;
}

function composeWorkLocation(location: WorkEntry['location'], locale: string): string | undefined {
  if (!location) return undefined;
  const place = compact([location.city, location.countryCode]).join(', ');
  const labels = WORK_MODE_LABELS[languageOf(locale)] ?? WORK_MODE_LABELS.en;
  const mode = location.remote ? labels?.[location.remote] : undefined;
  // Separador textual real: un `gap` de CSS no genera ningún carácter y la
  // extracción del PDF devolvería "Buenos AiresRemoto".
  const composed = compact([place, mode]).join(' · ');
  return composed.length > 0 ? composed : undefined;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function resolveBullet(bullet: Bullet, variant: 'short' | 'long' | undefined): ResolvedBullet {
  const resolved: ResolvedBullet = {
    id: bullet.id,
    text: bulletText(bullet, variant),
    tags: bullet.tags,
    priority: bullet.priority,
    hasMetric: bullet.metric !== undefined,
    provenanceSource: bullet.provenance.source,
  };
  if (bullet.metric) resolved.metricConfidence = bullet.metric.confidence;
  return resolved;
}

/**
 * Si se pidió una variante y la entrada no la tiene, se degrada a la
 * composición literal: pedir `short` jamás debe devolver el texto `long`.
 */
function bulletText(bullet: Bullet, variant: 'short' | 'long' | undefined): string {
  const chosen = variant ? bullet.variants?.[variant] : undefined;
  if (chosen) return chosen;
  return bullet.method ? `${bullet.outcome} ${bullet.method}` : bullet.outcome;
}

function resolveEducation(entry: EducationEntry): ResolvedEducation {
  const resolved: ResolvedEducation = {
    id: entry.id,
    institution: entry.institution,
    area: entry.area,
    studyType: entry.studyType,
    current: entry.current,
    courses: entry.courses,
  };
  if (entry.startDate) resolved.startDate = entry.startDate;
  if (!entry.current && entry.endDate) resolved.endDate = entry.endDate;
  if (entry.score) resolved.score = entry.score;
  return resolved;
}

function resolveProject(
  entry: ProjectEntry,
  variant: 'short' | 'long' | undefined,
): ResolvedProject {
  const resolved: ResolvedProject = {
    id: entry.id,
    name: entry.name,
    keywords: entry.keywords,
    highlights: byPriority(entry.highlights).map((bullet) => resolveBullet(bullet, variant)),
  };
  if (entry.description) resolved.description = entry.description;
  if (entry.url) resolved.url = entry.url;
  if (entry.startDate) resolved.startDate = entry.startDate;
  if (entry.endDate) resolved.endDate = entry.endDate;
  return resolved;
}

function resolveCertificate(entry: CertificateEntry): ResolvedCertificate {
  const resolved: ResolvedCertificate = {
    id: entry.id,
    name: entry.name,
    issuer: entry.issuer,
    date: entry.date,
  };
  if (entry.expiresAt) resolved.expiresAt = entry.expiresAt;
  if (entry.url) resolved.url = entry.url;
  if (entry.credentialId) resolved.credentialId = entry.credentialId;
  return resolved;
}

function resolveAward(entry: AwardEntry): ResolvedAward {
  const resolved: ResolvedAward = {
    id: entry.id,
    title: entry.title,
    date: entry.date,
    awarder: entry.awarder,
  };
  if (entry.summary) resolved.summary = entry.summary;
  return resolved;
}

function resolveLanguage(entry: LanguageEntry): ResolvedLanguage {
  return { id: entry.id, language: entry.language, fluency: entry.fluency };
}

function resolveReference(entry: ReferenceEntry): ResolvedReference {
  const resolved: ResolvedReference = {
    id: entry.id,
    initials: entry.initials,
    role: entry.role,
  };
  if (entry.company) resolved.company = entry.company;
  return resolved;
}

/**
 * Agrupa por categoría respetando el orden de primera aparición: la lista ya
 * llega ordenada por prioridad, así que la categoría de la skill más relevante
 * queda arriba sin necesidad de un orden de categorías declarado aparte.
 */
function groupSkills(skills: SkillEntry[], derivedYears: Record<string, number>): ResolvedSkillGroup[] {
  const groups = new Map<string, ResolvedSkillGroup>();

  for (const skill of skills) {
    let group = groups.get(skill.category);
    if (!group) {
      group = { category: skill.category, items: [] };
      groups.set(skill.category, group);
    }

    const years = skill.yearsOfExperience ?? derivedYears[skill.id];
    const item: ResolvedSkillGroup['items'][number] = {
      id: skill.id,
      name: skill.canonical,
      keywords: skill.keywords,
    };
    // `level` es el único calificador que el tipo resuelto admite: lleva el
    // nivel declarado o, si no hay, los años derivados como entero desnudo,
    // que el ViewModel traduce al idioma del documento.
    if (skill.level) item.level = skill.level;
    else if (years !== undefined && years >= 1) item.level = String(years);

    group.items.push(item);
  }

  return [...groups.values()];
}

/* ========================================================================== *
 * Publicaciones: CSL-JSON → cita formateada
 * ========================================================================== */

function resolvePublication(
  entry: PublicationEntry,
  style: 'apa' | 'chicago' | 'vancouver' | 'ieee',
): ResolvedPublication {
  const resolved: ResolvedPublication = { id: entry.id, citation: formatCitation(entry, style) };
  if (entry.URL) resolved.url = entry.URL;
  if (entry.DOI) resolved.doi = entry.DOI;
  return resolved;
}

function formatCitation(
  entry: PublicationEntry,
  style: 'apa' | 'chicago' | 'vancouver' | 'ieee',
): string {
  const year = publicationYear(entry);
  // Marcador estándar de "sin fecha" en APA/Chicago; se mantiene en todos los
  // estilos para que un CSL-JSON incompleto se note en vez de imprimir "0".
  const yearText = year > 0 ? String(year) : 'n.d.';
  const container = entry['container-title'];
  const link = entry.DOI ? `https://doi.org/${entry.DOI}` : entry.URL;

  const authors = entry.author.map((author) => ({
    family: author.family.trim(),
    given: (author.given ?? '').trim(),
  }));

  if (style === 'vancouver') {
    const names = authors.map((a) => compact([a.family, initialsCompact(a.given)]).join(' '));
    const list = names.length > 6 ? `${names.slice(0, 6).join(', ')}, et al` : names.join(', ');
    return join([
      stop(list),
      stop(entry.title),
      stop(container),
      stop(yearText),
      entry.DOI ? `doi:${entry.DOI}` : (entry.URL ?? ''),
    ]);
  }

  if (style === 'ieee') {
    const names = authors.map((a) => compact([initialsSpaced(a.given), a.family]).join(' '));
    const list =
      names.length > 6
        ? `${names[0]} et al.`
        : names.length > 1
          ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
          : (names[0] ?? '');
    return join([
      list ? `${list},` : '',
      `"${entry.title},"`,
      container ? `${container},` : '',
      `${yearText},`,
      link ? `doi: ${entry.DOI ?? link}.` : '',
    ]);
  }

  if (style === 'chicago') {
    // Sólo el primer autor va invertido; los demás en orden natural.
    const names = authors.map((a, index) =>
      index === 0
        ? compact([a.family, a.given]).join(', ')
        : compact([a.given, a.family]).join(' '),
    );
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
        : (names[0] ?? '');
    return join([stop(list), `"${stop(entry.title)}"`, container ?? '', `(${yearText}).`, link ?? '']);
  }

  // APA 7: apellido, iniciales con punto; "&" antes del último autor.
  const names = authors.map((a) => compact([a.family, initialsSpaced(a.given)]).join(', '));
  const list =
    names.length > 20
      ? `${names.slice(0, 19).join(', ')}, ..., ${names[names.length - 1]}`
      : names.length > 1
        ? `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
        : (names[0] ?? '');
  return join([stop(list), `(${yearText}).`, stop(entry.title), stop(container), link ?? '']);
}

/** "María José" → "M. J."; "Jean-Pierre" → "J.-P." */
function initialsSpaced(given: string): string {
  if (!given) return '';
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split('-')
        .filter(Boolean)
        .map((chunk) => `${[...chunk][0]}.`)
        .join('-'),
    )
    .join(' ');
}

/** "María José" → "MJ" (estilo Vancouver, sin puntos ni espacios). */
function initialsCompact(given: string): string {
  if (!given) return '';
  return given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => [...part][0]!)
    .join('');
}

function publicationYear(entry: PublicationEntry): number {
  return entry.issued?.['date-parts']?.[0]?.[0] ?? 0;
}

function join(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

/** Cierra con punto sin duplicarlo: las iniciales APA ya terminan en punto. */
function stop(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

/* ========================================================================== *
 * Orden y aritmética de fechas
 * ========================================================================== */

function byPriority<T extends { priority: number }>(items: T[]): T[] {
  // sort estable: a igual prioridad manda el orden que dejó la selección.
  return [...items].sort((a, b) => b.priority - a.priority);
}

function positionRank(position: ResolvedPosition): string {
  return position.current ? CURRENT_SENTINEL : (position.endDate ?? position.startDate);
}

function workRank(entry: ResolvedWork): string {
  let best = '';
  for (const position of entry.positions) {
    const rank = positionRank(position);
    if (!best || compareFlexDates(rank, best) > 0) best = rank;
  }
  return best;
}

function educationRank(entry: ResolvedEducation): string {
  if (entry.current) return CURRENT_SENTINEL;
  return entry.endDate ?? entry.startDate ?? '';
}

function projectRank(entry: ResolvedProject): string {
  return entry.endDate ?? entry.startDate ?? '';
}

function monthIndex(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return year * 12 + (month - 1);
}

/** Suma meses cubiertos fusionando períodos solapados o contiguos. */
function mergeSpans(spans: Array<[number, number]>): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);

  let total = 0;
  let start = sorted[0]![0];
  let end = sorted[0]![1];
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end + 1) {
      if (nextEnd > end) end = nextEnd;
    } else {
      total += end - start + 1;
      start = nextStart;
      end = nextEnd;
    }
  }
  return total + (end - start + 1);
}

function normalizeTerm(value: string): string {
  // NFD + descarte de marcas combinantes: "Kubernetes" y "kubernetès" matchean igual.
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function displayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

function languageOf(locale: string): string {
  return locale.slice(0, 2).toLowerCase();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
