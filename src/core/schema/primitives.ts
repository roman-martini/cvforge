import { z } from 'zod';

/**
 * Tipos base compartidos por todo el modelo.
 *
 * Dos reglas gobiernan este archivo:
 *
 * 1. Todo objeto se declara con `z.strictObject`, nunca `z.object`. El YAML es
 *    la *entrada* del sistema, y `z.toJSONSchema({ io: 'input' })` no emite
 *    `additionalProperties: false` para `z.object`. Con `z.object`, un campo
 *    mal tipeado (`sumary:`) se descarta en silencio y el CV sale sin esa
 *    información sin que nada falle.
 *
 * 2. Los campos que YAML convertiría a number se tipan como string estricto,
 *    nunca como `z.union([z.string(), z.number()])`. `phone: +5491155555555`
 *    sin comillas se parsea como número y pierde el `+`; `postalCode: 01234`
 *    se vuelve 1234. Aceptar ambos tipos convierte un fallo ruidoso (que el
 *    autor corrige en 10 segundos) en uno silencioso que llega al reclutador.
 */

/** Identificador estable de un ítem. Habilita overlays, i18n y trazabilidad. */
export const Id = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/,
    'Un id sólo admite minúsculas, dígitos, punto y guion (ej. "work.acme-2023").',
  );
export type Id = z.infer<typeof Id>;

/** `YYYY-MM`. Zod no trae helper para año-mes (`z.iso.month()` no existe). */
export const YearMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Usá el formato YYYY-MM entre comillas (ej. "2023-04").');
export type YearMonth = z.infer<typeof YearMonth>;

/** `YYYY-MM-DD`. */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

/** Fecha de precisión variable: año-mes o día exacto. */
export const FlexDate = z.union([YearMonth, IsoDate]);
export type FlexDate = z.infer<typeof FlexDate>;

export const Locale = z.enum(['es', 'en', 'de', 'fr', 'pt', 'it']);
export type Locale = z.infer<typeof Locale>;

/**
 * `private` excluye el campo de la proyección publicable (HTML, portfolio).
 * No es cifrado: es control de superficie de exposición.
 */
export const Visibility = z.enum(['public', 'private']);
export type Visibility = z.infer<typeof Visibility>;

export const SkillLevel = z.enum(['beginner', 'intermediate', 'advanced', 'expert']);
export type SkillLevel = z.infer<typeof SkillLevel>;

/** Marco Común Europeo, más `native`. */
export const Fluency = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']);
export type Fluency = z.infer<typeof Fluency>;

export const Seniority = z.enum(['student', 'entry', 'junior', 'mid', 'senior', 'staff', 'exec']);
export type Seniority = z.infer<typeof Seniority>;

export const WorkMode = z.enum(['remote', 'hybrid', 'onsite']);
export type WorkMode = z.infer<typeof WorkMode>;

/**
 * Procedencia de un texto. El build falla si una variante `llm_draft` llega a
 * un CV renderizado (regla ATS-090): el modo de falla más probable de un
 * generador automático es el drift semántico al refrasear ("colaboré en" →
 * "lideré"), y es exactamente lo que se cae en la entrevista.
 */
export const Provenance = z.strictObject({
  source: z.enum(['human', 'llm_draft', 'llm_approved']),
  derivedFrom: Id.optional(),
  approvedBy: z.string().optional(),
  approvedAt: IsoDate.optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** ISO-3166-1 alpha-2. Con comillas obligatorias: `NO` sin comillas es `false` en YAML 1.1. */
export const CountryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Código de país ISO-3166-1 alpha-2 en mayúsculas y entre comillas (ej. "AR").');
export type CountryCode = z.infer<typeof CountryCode>;

/** Prioridad 0-100. Desempata cuando el presupuesto de páginas aprieta. */
export const Priority = z.number().int().min(0).max(100);

/** Etiquetas libres para matching contra requisitos de una vacante. */
export const Tags = z.array(z.string().min(1));

/** Campos comunes a todo ítem seleccionable por un overlay. */
export const selectableFields = {
  id: Id,
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
} as const;
