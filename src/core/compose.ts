import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { deepmergeCustom } from 'deepmerge-ts';
import type { z } from 'zod';
import {
  FitPolicy,
  IndustryProfile,
  RegionProfile,
  Rubric,
  SeniorityProfile,
  SkillTaxonomy,
} from './schema/config.ts';
import type { ResolvedProfileConfig } from './schema/config.ts';
import type { SectionName, Target } from './schema/tailoring.ts';
import { CvDataError, formatIssues, isRecord, parseYamlWith, readYaml, style } from './load.ts';

/**
 * Composición de la configuración: región → industria → seniority → target.
 *
 * Son ejes ORTOGONALES, no una matriz de plantillas: 10 regiones × 7 industrias
 * × 5 seniorities serían 350 archivos; como ejes son 22.
 *
 * La regla que hace que la composición sea sana: los OBJETOS se fusionan en
 * profundidad, los ARRAYS REEMPLAZAN. Concatenar `sectionOrder` entre capas
 * produce un orden con secciones repetidas, y concatenar `forbiddenFields` deja
 * campos prohibidos que la capa derivada quiso levantar. Ninguna de las dos
 * cosas falla: producen un CV mal armado en silencio.
 */

/**
 * `mergeArrays: false` hace que deepmerge-ts derive los arrays a `mergeOthers`,
 * que se queda con el último valor. Es exactamente "el array de la capa de
 * arriba reemplaza al de abajo".
 */
const mergeDeep = deepmergeCustom({ mergeArrays: false }) as unknown as (
  ...objects: ReadonlyArray<Record<string, unknown>>
) => Record<string, unknown>;

/**
 * Orden por defecto cuando ninguna capa lo declara. Es la convención `tech` del
 * mercado general; cualquier perfil puede reemplazarlo entero.
 */
export const DEFAULT_SECTION_ORDER: SectionName[] = [
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
];

export type ComposeOptions = {
  /** Clave de `config/regions/`. Decide papel, páginas y campos prohibidos. */
  region: string;
  /** Clave de `config/industries/`. */
  industry: string;
  /** Clave de `config/seniority/`. */
  seniority?: string;
  /** El arquetipo ya cargado; sólo su `sectionOrder` entra en esta configuración. */
  target?: Pick<Target, 'sectionOrder'>;
};

/* ========================================================================== *
 * Lectura de un eje de configuración
 * ========================================================================== */

type ChainLink = { id: string; label: string; raw: Record<string, unknown> };

async function availableIds(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((entry) => path.extname(entry) === '.yaml')
      .map((entry) => path.basename(entry, '.yaml'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function chainNote(chain: readonly ChainLink[]): string {
  if (chain.length < 2) return '';
  return `\n      ${style.hint(`Cadena de herencia: ${chain.map((link) => link.id).join(' → ')}.`)}`;
}

/**
 * Carga un perfil resolviendo su cadena de `extends` antes de componer.
 *
 * La cadena se fusiona sobre los datos CRUDOS de cada archivo y recién después
 * se valida el resultado. Validar archivo por archivo no sirve acá: un perfil
 * derivado declara sólo su diff (`ca` extends `us` no repite `datePattern`), y
 * además los `.default([])` del schema materializarían arrays vacíos que —con
 * la regla de que los arrays reemplazan— borrarían los del ancestro.
 *
 * Lo que sí se valida por archivo son las claves desconocidas: es el único error
 * que la validación del resultado compuesto no puede atribuir a su origen, y es
 * justo el que el schema estricto existe para atrapar.
 */
async function loadChain<S extends z.ZodType>(
  root: string,
  family: string,
  id: string,
  schema: S,
): Promise<z.output<S>> {
  const dir = path.join(root, 'config', family);
  const chain: ChainLink[] = [];
  const visited: string[] = [];
  let current: string = id;

  for (;;) {
    if (visited.includes(current)) {
      throw new CvDataError(
        `${style.error('✖')} Ciclo en la cadena de "extends": ${[...visited, current].join(' → ')}.\n      ${style.hint(`Cortá la herencia en ${path.join('config', family, `${current}.yaml`)}.`)}`,
      );
    }
    visited.push(current);

    const file = path.join(dir, `${current}.yaml`);
    const src = await readYaml(file, path.relative(root, file));
    if (src === null) {
      const available = await availableIds(dir);
      const from = chain.length > 0 ? ` (referenciado desde "${chain[0]?.id}")` : '';
      throw new CvDataError(
        `${style.error('✖')} No existe ${style.file(path.relative(root, file))}${from}.\n      ${style.hint(available.length > 0 ? `Disponibles: ${available.join(', ')}.` : `El directorio ${path.join('config', family)} está vacío.`)}`,
      );
    }
    if (!isRecord(src.data)) {
      throw new CvDataError(
        `${style.error('✖')} ${style.file(src.label)} — se esperaba un mapeo YAML (clave: valor).`,
      );
    }

    const probe = schema.safeParse(src.data);
    if (!probe.success) {
      const typos = probe.error.issues.filter((issue) => issue.code === 'unrecognized_keys');
      if (typos.length > 0) throw new CvDataError(formatIssues(typos, src.label, src, schema));
    }

    chain.unshift({ id: current, label: src.label, raw: src.data });

    const next = src.data['extends'];
    if (next === undefined) break;
    if (typeof next !== 'string' || next.trim() === '') {
      throw new CvDataError(
        `${style.error('✖')} ${style.file(src.label)} — "extends" tiene que ser el id de otro perfil de ${path.join('config', family)}.`,
      );
    }
    current = next;
  }

  const merged = mergeDeep(...chain.map((link) => link.raw));
  const result = schema.safeParse(merged);
  if (!result.success) {
    const leaf = chain[chain.length - 1];
    throw new CvDataError(
      `${formatIssues(result.error.issues, leaf?.label ?? id, undefined, schema)}${chainNote(chain)}`,
    );
  }
  return result.data as z.output<S>;
}

/**
 * Política de ajuste de páginas.
 *
 * `FitPolicy` no es un campo de RegionProfile/IndustryProfile/SeniorityProfile:
 * el contrato de tipos no lo incluye y esos schemas son estrictos. La política
 * vive entonces en `config/fit.yaml` (global) y, opcionalmente, en
 * `config/fit/<id>.yaml` por eje, que se aplican en el mismo orden que el resto
 * de la composición.
 */
async function loadFit(
  root: string,
  ids: ReadonlyArray<string | undefined>,
): Promise<z.infer<typeof FitPolicy>> {
  const layers: Array<Record<string, unknown>> = [];
  const files = [
    path.join(root, 'config', 'fit.yaml'),
    ...ids.filter((id): id is string => id !== undefined).map((id) => path.join(root, 'config', 'fit', `${id}.yaml`)),
  ];

  for (const file of files) {
    const src = await readYaml(file, path.relative(root, file));
    if (src === null || src.data === null || src.data === undefined) continue;
    if (!isRecord(src.data)) {
      throw new CvDataError(
        `${style.error('✖')} ${style.file(src.label)} — se esperaba un mapeo YAML (clave: valor).`,
      );
    }
    // Todos los campos de FitPolicy son opcionales: cada archivo se valida
    // entero y aun así aporta sólo lo que declara.
    parseYamlWith(FitPolicy, src);
    layers.push(src.data);
  }

  return FitPolicy.parse(layers.length === 0 ? {} : mergeDeep(...layers));
}

/* ========================================================================== *
 * Capas
 * ========================================================================== */

type Layer = Partial<ResolvedProfileConfig>;

function omitUndefined(layer: Layer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function regionLayer(region: z.infer<typeof RegionProfile>): Layer {
  return {
    paper: region.paper,
    documentType: region.documentType,
    pageBudget: region.pageBudget,
    forbiddenFields: region.forbiddenFields,
    customaryFields: region.customaryFields,
    referencesPolicy: region.referencesPolicy,
    datePattern: region.datePattern,
    sectionLabels: region.sectionLabels,
    sectionOrder: region.sectionOrder,
    consentClause: region.consentClause,
  };
}

function industryLayer(industry: z.infer<typeof IndustryProfile>): Layer {
  return {
    pageBudget: industry.pageBudget,
    sectionOrder: industry.sectionOrder,
    colorPolicy: industry.colorPolicy,
    citationStyle: industry.citationStyle,
  };
}

function seniorityLayer(seniority: z.infer<typeof SeniorityProfile>): Layer {
  return {
    pageBudget: seniority.pageBudget,
    sectionOrder: seniority.sectionOrder,
  };
}

/* ========================================================================== *
 * API
 * ========================================================================== */

/**
 * Compone la configuración efectiva de un CV a partir de sus ejes.
 *
 * Admite las dos formas de llamada por comodidad del que la invoca:
 *
 *   composeConfig('/repo', { region, industry })
 *   composeConfig({ root: '/repo', region, industry })
 */
export async function composeConfig(
  rootOrOpts: string | (ComposeOptions & { root: string }),
  maybeOpts?: ComposeOptions,
): Promise<ResolvedProfileConfig> {
  const root = typeof rootOrOpts === 'string' ? rootOrOpts : rootOrOpts.root;
  const opts: ComposeOptions =
    typeof rootOrOpts === 'string'
      ? (maybeOpts as ComposeOptions)
      : rootOrOpts;
  const region = await loadChain(root, 'regions', opts.region, RegionProfile);
  const industry = await loadChain(root, 'industries', opts.industry, IndustryProfile);

  let seniority: z.infer<typeof SeniorityProfile> | undefined;
  if (opts.seniority !== undefined) {
    const file = path.join(root, 'config', 'seniority', `${opts.seniority}.yaml`);
    const src = await readYaml(file, path.relative(root, file));
    if (src === null) {
      const available = await availableIds(path.join(root, 'config', 'seniority'));
      throw new CvDataError(
        `${style.error('✖')} No existe ${style.file(path.relative(root, file))}.\n      ${style.hint(available.length > 0 ? `Disponibles: ${available.join(', ')}.` : 'El directorio config/seniority está vacío.')}`,
      );
    }
    seniority = parseYamlWith(SeniorityProfile, src);
  }

  const layers: Array<Record<string, unknown>> = [
    omitUndefined(regionLayer(region)),
    omitUndefined(industryLayer(industry)),
  ];
  if (seniority !== undefined) layers.push(omitUndefined(seniorityLayer(seniority)));
  if (opts.target?.sectionOrder !== undefined) {
    layers.push({ sectionOrder: opts.target.sectionOrder });
  }

  const merged = mergeDeep(...layers) as Layer;
  const fit = await loadFit(root, [opts.region, opts.industry, opts.seniority]);

  // Los `??` son defensivos: el schema de región ya garantiza estos campos.
  return {
    paper: merged.paper ?? region.paper,
    documentType: merged.documentType ?? region.documentType,
    pageBudget: merged.pageBudget ?? region.pageBudget,
    forbiddenFields: merged.forbiddenFields ?? [],
    customaryFields: merged.customaryFields ?? [],
    referencesPolicy: merged.referencesPolicy ?? region.referencesPolicy,
    datePattern: merged.datePattern ?? region.datePattern,
    sectionLabels: merged.sectionLabels ?? {},
    sectionOrder: merged.sectionOrder ?? DEFAULT_SECTION_ORDER,
    colorPolicy: merged.colorPolicy ?? industry.colorPolicy,
    citationStyle: merged.citationStyle,
    consentClause: merged.consentClause,
    fit,
  };
}

/** Umbrales del linter, cada uno con su fuente y nivel de confianza. */
export async function loadRubric(root: string): Promise<z.infer<typeof Rubric>> {
  const file = path.join(root, 'config', 'rubric.yaml');
  const src = await readYaml(file, path.relative(root, file));
  if (src === null) {
    throw new CvDataError(
      `${style.error('✖')} No existe ${style.file(path.relative(root, file))}.\n      ${style.hint('Los umbrales del linter viven ahí anotados con fuente y confianza; hardcodearlos los convertiría en dogma.')}`,
    );
  }
  return parseYamlWith(Rubric, src);
}

/** Resolución canónica de skills: una habilidad, muchas formas de nombrarla. */
export async function loadTaxonomy(root: string): Promise<z.infer<typeof SkillTaxonomy>> {
  const file = path.join(root, 'config', 'taxonomy', 'skills.yaml');
  const src = await readYaml(file, path.relative(root, file));
  if (src === null) {
    throw new CvDataError(
      `${style.error('✖')} No existe ${style.file(path.relative(root, file))}.\n      ${style.hint('Sin taxonomía el matcher no resuelve alias: "PMP certified" y "Project Management Professional" quedan como términos distintos.')}`,
    );
  }
  return parseYamlWith(SkillTaxonomy, src);
}
