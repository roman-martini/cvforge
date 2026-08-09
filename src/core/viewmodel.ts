import type { SectionName } from './schema/tailoring.ts';
import type {
  ResolvedCV,
  ResolvedWork,
  VMEntry,
  VMLink,
  VMSection,
  ViewModel,
} from './types.ts';

/**
 * Construcción del ViewModel: acá vive TODO el formateo derivado.
 *
 * Los renderers no formatean nada; mapean estructura a la sintaxis de su
 * formato. Si el formateo se filtrara a los renderers, cada formato nuevo
 * reimplementaría —con diferencias sutiles— los rangos de fecha, el orden de
 * secciones y los separadores, y el TXT dejaría de ser el ground truth contra
 * el que se compara el texto extraído del PDF (ATS-050).
 *
 * Tres reglas que el módulo garantiza por construcción:
 *
 * - **Un único patrón de fecha** en todo el documento (ATS-061). Los meses se
 *   resuelven con tablas propias y no con `Intl`: el ICU del runtime varía
 *   entre máquinas y el mismo build produciría "Mar" acá y "mar." allá.
 * - **Cero caracteres invisibles** (ATS-054). U+00A0, U+00AD y los zero-width
 *   sobreviven intactos a la extracción del PDF y rompen todo match exacto;
 *   para impedir cortes de línea el tema usa la clase `.nowrap`.
 * - **Separador textual real entre datos hermanos.** Un `gap` de CSS no crea
 *   ningún carácter: las cajas se extraen pegadas ("MadridEspaña").
 */

export type ViewModelOptions = {
  density?: ViewModel['density'];
};

type Lang = 'en' | 'es' | 'de' | 'fr' | 'pt' | 'it' | 'nl';

type DateStyle = {
  kind: 'month-name' | 'month-abbr' | 'numeric' | 'iso' | 'year';
  lang: Lang;
  separator: string;
};

const LANGS: Lang[] = ['en', 'es', 'de', 'fr', 'pt', 'it', 'nl'];

/** Guion medio U+2013 con espacios normales. Nunca guion corto, nunca U+00A0. */
const RANGE_DASH = ' – ';
/** Separador entre datos hermanos dentro de una misma línea. */
const INLINE_SEPARATOR = ' · ';

const MONTHS: Record<Lang, { full: string[]; abbr: string[] }> = {
  en: {
    full: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    abbr: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  es: {
    full: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    abbr: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  },
  de: {
    full: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    abbr: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'],
  },
  fr: {
    full: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    abbr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
  },
  pt: {
    full: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
    abbr: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
  },
  it: {
    full: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    abbr: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  },
  nl: {
    full: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
    abbr: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  },
};

const PRESENT_LABELS: Record<Lang, string> = {
  en: 'Present',
  es: 'Actualidad',
  de: 'Heute',
  fr: "Aujourd'hui",
  pt: 'Atualmente',
  it: 'Presente',
  nl: 'Heden',
};

const NATIVE_LABELS: Record<Lang, string> = {
  en: 'Native',
  es: 'Nativo',
  de: 'Muttersprache',
  fr: 'Langue maternelle',
  pt: 'Nativo',
  it: 'Madrelingua',
  nl: 'Moedertaal',
};

const LEVEL_LABELS: Record<Lang, Record<string, string>> = {
  en: { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', expert: 'Expert' },
  es: { beginner: 'Inicial', intermediate: 'Intermedio', advanced: 'Avanzado', expert: 'Experto' },
  de: { beginner: 'Grundkenntnisse', intermediate: 'Fortgeschritten', advanced: 'Sehr gut', expert: 'Experte' },
  fr: { beginner: 'Notions', intermediate: 'Intermédiaire', advanced: 'Avancé', expert: 'Expert' },
  pt: { beginner: 'Básico', intermediate: 'Intermediário', advanced: 'Avançado', expert: 'Especialista' },
  it: { beginner: 'Base', intermediate: 'Intermedio', advanced: 'Avanzato', expert: 'Esperto' },
  nl: { beginner: 'Basis', intermediate: 'Gemiddeld', advanced: 'Gevorderd', expert: 'Expert' },
};

/** Sufijo de antigüedad. `{n}` es el entero de años derivado en `resolve`. */
const YEARS_LABELS: Record<Lang, string> = {
  en: '{n}+ yrs',
  es: '{n}+ años',
  de: '{n}+ Jahre',
  fr: '{n}+ ans',
  pt: '{n}+ anos',
  it: '{n}+ anni',
  nl: '{n}+ jaar',
};

const REFERENCES_ON_REQUEST: Record<Lang, string> = {
  en: 'References available upon request',
  es: 'Referencias disponibles a solicitud',
  de: 'Referenzen auf Anfrage',
  fr: 'Références disponibles sur demande',
  pt: 'Referências disponíveis mediante solicitação',
  it: 'Referenze disponibili su richiesta',
  nl: 'Referenties op aanvraag beschikbaar',
};

/**
 * Etiquetas canónicas de sección por idioma. Sólo actúan cuando el perfil
 * regional no declara la suya: el ATS segmenta el CV por estos headings
 * (ATS-058), así que el mercado manda sobre este default.
 */
const SECTION_LABELS: Record<Lang, Record<SectionName, string>> = {
  en: {
    contact: 'Contact', summary: 'Summary', skills: 'Skills', work: 'Work Experience',
    education: 'Education', certificates: 'Certifications', projects: 'Projects',
    awards: 'Awards', languages: 'Languages', publications: 'Publications',
    references: 'References', interests: 'Interests',
  },
  es: {
    contact: 'Contacto', summary: 'Perfil', skills: 'Competencias', work: 'Experiencia profesional',
    education: 'Formación', certificates: 'Certificaciones', projects: 'Proyectos',
    awards: 'Premios', languages: 'Idiomas', publications: 'Publicaciones',
    references: 'Referencias', interests: 'Intereses',
  },
  de: {
    contact: 'Kontakt', summary: 'Profil', skills: 'Kenntnisse', work: 'Berufserfahrung',
    education: 'Ausbildung', certificates: 'Zertifikate', projects: 'Projekte',
    awards: 'Auszeichnungen', languages: 'Sprachen', publications: 'Publikationen',
    references: 'Referenzen', interests: 'Interessen',
  },
  fr: {
    contact: 'Contact', summary: 'Profil', skills: 'Compétences', work: 'Expérience professionnelle',
    education: 'Formation', certificates: 'Certifications', projects: 'Projets',
    awards: 'Distinctions', languages: 'Langues', publications: 'Publications',
    references: 'Références', interests: "Centres d'intérêt",
  },
  pt: {
    contact: 'Contato', summary: 'Perfil', skills: 'Competências', work: 'Experiência profissional',
    education: 'Formação', certificates: 'Certificações', projects: 'Projetos',
    awards: 'Prêmios', languages: 'Idiomas', publications: 'Publicações',
    references: 'Referências', interests: 'Interesses',
  },
  it: {
    contact: 'Contatti', summary: 'Profilo', skills: 'Competenze', work: 'Esperienza professionale',
    education: 'Formazione', certificates: 'Certificazioni', projects: 'Progetti',
    awards: 'Riconoscimenti', languages: 'Lingue', publications: 'Pubblicazioni',
    references: 'Referenze', interests: 'Interessi',
  },
  nl: {
    contact: 'Contact', summary: 'Profiel', skills: 'Vaardigheden', work: 'Werkervaring',
    education: 'Opleiding', certificates: 'Certificaten', projects: 'Projecten',
    awards: 'Prijzen', languages: 'Talen', publications: 'Publicaties',
    references: 'Referenties', interests: 'Interesses',
  },
};

export function buildViewModel(cv: ResolvedCV, opts: ViewModelOptions = {}): ViewModel {
  const lang = languageOf(cv.locale);
  const style = parseDateStyle(cv.config.datePattern, lang);
  const present = PRESENT_LABELS[lang];

  const range = (start?: string, end?: string, current = false): string =>
    formatRange(start, end, current, style, present);
  const day = (value?: string): string => (value ? formatFlexDate(value, style) : '');

  const sections = new Map<SectionName, VMSection>();

  if (cv.contact.summary) {
    sections.set('summary', {
      ...emptySection('summary', 'text', headingFor(cv, lang, 'summary')),
      text: clean(cv.contact.summary),
    });
  }

  if (cv.skills.length > 0) {
    sections.set('skills', {
      ...emptySection('skills', 'skills', headingFor(cv, lang, 'skills')),
      groups: cv.skills.map((group) => ({
        label: clean(group.category),
        items: group.items.map((item) => {
          const name = cv.preferredAliases[item.id] ?? cv.preferredAliases[item.name] ?? item.name;
          const qualifier = skillQualifier(item.level, lang);
          return clean(qualifier ? `${name} (${qualifier})` : name);
        }),
      })),
    });
  }

  if (cv.work.length > 0) {
    sections.set('work', {
      ...emptySection('work', 'entries', headingFor(cv, lang, 'work')),
      entries: cv.work.map((entry) => workEntry(entry, range)),
    });
  }

  if (cv.education.length > 0) {
    sections.set('education', {
      ...emptySection('education', 'entries', headingFor(cv, lang, 'education')),
      entries: cv.education.map((entry) => {
        const vm: VMEntry = {
          id: entry.id,
          title: clean(`${entry.studyType}, ${entry.area}`),
          dateRange: range(entry.startDate, entry.endDate, entry.current),
          subtitle: clean(entry.institution),
          bullets: entry.courses.length > 0 ? [clean(entry.courses.join(INLINE_SEPARATOR))] : [],
          extraPositions: [],
        };
        if (entry.score) vm.meta = clean(entry.score);
        return vm;
      }),
    });
  }

  if (cv.certificates.length > 0) {
    sections.set('certificates', {
      ...emptySection('certificates', 'entries', headingFor(cv, lang, 'certificates')),
      entries: cv.certificates.map((entry) => {
        const vm: VMEntry = {
          id: entry.id,
          title: clean(entry.name),
          // Con vencimiento el rango es el período de vigencia, no dos hechos sueltos.
          dateRange: entry.expiresAt ? `${day(entry.date)}${RANGE_DASH}${day(entry.expiresAt)}` : day(entry.date),
          subtitle: clean(entry.issuer),
          bullets: [],
          extraPositions: [],
        };
        if (entry.credentialId) vm.meta = clean(entry.credentialId);
        if (entry.url) vm.url = entry.url;
        return vm;
      }),
    });
  }

  if (cv.projects.length > 0) {
    sections.set('projects', {
      ...emptySection('projects', 'entries', headingFor(cv, lang, 'projects')),
      entries: cv.projects.map((entry) => {
        const vm: VMEntry = {
          id: entry.id,
          title: clean(entry.name),
          dateRange: range(entry.startDate, entry.endDate),
          subtitle: '',
          bullets: entry.highlights.map((bullet) => clean(bullet.text)),
          extraPositions: [],
        };
        if (entry.keywords.length > 0) vm.meta = clean(entry.keywords.join(INLINE_SEPARATOR));
        if (entry.description) vm.summary = clean(entry.description);
        if (entry.url) vm.url = entry.url;
        return vm;
      }),
    });
  }

  if (cv.awards.length > 0) {
    sections.set('awards', {
      ...emptySection('awards', 'entries', headingFor(cv, lang, 'awards')),
      entries: cv.awards.map((entry) => {
        const vm: VMEntry = {
          id: entry.id,
          title: clean(entry.title),
          dateRange: day(entry.date),
          subtitle: clean(entry.awarder),
          bullets: [],
          extraPositions: [],
        };
        if (entry.summary) vm.summary = clean(entry.summary);
        return vm;
      }),
    });
  }

  if (cv.languages.length > 0) {
    sections.set('languages', {
      ...emptySection('languages', 'inline-list', headingFor(cv, lang, 'languages')),
      items: cv.languages.map((entry) =>
        clean(`${entry.language} — ${fluencyLabel(entry.fluency, lang)}`),
      ),
    });
  }

  if (cv.publications.length > 0) {
    sections.set('publications', {
      ...emptySection('publications', 'entries', headingFor(cv, lang, 'publications')),
      entries: cv.publications.map((entry) => {
        const vm: VMEntry = {
          id: entry.id,
          // La cita ya viene compuesta según el citationStyle de la industria.
          title: clean(entry.citation),
          dateRange: '',
          subtitle: '',
          bullets: [],
          extraPositions: [],
        };
        if (entry.url) vm.url = entry.url;
        return vm;
      }),
    });
  }

  const referencesSection = buildReferences(cv, lang);
  if (referencesSection) sections.set('references', referencesSection);

  const documentType = cv.config.documentType || 'Resume';
  const headline = clean(cv.contact.label);

  const vm: ViewModel = {
    locale: cv.locale,
    // Neutro y determinista. Chrome lo copia literal a /Title y el reclutador lo
    // ve en el visor: la empresa objetivo o el id de la variante acá son la fuga
    // más probable de un workspace de tailoring (ATS-038).
    documentTitle: `${clean(cv.contact.name)} — ${clean(documentType)}`,
    paper: cv.config.paper,
    header: buildHeader(cv, headline),
    sections: orderSections(cv.sectionOrder, sections),
    meta: {
      author: clean(cv.contact.name),
      subject: clean(cv.targetRole ?? cv.contact.label),
      keywords: documentKeywords(cv),
    },
    density: opts.density ?? 'normal',
    omittedSections: omittedSections(cv.sectionOrder, sections),
  };

  const consent = consentClause(cv);
  if (consent) vm.consentClause = consent;
  return vm;
}

function buildHeader(cv: ResolvedCV, headline: string): ViewModel['header'] {
  const lines = [cv.contact.location, cv.contact.email, cv.contact.phone];

  const links: VMLink[] = [];
  if (cv.contact.url) links.push({ text: clean(displayUrl(cv.contact.url)), href: cv.contact.url });
  for (const profile of cv.contact.profiles) {
    // La URL completa como texto visible: "LinkedIn" a secas no es matcheable
    // ni clickeable desde el papel (ATS-060).
    links.push({ text: clean(profile.display), href: profile.url });
  }

  return {
    name: clean(cv.contact.name),
    headline,
    contactLines: lines.filter(isPresent).map(clean),
    links,
  };
}

function buildReferences(cv: ResolvedCV, lang: Lang): VMSection | null {
  const policy = cv.config.referencesPolicy;
  if (policy === 'omit') return null;
  const heading = headingFor(cv, lang, 'references');

  if (policy === 'on-request-line') {
    return {
      ...emptySection('references', 'text', heading),
      text: REFERENCES_ON_REQUEST[lang],
    };
  }

  if (cv.references.length === 0) return null;
  return {
    ...emptySection('references', 'entries', heading),
    entries: cv.references.map((entry) => ({
      id: entry.id,
      title: clean(entry.role),
      dateRange: '',
      subtitle: clean(compact([entry.initials, entry.company]).join(INLINE_SEPARATOR)),
      bullets: [],
      extraPositions: [],
    })),
  };
}

function workEntry(
  entry: ResolvedWork,
  range: (start?: string, end?: string, current?: boolean) => string,
): VMEntry {
  const [head, ...rest] = entry.positions;

  const vm: VMEntry = {
    id: entry.id,
    title: clean(head?.title ?? ''),
    dateRange: head ? range(head.startDate, head.endDate, head.current) : '',
    subtitle: clean(entry.company),
    bullets: entry.bullets.map((bullet) => clean(bullet.text)),
    extraPositions: rest.map((position) => ({
      title: clean(position.title),
      dateRange: range(position.startDate, position.endDate, position.current),
    })),
  };

  const meta = compact([entry.location, entry.industry]).join(INLINE_SEPARATOR);
  if (meta) vm.meta = clean(meta);
  if (entry.companyUrl) vm.url = entry.companyUrl;
  if (entry.summary) vm.summary = clean(entry.summary);
  return vm;
}

/**
 * `contact` no genera sección propia: sus datos ya viven en el header, que el
 * ATS espera en las primeras líneas del documento (ATS-059).
 */
function orderSections(order: SectionName[], built: Map<SectionName, VMSection>): VMSection[] {
  const ordered: VMSection[] = [];
  const emitted = new Set<SectionName>();

  for (const name of order) {
    const section = built.get(name);
    if (!section || emitted.has(name)) continue;
    ordered.push(section);
    emitted.add(name);
  }
  // `sectionOrder` es orden Y selección: un arquetipo que declara sus secciones
  // controla qué CV produce. Sin esto, un CV de backend imprime la lista de
  // publicaciones sólo porque el archivo existe, y el autor descubre que su
  // arquetipo no manda sobre su propio documento.
  //
  // Lo que queda afuera NO se pierde en silencio: se devuelve aparte para que
  // el CLI lo informe. Omitir callado sería el problema que este cambio evita.
  return ordered;
}

/** Secciones con contenido que `sectionOrder` dejó afuera. */
function omittedSections(order: readonly SectionName[], built: Map<SectionName, VMSection>): SectionName[] {
  const wanted = new Set(order);
  const omitted: SectionName[] = [];
  for (const [name, section] of built) {
    const hasContent =
      section.entries.length > 0 ||
      section.groups.length > 0 ||
      section.items.length > 0 ||
      (section.text ?? '') !== '';
    if (!wanted.has(name) && hasContent) omitted.push(name);
  }
  return omitted;
}

function emptySection(name: SectionName, kind: VMSection['kind'], heading: string): VMSection {
  return { name, heading, kind, entries: [], groups: [], items: [] };
}

function headingFor(cv: ResolvedCV, lang: Lang, name: SectionName): string {
  return clean(cv.config.sectionLabels[name] ?? SECTION_LABELS[lang][name]);
}

function consentClause(cv: ResolvedCV): string | undefined {
  const clause = cv.config.consentClause;
  if (!clause?.required) return undefined;
  if (!clause.text) {
    throw new Error(
      '[ATS-084] El perfil regional declara consentClause.required: true pero no trae el texto ' +
        'de la cláusula. Es un texto legal del mercado y no se puede inventar: agregá ' +
        'consentClause.text al perfil regional.',
    );
  }
  return clean(clause.text);
}

function documentKeywords(cv: ResolvedCV): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  const push = (value: string | undefined) => {
    const text = value ? clean(value) : '';
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    keywords.push(text);
  };

  push(cv.targetRole);
  for (const group of cv.skills) {
    for (const item of group.items) {
      push(cv.preferredAliases[item.id] ?? cv.preferredAliases[item.name] ?? item.name);
    }
  }
  return keywords.slice(0, 40);
}

function skillQualifier(level: string | undefined, lang: Lang): string | undefined {
  if (!level) return undefined;
  // `resolve` deja un entero desnudo cuando no hay nivel declarado y sí años
  // derivados de la experiencia.
  if (/^\d+$/.test(level)) return YEARS_LABELS[lang].replace('{n}', level);
  return LEVEL_LABELS[lang][level] ?? level;
}

function fluencyLabel(fluency: string, lang: Lang): string {
  // Los códigos del Marco Común Europeo son internacionales y se imprimen tal
  // cual; sólo `native` necesita traducción.
  return fluency === 'native' ? NATIVE_LABELS[lang] : fluency;
}

/* ========================================================================== *
 * Fechas: un solo patrón para todo el documento (ATS-061)
 * ========================================================================== */

/**
 * Interpreta el `datePattern` del perfil regional, que se declara tanto con
 * tokens ("MMMM yyyy", "MM/yyyy") como con un ejemplo literal del mercado
 * ("March 2022", "03/2022", "maart 2022"). El idioma del ejemplo gana sobre el
 * del documento: el mercado decide cómo se escriben sus meses.
 */
export function parseDateStyle(pattern: string, fallbackLang: Lang): DateStyle {
  const raw = pattern.trim();

  if (/^(?:y{4}|Y{4}|\d{4})-(?:M{2}|\d{2})$/.test(raw)) {
    return { kind: 'iso', lang: fallbackLang, separator: '-' };
  }

  const numeric = raw.match(/^(?:M{1,2}|\d{1,2})\s*([./-])\s*(?:y{4}|Y{4}|\d{4})$/);
  if (numeric) return { kind: 'numeric', lang: fallbackLang, separator: numeric[1]! };

  if (/^(?:y{4}|Y{4}|\d{4})$/.test(raw)) {
    return { kind: 'year', lang: fallbackLang, separator: '' };
  }

  const detected = detectMonthWord(raw, fallbackLang);
  if (detected) return { ...detected, separator: ' ' };

  if (raw.includes('MMMM')) return { kind: 'month-name', lang: fallbackLang, separator: ' ' };
  if (raw.includes('MMM')) return { kind: 'month-abbr', lang: fallbackLang, separator: ' ' };
  return { kind: 'month-name', lang: fallbackLang, separator: ' ' };
}

function detectMonthWord(
  pattern: string,
  fallbackLang: Lang,
): { kind: 'month-name' | 'month-abbr'; lang: Lang } | null {
  const tokens = pattern.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (tokens.length === 0) return null;

  const full: Lang[] = [];
  const abbr: Lang[] = [];
  for (const lang of LANGS) {
    const table = MONTHS[lang];
    if (tokens.some((token) => table.full.some((month) => month.toLowerCase() === token))) {
      full.push(lang);
    } else if (
      tokens.some((token) =>
        table.abbr.some((month) => month.toLowerCase().replace('.', '') === token),
      )
    ) {
      abbr.push(lang);
    }
  }

  // "marzo" es español y también italiano: ante empate manda el idioma del CV.
  if (full.length > 0) return { kind: 'month-name', lang: pick(full, fallbackLang) };
  if (abbr.length > 0) return { kind: 'month-abbr', lang: pick(abbr, fallbackLang) };
  return null;
}

function pick(candidates: Lang[], preferred: Lang): Lang {
  return candidates.includes(preferred) ? preferred : candidates[0]!;
}

export function formatFlexDate(value: string, style: DateStyle): string {
  const year = value.slice(0, 4);
  const month = Number(value.slice(5, 7));
  if (style.kind === 'year' || !Number.isInteger(month) || month < 1 || month > 12) return year;

  switch (style.kind) {
    case 'iso':
      return `${year}-${pad2(month)}`;
    case 'numeric':
      return `${pad2(month)}${style.separator}${year}`;
    case 'month-abbr':
      return `${MONTHS[style.lang].abbr[month - 1]} ${year}`;
    default:
      return `${MONTHS[style.lang].full[month - 1]} ${year}`;
  }
}

export function formatRange(
  start: string | undefined,
  end: string | undefined,
  current: boolean,
  style: DateStyle,
  presentLabel: string,
): string {
  const from = start ? formatFlexDate(start, style) : '';
  const to = current ? presentLabel : end ? formatFlexDate(end, style) : '';

  if (from && to) return `${from}${RANGE_DASH}${to}`;
  return from || to;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/* ========================================================================== *
 * Saneamiento del texto
 * ========================================================================== */

/**
 * Normaliza a NFC y elimina todo carácter invisible antes de que llegue a un
 * renderer. Un U+00A0 tecleado por descuido en "March 2022" sobrevive a la
 * extracción del PDF y esa fecha deja de matchear "March 2022" y de sobrevivir
 * a un split por espacio (ATS-054).
 */
export function clean(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\u00A0\u2007\u2009\u200A\u202F\u3000\u2028\u2029]/gu, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter(isPresent);
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function displayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

function languageOf(locale: string): Lang {
  const code = locale.slice(0, 2).toLowerCase();
  return (LANGS as string[]).includes(code) ? (code as Lang) : 'en';
}
