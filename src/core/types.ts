import type { SectionName, OutputFormat, Budget } from './schema/tailoring.ts';
import type { ResolvedProfileConfig } from './schema/config.ts';
import type { PersonProfile } from './schema/sections.ts';

/**
 * Los dos artefactos intermedios del pipeline.
 *
 *   YAML → PersonProfile → [select] → ResolvedCV → [viewmodel] → ViewModel → renderers
 *
 * `ResolvedCV` = qué hechos entran, ya elegidos y ordenados, SIN formato.
 * `ViewModel`  = los mismos hechos, ya formateados para presentación.
 *
 * La separación importa porque todo formateo derivado (rangos de fecha
 * localizados, truncados, orden de secciones, transliteración) vive en la
 * etapa ViewModel. Los renderers sólo mapean estructura → sintaxis de su
 * formato. Si el formateo se filtrara a los renderers, cada formato nuevo
 * reimplementaría —con diferencias sutiles— lo mismo.
 *
 * Corolario que no es negociable: el HTML NO es la fuente intermedia
 * universal. Convertir HTML a DOCX produce un archivo del que todo parser
 * headless extrae cero caracteres; el autor lo abre en Word, lo ve impecable,
 * y el ATS recibe un documento vacío. PDF, DOCX y TXT son hermanos que nacen
 * del mismo ViewModel, nunca uno derivado del otro.
 */

/* ========================================================================== *
 * ResolvedCV — hechos elegidos, sin formato
 * ========================================================================== */

export type ResolvedBullet = {
  id: string;
  /** El texto ya elegido entre outcome+method o la variante short/long. */
  text: string;
  tags: string[];
  priority: number;
  hasMetric: boolean;
  metricConfidence?: 'measured' | 'estimated' | 'self_reported';
  provenanceSource: 'human' | 'llm_draft' | 'llm_approved';
};

export type ResolvedPosition = {
  id: string;
  title: string;
  startDate: string;
  endDate?: string;
  current: boolean;
};

export type ResolvedWork = {
  id: string;
  company: string;
  companyUrl?: string;
  industry?: string;
  location?: string;
  positions: ResolvedPosition[];
  summary?: string;
  bullets: ResolvedBullet[];
};

export type ResolvedEducation = {
  id: string;
  institution: string;
  area: string;
  studyType: string;
  startDate?: string;
  endDate?: string;
  current: boolean;
  score?: string;
  courses: string[];
};

export type ResolvedSkillGroup = {
  category: string;
  items: Array<{ id: string; name: string; level?: string; keywords: string[] }>;
};

export type ResolvedProject = {
  id: string;
  name: string;
  description?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  keywords: string[];
  highlights: ResolvedBullet[];
};

export type ResolvedCertificate = {
  id: string;
  name: string;
  issuer: string;
  date: string;
  expiresAt?: string;
  url?: string;
  credentialId?: string;
};

export type ResolvedAward = {
  id: string;
  title: string;
  date: string;
  awarder: string;
  summary?: string;
};

export type ResolvedLanguage = { id: string; language: string; fluency: string };

export type ResolvedPublication = {
  id: string;
  /** Ya formateada según el citationStyle del perfil de industria. */
  citation: string;
  url?: string;
  doi?: string;
};

export type ResolvedReference = {
  id: string;
  initials: string;
  role: string;
  company?: string;
};

export type ResolvedContact = {
  name: string;
  label: string;
  summary: string;
  email: string;
  phone?: string;
  url?: string;
  location: string;
  /** La URL completa, para emitirla como texto visible y no como "LinkedIn". */
  profiles: Array<{ id: string; network: string; url: string; display: string }>;
};

export type ResolvedCV = {
  personSlug: string;
  locale: string;
  contact: ResolvedContact;
  work: ResolvedWork[];
  education: ResolvedEducation[];
  skills: ResolvedSkillGroup[];
  projects: ResolvedProject[];
  certificates: ResolvedCertificate[];
  awards: ResolvedAward[];
  languages: ResolvedLanguage[];
  publications: ResolvedPublication[];
  references: ResolvedReference[];
  sectionOrder: SectionName[];
  config: ResolvedProfileConfig;
  budget: Budget;
  /** Contexto de la vacante, cuando el CV está adaptado a una. */
  targetRole?: string;
  /** Aliases que la vacante usa y que el renderer debe preferir al canónico. */
  preferredAliases: Record<string, string>;
};

/* ========================================================================== *
 * ViewModel — lo mismo, ya formateado
 * ========================================================================== */

/**
 * Una unidad de texto con su rol semántico. Cada renderer la traduce a lo que
 * su formato entiende: `<h2>` en HTML, `Heading 2` en DOCX, MAYÚSCULAS con
 * subrayado en TXT. El rol nunca se pierde por el camino.
 */
export type SemanticRole =
  | 'name'
  | 'headline'
  | 'section'
  | 'role'
  | 'company'
  | 'date'
  | 'location'
  | 'bullet'
  | 'paragraph'
  | 'meta'
  | 'link';

export type VMLink = { text: string; href: string };

export type VMEntry = {
  id: string;
  /** Línea principal: el cargo. */
  title: string;
  /** Línea principal derecha: el rango de fechas ya formateado. */
  dateRange: string;
  /** Segunda línea: empresa e institución. */
  subtitle: string;
  /** Tercera línea opcional: ubicación, modalidad. */
  meta?: string;
  url?: string;
  summary?: string;
  bullets: string[];
  /** Posiciones adicionales en la misma empresa (promociones). */
  extraPositions: Array<{ title: string; dateRange: string }>;
};

export type VMSection = {
  name: SectionName;
  /** El label ya resuelto por el perfil regional: "Work Experience", "Berufserfahrung". */
  heading: string;
  kind: 'entries' | 'skills' | 'text' | 'inline-list';
  entries: VMEntry[];
  /** Para secciones de skills: grupos con su categoría. */
  groups: Array<{ label: string; items: string[] }>;
  /** Para secciones de texto plano (summary). */
  text?: string;
  /** Para listas en línea (idiomas, intereses). */
  items: string[];
};

export type VMHeader = {
  name: string;
  headline: string;
  /** Ya ordenados y listos para unirse con el separador del tema. */
  contactLines: string[];
  links: VMLink[];
};

export type ViewModel = {
  /** Alimenta `<html lang>`; sin él Chrome estampa el locale del SO en /Lang. */
  locale: string;
  /** Neutro y determinista: "Jane Doe — Resume". Nunca la empresa ni la variante. */
  documentTitle: string;
  paper: 'A4' | 'Letter';
  header: VMHeader;
  sections: VMSection[];
  /** Cláusula de consentimiento, sólo donde el mercado la exige. */
  consentClause?: string;
  /** Metadatos para el post-proceso del PDF. */
  meta: {
    author: string;
    subject: string;
    keywords: string[];
  };
  /** Escalón de densidad tipográfica que eligió el fit-loop. */
  density: 'comfortable' | 'normal' | 'dense' | 'ultra';
  /**
   * Secciones con contenido que `sectionOrder` dejó fuera del documento.
   *
   * `sectionOrder` decide orden y selección, así que un arquetipo puede excluir
   * secciones a propósito. Pero excluir en silencio es indistinguible de un
   * olvido, y el autor descubriría la falta recién al mirar el PDF: por eso las
   * omisiones viajan hasta la superficie y el CLI las informa.
   */
  omittedSections: SectionName[];
};

/* ========================================================================== *
 * Renderers
 * ========================================================================== */

export type RenderOptions = {
  density?: 'comfortable' | 'normal' | 'dense' | 'ultra';
  themeDir?: string;
  /**
   * El ResolvedCV, para los formatos que necesitan los datos crudos y no la
   * proyección de presentación (JSON Resume necesita fechas ISO e ids).
   */
  resolved?: ResolvedCV;
  /** `preview` usa el Chrome del sistema; `release` usa el Chromium pinneado. */
  channel?: 'preview' | 'release';
};

export type RenderResult = {
  format: OutputFormat;
  /** Buffer para PDF/DOCX, string para los formatos de texto. */
  content: Buffer | string;
  extension: string;
  /** Sólo PDF: cuántas páginas salieron. */
  pages?: number;
};

export type Renderer = {
  format: OutputFormat;
  extension: string;
  render(vm: ViewModel, opts?: RenderOptions): Promise<RenderResult>;
};

/* ========================================================================== *
 * Diagnósticos del linter
 * ========================================================================== */

export type LintSeverity = 'error' | 'warning';

export type LintFinding = {
  /** Identificador estable de la regla: ATS-001, ATS-052, … */
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Dónde: un selector CSS, un path del modelo, un número de página. */
  where?: string;
  /** Qué hacer al respecto. */
  fix?: string;
};

export type LintReport = {
  /** El formato verificado, o la batería cuando no verifica un artefacto concreto. */
  format: OutputFormat | 'css' | 'data' | 'ethics';
  findings: LintFinding[];
  passed: boolean;
};

export type LoadedPerson = {
  slug: string;
  dir: string;
  profile: PersonProfile;
  /** Narrativa por locale no primario, indexada por id. */
  i18n: Record<string, Record<string, unknown>>;
};
