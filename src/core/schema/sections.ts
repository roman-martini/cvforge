import { z } from 'zod';
import {
  CountryCode,
  FlexDate,
  Fluency,
  Id,
  IsoDate,
  Locale,
  Priority,
  Provenance,
  Seniority,
  SkillLevel,
  Tags,
  Visibility,
  WorkMode,
  YearMonth,
} from './primitives.ts';

/* ========================================================================== *
 * basics.yaml
 * ========================================================================== */

export const Profile = z.strictObject({
  id: Id,
  network: z.string().min(1),
  username: z.string().min(1),
  /** El renderer emite la URL completa como texto visible, no la palabra "LinkedIn". */
  url: z.url(),
  visibility: Visibility.default('public'),
});

export const Location = z.strictObject({
  city: z.string().min(1),
  region: z.string().optional(),
  countryCode: CountryCode,
  /** Sensible: vive en contact.private.yaml, nunca en profile/. */
  address: z.string().optional(),
  /** String obligatorio: `01234` sin comillas se parsea como 1234. */
  postalCode: z.string().optional(),
});

export const Basics = z.strictObject({
  name: z.string().min(1),
  /** Narrativo y traducible. Ej. "Senior Backend Engineer". */
  label: z.string().min(1),
  /** 2-4 frases. Narrativo y traducible. */
  summary: z.string().min(1),
  email: z.email(),
  /** String obligatorio: `+54911...` sin comillas pierde el `+` al parsearse como número. */
  phone: z.string().optional(),
  url: z.url().optional(),
  location: Location,
  profiles: z.array(Profile).default([]),
  /** Prohibida por los perfiles regionales us/uk/ca/nl/au (riesgo de discriminación). */
  photo: z
    .strictObject({ path: z.string().min(1), visibility: Visibility.default('private') })
    .optional(),
  /** Prohibida por us/uk/ca/nl/au/es. */
  birthDate: IsoDate.optional(),
  /** Sólo perfiles ar/latam con opt-in explícito. */
  nationalId: z.string().optional(),
});

/* ========================================================================== *
 * work.yaml — el corazón del modelo
 * ========================================================================== */

/**
 * Un logro en formato XYZ: "Accomplished [X] as measured by [Y] by doing [Z]".
 *
 * `metric` es deliberadamente OPCIONAL. Exigirla en cada bullet empuja a
 * inventar números, que es justo lo que se cae en la entrevista. Un bullet
 * claro, específico y verdadero sin número le gana a uno con un número
 * forzado; 2-4 anclas cuantificadas bien elegidas en todo el CV alcanzan.
 */
export const Bullet = z.strictObject({
  id: Id,
  /** X — el resultado. Va primero: el reclutador rara vez pasa del tercer bullet. */
  outcome: z.string().min(1),
  /** Y — la medida. */
  metric: z
    .strictObject({
      value: z.string().min(1),
      type: z.enum([
        'delta_pct',
        'absolute',
        'scope',
        'frequency',
        'scale',
        'selectivity',
        'duration',
        'proxy_qualitative',
      ]),
      confidence: z.enum(['measured', 'estimated', 'self_reported']),
    })
    .optional(),
  /** Z — el método. */
  method: z.string().optional(),
  tags: Tags.default([]),
  priority: Priority.default(50),
  /** Variantes de longitud para que el fit-loop recorte sin perder el hecho. */
  variants: z
    .strictObject({
      short: z.string().optional(),
      long: z.string().optional(),
    })
    .optional(),
  provenance: Provenance.default({ source: 'human' }),
  /** Marca que el dato fue contrastado contra una fuente (informe, dashboard). */
  verified: z.boolean().default(false),
});

/** Una posición dentro de la misma empresa: modela promociones sin duplicar el empleador. */
export const Position = z.strictObject({
  id: Id,
  /** Sin abreviaturas: "Senior Backend Engineer", nunca "Sr. SW Eng". */
  title: z.string().min(1),
  startDate: FlexDate,
  endDate: FlexDate.optional(),
  /** Si es true el compilador OMITE endDate, en vez de emitirla vacía o null. */
  current: z.boolean().default(false),
  seniority: Seniority.optional(),
});

export const WorkEntry = z.strictObject({
  id: Id,
  company: z.strictObject({
    /** Con sufijo legal ("Inc.", "S.A."): varios ATS parsean peor sin él. */
    name: z.string().min(1),
    url: z.url().optional(),
    industry: z.string().optional(),
  }),
  location: z
    .strictObject({
      city: z.string().optional(),
      countryCode: CountryCode.optional(),
      remote: WorkMode.optional(),
    })
    .optional(),
  positions: z.array(Position).min(1),
  summary: z.string().optional(),
  bullets: z.array(Bullet).default([]),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});

export const Work = z.array(WorkEntry);

/* ========================================================================== *
 * Resto de secciones
 * ========================================================================== */

export const EducationEntry = z.strictObject({
  id: Id,
  institution: z.string().min(1),
  url: z.url().optional(),
  /** Narrativo y traducible. */
  area: z.string().min(1),
  /** Narrativo y traducible ("Master", "Licenciatura"). */
  studyType: z.string().min(1),
  startDate: FlexDate.optional(),
  endDate: FlexDate.optional(),
  current: z.boolean().default(false),
  /** String: `4.0` sin comillas se parsea como 4 y se imprime "4". */
  score: z.string().optional(),
  courses: z.array(z.string()).default([]),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});
export const Education = z.array(EducationEntry);

export const SkillEntry = z.strictObject({
  id: Id,
  /** La forma canónica que se imprime por defecto. */
  canonical: z.string().min(1),
  /**
   * Formas alternativas del mismo concepto. El matcher las resuelve y el
   * renderer emite la que usa la vacante: varios ATS no resuelven que
   * "PMP certified" y "Project Management Professional" son lo mismo.
   */
  aliases: z.array(z.string()).default([]),
  category: z.string().min(1),
  level: SkillLevel.optional(),
  /** Se deriva de `work` cuando no se declara. */
  yearsOfExperience: z.number().int().min(0).max(60).optional(),
  keywords: z.array(z.string()).default([]),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});
export const Skills = z.array(SkillEntry);

export const ProjectEntry = z.strictObject({
  id: Id,
  name: z.string().min(1),
  description: z.string().optional(),
  highlights: z.array(Bullet).default([]),
  keywords: z.array(z.string()).default([]),
  startDate: FlexDate.optional(),
  endDate: FlexDate.optional(),
  url: z.url().optional(),
  roles: z.array(z.string()).default([]),
  entity: z.string().optional(),
  type: z.string().optional(),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});
export const Projects = z.array(ProjectEntry);

export const CertificateEntry = z.strictObject({
  id: Id,
  name: z.string().min(1),
  issuer: z.string().min(1),
  date: FlexDate,
  /** Alimenta las knockout questions del formulario ("¿tenés la cert vigente?"). */
  expiresAt: FlexDate.optional(),
  url: z.url().optional(),
  credentialId: z.string().optional(),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});
export const Certificates = z.array(CertificateEntry);

export const AwardEntry = z.strictObject({
  id: Id,
  title: z.string().min(1),
  date: FlexDate,
  awarder: z.string().min(1),
  summary: z.string().optional(),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});
export const Awards = z.array(AwardEntry);

export const LanguageEntry = z.strictObject({
  id: Id,
  language: z.string().min(1),
  fluency: Fluency,
  certification: z.string().optional(),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});
export const Languages = z.array(LanguageEntry);

/**
 * CSL-JSON: la publicación se guarda estructurada, nunca como string ya
 * formateada. Así el estilo de cita (APA, Chicago, Vancouver, IEEE) es una
 * decisión del renderer y no queda congelada en los datos.
 */
export const PublicationEntry = z.strictObject({
  id: Id,
  type: z.string().min(1),
  title: z.string().min(1),
  author: z
    .array(z.strictObject({ family: z.string(), given: z.string().optional() }))
    .default([]),
  'container-title': z.string().optional(),
  issued: z.strictObject({ 'date-parts': z.array(z.array(z.number().int())) }).optional(),
  DOI: z.string().optional(),
  URL: z.url().optional(),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('public'),
});
export const Publications = z.array(PublicationEntry);

/**
 * Referencias: sólo iniciales y rol. Los datos de contacto de un tercero
 * tienen una base legal distinta a los propios bajo GDPR y Ley 25.326 —
 * esa persona no consintió que su teléfono viva en tu repositorio.
 */
export const ReferenceEntry = z.strictObject({
  id: Id,
  initials: z.string().min(1).max(6),
  role: z.string().min(1),
  company: z.string().optional(),
  relationship: z.string().optional(),
  tags: Tags.default([]),
  priority: Priority.default(50),
  visibility: Visibility.default('private'),
});
export const References = z.array(ReferenceEntry);

/* ========================================================================== *
 * eligibility.yaml — las knockout questions son el único auto-rechazo real
 * ========================================================================== */

export const Eligibility = z.strictObject({
  workAuthorization: z
    .array(
      z.strictObject({
        countryCode: CountryCode,
        status: z.enum(['citizen', 'permanent_resident', 'work_permit', 'student_visa', 'none']),
        sponsorshipRequired: z.boolean().default(false),
        expiresAt: IsoDate.optional(),
      }),
    )
    .default([]),
  residence: z
    .strictObject({
      city: z.string().min(1),
      countryCode: CountryCode,
      timezone: z.string().optional(),
    })
    .optional(),
  workModes: z.array(WorkMode).default([]),
  relocation: z
    .strictObject({
      willing: z.boolean(),
      regions: z.array(z.string()).default([]),
    })
    .optional(),
  noticePeriod: z
    .strictObject({
      value: z.number().int().min(0),
      unit: z.enum(['days', 'weeks', 'months']),
    })
    .optional(),
  compensation: z
    .strictObject({
      currency: z.string().length(3),
      min: z.number().optional(),
      max: z.number().optional(),
      basis: z.enum(['gross_annual', 'net_annual', 'gross_monthly', 'net_monthly', 'hourly']),
      visibility: Visibility.default('private'),
    })
    .optional(),
  availableFrom: IsoDate.optional(),
});

/* ========================================================================== *
 * meta.yaml de la persona
 * ========================================================================== */

export const PersonMeta = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** Idioma en el que están redactados los campos narrativos de profile/. */
  primaryLocale: Locale,
  /** Locales adicionales disponibles en i18n/. */
  locales: z.array(Locale).default([]),
  modelVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Registro de que la persona consintió que sus datos vivan acá. */
  consent: z
    .strictObject({
      grantedBy: z.string(),
      grantedAt: IsoDate,
      purpose: z.string().default('Generación de CVs para postulaciones propias'),
    })
    .optional(),
});

/** El perfil completo de una persona, ya cargado desde los YAML. */
export const PersonProfile = z.strictObject({
  meta: PersonMeta,
  basics: Basics,
  work: Work.default([]),
  education: Education.default([]),
  skills: Skills.default([]),
  projects: Projects.default([]),
  certificates: Certificates.default([]),
  awards: Awards.default([]),
  languages: Languages.default([]),
  publications: Publications.default([]),
  references: References.default([]),
  eligibility: Eligibility.optional(),
});

export type Basics = z.infer<typeof Basics>;
export type Bullet = z.infer<typeof Bullet>;
export type Position = z.infer<typeof Position>;
export type WorkEntry = z.infer<typeof WorkEntry>;
export type EducationEntry = z.infer<typeof EducationEntry>;
export type SkillEntry = z.infer<typeof SkillEntry>;
export type ProjectEntry = z.infer<typeof ProjectEntry>;
export type CertificateEntry = z.infer<typeof CertificateEntry>;
export type AwardEntry = z.infer<typeof AwardEntry>;
export type LanguageEntry = z.infer<typeof LanguageEntry>;
export type PublicationEntry = z.infer<typeof PublicationEntry>;
export type ReferenceEntry = z.infer<typeof ReferenceEntry>;
export type Eligibility = z.infer<typeof Eligibility>;
export type PersonMeta = z.infer<typeof PersonMeta>;
export type PersonProfile = z.infer<typeof PersonProfile>;
export type Location = z.infer<typeof Location>;
export type Profile = z.infer<typeof Profile>;
