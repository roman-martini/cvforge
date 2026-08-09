import { z } from 'zod';
import { CountryCode, Id, IsoDate, Locale, SkillLevel, WorkMode } from './primitives.ts';

/**
 * Las tres capas del tailoring, de más general a más específica:
 *
 *   config/  →  target  →  overlay
 *
 * El `target` (arquetipo) es donde vive el 80 % del trabajo: "backend senior
 * en inglés para mercado US". Se escribe una vez y se reusa en N vacantes.
 * El `overlay` es el diff mínimo contra ese arquetipo para una vacante puntual.
 *
 * Sin la capa intermedia, cada postulación rehace el matching desde cero y el
 * sistema deja de escalar justo cuando empieza a servir.
 */

/** Nombres canónicos de sección. El orden se decide por perfil, no en el template. */
export const SectionName = z.enum([
  'contact',
  'summary',
  'skills',
  'work',
  'education',
  'certificates',
  'projects',
  'awards',
  'languages',
  'publications',
  'references',
  'interests',
]);
export type SectionName = z.infer<typeof SectionName>;

export const OutputFormat = z.enum(['pdf', 'docx', 'txt', 'md', 'html', 'jsonresume']);
export type OutputFormat = z.infer<typeof OutputFormat>;

/** Cuánto contenido entra. El fit-loop lo usa para recortar sin romper el CV. */
export const Budget = z.strictObject({
  maxPages: z.number().int().min(1).max(20).default(2),
  /** Bullets por rol según antigüedad: lo reciente pesa más. */
  bulletsPerRole: z
    .strictObject({
      recent: z.number().int().min(0).default(5),
      mid: z.number().int().min(0).default(3),
      old: z.number().int().min(0).default(2),
    })
    .default({ recent: 5, mid: 3, old: 2 }),
  maxWords: z.number().int().min(100).max(5000).optional(),
});
export type Budget = z.infer<typeof Budget>;

/**
 * Arquetipo reutilizable: `targets/backend-senior-en.yaml`.
 */
export const Target = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  locale: Locale,
  /** Clave de config/regions/*.yaml. Decide papel, páginas y campos prohibidos. */
  region: z.string().min(1),
  /** Clave de config/industries/*.yaml. */
  industry: z.string().min(1).default('tech'),
  seniority: z.string().min(1).optional(),
  theme: z.string().min(1).default('ats-classic'),
  /** El puesto al que se apunta; alimenta basics.label si no se overridea. */
  titleTarget: z.string().optional(),
  /** Términos canónicos del arquetipo; el matcher los usa como semilla. */
  keywords: z.array(z.string()).default([]),
  sectionOrder: z.array(SectionName).optional(),
  budget: Budget.optional(),
  /** Placeholders: {First} {Last} {Role} {Company} {ext}. Nunca incluye la variante. */
  fileNameTemplate: z.string().default('{First}-{Last}-{Role}.{ext}'),
  formats: z.array(OutputFormat).default(['pdf', 'docx', 'txt']),
});
export type Target = z.infer<typeof Target>;

/* ========================================================================== *
 * La vacante, atomizada
 * ========================================================================== */

export const Requirement = z.strictObject({
  id: Id,
  text: z.string().min(1),
  /** `must` no cubierto es un gap real; `nice` es oportunidad. */
  kind: z.enum(['must', 'nice']),
  category: z.enum(['hard', 'soft', 'cert', 'domain', 'experience', 'education', 'language']),
  weight: z.number().int().min(1).max(10).default(5),
});
export type Requirement = z.infer<typeof Requirement>;

export const Job = z.strictObject({
  source: z.strictObject({
    url: z.url().optional(),
    capturedAt: IsoDate,
    board: z.string().optional(),
  }),
  company: z.strictObject({
    name: z.string().min(1),
    industry: z.string().optional(),
    size: z.string().optional(),
  }),
  title: z.string().min(1),
  type: z.enum(['full-time', 'part-time', 'contract', 'internship', 'temporary']).optional(),
  /** Enum del job-schema oficial de JSON Resume. */
  remote: z.enum(['Full', 'Hybrid', 'None']).optional(),
  location: z
    .strictObject({ city: z.string().optional(), countryCode: CountryCode.optional() })
    .optional(),
  requirements: z.array(Requirement).default([]),
  /**
   * Las preguntas eliminatorias del formulario. Este es el único auto-rechazo
   * masivo y real del proceso — no el parseo del PDF.
   */
  knockouts: z
    .array(
      z.strictObject({
        id: Id,
        question: z.string().min(1),
        expects: z.string().min(1),
      }),
    )
    .default([]),
  skills: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        level: SkillLevel.optional(),
        keywords: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  workModes: z.array(WorkMode).default([]),
});
export type Job = z.infer<typeof Job>;

/* ========================================================================== *
 * Overlay: selección y reordenamiento por id. Nunca merge de arrays.
 * ========================================================================== */

/**
 * Overrides sólo de campos NARRATIVOS. Los hechos (empleador, fechas, títulos,
 * educación) son inmutables desde un overlay: esa restricción es lo que hace
 * que el fraude sea estructuralmente difícil, no meramente desaconsejado.
 */
export const BulletSelection = z.strictObject({
  include: z.array(Id).optional(),
  exclude: z.array(Id).optional(),
  order: z.array(Id).optional(),
  variant: z.enum(['short', 'long', 'default']).default('default'),
});

export const EntryOverride = z.strictObject({
  summary: z.string().optional(),
  bullets: BulletSelection.optional(),
});

export const SectionSelection = z.strictObject({
  include: z.array(Id).optional(),
  exclude: z.array(Id).optional(),
  order: z.array(Id).optional(),
  overrides: z.record(Id, EntryOverride).optional(),
});

export const Overlay = z.strictObject({
  /** id de un target en targets/. */
  extends: z.string().min(1),
  job: z.string().optional(),
  locale: Locale.optional(),
  theme: z.string().optional(),
  basics: z
    .strictObject({
      label: z.string().optional(),
      summary: z.string().optional(),
    })
    .optional(),
  sectionOrder: z.array(SectionName).optional(),
  /** Un overlay declara sólo las secciones que toca, de ahí `partialRecord`. */
  sections: z.partialRecord(SectionName, SectionSelection).default({}),
  budget: Budget.partial().optional(),
  formats: z.array(OutputFormat).optional(),
  fileNameTemplate: z.string().optional(),
});
export type Overlay = z.infer<typeof Overlay>;
export type SectionSelection = z.infer<typeof SectionSelection>;
export type EntryOverride = z.infer<typeof EntryOverride>;

/* ========================================================================== *
 * meta.yaml de la postulación: trazabilidad y funnel
 * ========================================================================== */

export const ApplicationState = z.enum([
  'draft',
  'sent',
  'ack',
  'screening',
  'tech',
  'onsite',
  'offer',
  'rejected',
  'ghosted',
]);

export const ApplicationMeta = z.strictObject({
  state: ApplicationState.default('draft'),
  channel: z.enum(['portal', 'linkedin', 'referral', 'email', 'other']).optional(),
  timeline: z
    .array(z.strictObject({ state: ApplicationState, at: z.string(), note: z.string().optional() }))
    .default([]),
  rejectedStage: z.string().nullable().default(null),
  /** Se guarda el hash de lo enviado, no el binario: trazabilidad sin exponer PII. */
  artifacts: z
    .array(
      z.strictObject({
        format: OutputFormat,
        filename: z.string(),
        sha256: z.string().length(64),
        bytes: z.number().int().positive(),
        pages: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  /** Sin esto no hay reproducibilidad: la paginación cambia con la versión del browser. */
  provenance: z
    .strictObject({
      gitSha: z.string().optional(),
      inputHash: z.string().optional(),
      browser: z.strictObject({ name: z.string(), version: z.string() }).optional(),
      theme: z.string().optional(),
      generatedAt: z.string().optional(),
    })
    .optional(),
});
export type ApplicationMeta = z.infer<typeof ApplicationMeta>;

/** Respuestas exactas enviadas en el formulario, validadas contra eligibility. */
export const Questions = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        id: Id,
        question: z.string().min(1),
        answer: z.string().min(1),
        derivedFrom: z.string().optional(),
      }),
    )
    .default([]),
});
export type Questions = z.infer<typeof Questions>;

export const CoverLetter = z.strictObject({
  /**
   * Obligatorio y escrito a mano. El build falla si está vacío: lo que los
   * reclutadores detectan y descartan no es que sea generada, es que sea
   * genérica.
   */
  companyContext: z.string().min(20),
  hook: z.string().optional(),
  /** ids de bullets ya scoreados que se reusan como prueba de impacto. */
  achievements: z.array(Id).default([]),
  fit: z.string().optional(),
  cta: z.string().optional(),
});
export type CoverLetter = z.infer<typeof CoverLetter>;
