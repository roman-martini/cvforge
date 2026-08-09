import { z } from 'zod';
import { SectionName, Budget, OutputFormat } from './tailoring.ts';

/**
 * Perfiles de configuración: región, industria y seniority son ejes
 * ORTOGONALES que se componen (region → industry → seniority → target), nunca
 * una matriz de plantillas. 10 regiones × 7 industrias × 5 seniorities serían
 * 350 plantillas; como ejes son 22 archivos.
 */

/** Un campo prohibido no se suprime en silencio: rompe el build citando la fuente. */
export const ForbiddenField = z.strictObject({
  field: z.string().min(1),
  reason: z.string().min(1),
  /** La norma o institución concreta. Sin fuente, la regla es dogma. */
  source: z.string().min(1),
});

export const RegionProfile = z.strictObject({
  id: z.string().min(1),
  /** Otro perfil del que hereda antes de aplicar lo propio. */
  extends: z.string().optional(),
  label: z.string().min(1),
  /** Cómo se llama el documento en ese mercado: "Resume", "CV", "Lebenslauf". */
  documentType: z.string().min(1),
  paper: z.enum(['A4', 'Letter']),
  locale: z.string().optional(),
  pageBudget: z.strictObject({ min: z.number().int(), max: z.number().int() }),
  /** Campos que no deben aparecer, con su fundamento legal o institucional. */
  forbiddenFields: z.array(ForbiddenField).default([]),
  /** Campos habituales pero opcionales en ese mercado. */
  customaryFields: z.array(z.string()).default([]),
  /** `omit` | `on-request-line` | `full`. */
  referencesPolicy: z.enum(['omit', 'on-request-line', 'full']).default('omit'),
  /** Patrón de fecha único para todo el documento. */
  datePattern: z.string().min(1),
  /**
   * Etiquetas de sección en el idioma y convención del mercado.
   * `partialRecord` y no `record`: con un enum como clave, `z.record` exige las
   * 12 secciones en cada perfil regional, y un perfil sólo necesita declarar
   * las que redefine.
   */
  sectionLabels: z.partialRecord(SectionName, z.string()).default({}),
  sectionOrder: z.array(SectionName).optional(),
  /** Cláusula de consentimiento de datos, requerida sólo en algunos mercados. */
  consentClause: z
    .strictObject({
      required: z.boolean().default(false),
      requiredIf: z.array(z.string()).default([]),
      text: z.string().optional(),
    })
    .optional(),
  notes: z.string().optional(),
});
export type RegionProfile = z.infer<typeof RegionProfile>;

export const IndustryProfile = z.strictObject({
  id: z.string().min(1),
  extends: z.string().optional(),
  label: z.string().min(1),
  pageBudget: z.strictObject({ min: z.number().int(), max: z.number().int() }).optional(),
  sectionOrder: z.array(SectionName).optional(),
  /** `none` fuerza --accent al color de tinta: finanzas, consultoría, legal. */
  colorPolicy: z.enum(['none', 'accent', 'free']).default('accent'),
  formats: z.array(OutputFormat).optional(),
  /** Estilo de cita para publications, cuando la industria las usa. */
  citationStyle: z.enum(['apa', 'chicago', 'vancouver', 'ieee']).optional(),
  notes: z.string().optional(),
});
export type IndustryProfile = z.infer<typeof IndustryProfile>;

export const SeniorityProfile = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  pageBudget: z.strictObject({ min: z.number().int(), max: z.number().int() }).optional(),
  sectionOrder: z.array(SectionName).optional(),
  budget: Budget.partial().optional(),
  notes: z.string().optional(),
});
export type SeniorityProfile = z.infer<typeof SeniorityProfile>;

/**
 * Política de ajuste de páginas, declarada por perfil y en orden de sacrificio.
 *
 * Un presupuesto de páginas sin política de ajuste es un assert que bloquea al
 * usuario y lo empuja a editar el CV a mano — reintroduciendo exactamente el
 * acoplamiento datos/presentación que este workspace existe para evitar.
 */
export const FitPolicy = z.strictObject({
  densitySteps: z
    .array(z.enum(['comfortable', 'normal', 'dense', 'ultra']))
    .default(['comfortable', 'normal', 'dense', 'ultra']),
  maxBulletsPerRole: z
    .strictObject({
      recent: z.number().int().min(1),
      mid: z.number().int().min(1),
      old: z.number().int().min(1),
    })
    .optional(),
  /** Roles anteriores a N años colapsan en una línea "Experiencia anterior". */
  experienceCutoffYears: z.number().int().min(1).optional(),
  /** Secciones que se descartan, en orden, si aún no entra. */
  dropSections: z.array(SectionName).default([]),
  /** Si tras todo sigue sin entrar: fallar con un mensaje accionable. */
  failIfStillOverflows: z.boolean().default(true),
});
export type FitPolicy = z.infer<typeof FitPolicy>;

/**
 * Umbrales del linter. Viven acá y no hardcodeados porque muchos vienen de
 * fuentes de calidad desigual: anotar la fuente y la confianza evita que un
 * número de blog se convierta en dogma del sistema.
 */
export const Rubric = z.strictObject({
  thresholds: z.record(
    z.string(),
    z.strictObject({
      value: z.union([z.number(), z.string(), z.boolean()]),
      source: z.string().min(1),
      confidence: z.enum(['alta', 'media', 'baja']),
      note: z.string().optional(),
    }),
  ),
});
export type Rubric = z.infer<typeof Rubric>;

/** Resolución canónica de skills: una habilidad, muchas formas de nombrarla. */
export const SkillTaxonomy = z.strictObject({
  skills: z.array(
    z.strictObject({
      canonical: z.string().min(1),
      aliases: z.array(z.string()).default([]),
      category: z.string().optional(),
      /** Forma expandida, para emitir "Continuous Integration (CI)" cuando toca. */
      expanded: z.string().optional(),
    }),
  ),
});
export type SkillTaxonomy = z.infer<typeof SkillTaxonomy>;

/** El resultado de componer region → industry → seniority → target. */
export type ResolvedProfileConfig = {
  paper: 'A4' | 'Letter';
  documentType: string;
  pageBudget: { min: number; max: number };
  forbiddenFields: z.infer<typeof ForbiddenField>[];
  customaryFields: string[];
  referencesPolicy: 'omit' | 'on-request-line' | 'full';
  datePattern: string;
  sectionLabels: Partial<Record<SectionName, string>>;
  sectionOrder: SectionName[];
  colorPolicy: 'none' | 'accent' | 'free';
  citationStyle?: 'apa' | 'chicago' | 'vancouver' | 'ieee';
  consentClause?: { required: boolean; requiredIf: string[]; text?: string };
  fit: FitPolicy;
};
