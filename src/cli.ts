#!/usr/bin/env node
/**
 * Interfaz de línea de comandos del workspace.
 *
 * Dos criterios gobiernan este archivo.
 *
 * 1. **Arranque barato.** No hay build step: el tiempo de import ES el tiempo
 *    de arranque. Por eso todo lo pesado (playwright, docx, pdfjs, los
 *    renderers, el linter) se carga con `await import()` dentro de la acción
 *    que lo necesita. `cv doctor`, `cv schema`, `cv new` y `cv report` no
 *    tocan ninguna de esas dependencias.
 *
 * 2. **Errores accionables.** Un mensaje que no dice archivo, clave y qué se
 *    esperaba obliga a leer el código para entenderlo. Todo error de datos sale
 *    por `printProblems()` con esas tres cosas.
 *
 * ── Contrato con los módulos del pipeline ──────────────────────────────────
 * La CLI orquesta; no implementa el pipeline. Espera estos exports (el nombre
 * se resuelve contra una lista de alias, y si ninguno existe el error dice
 * exactamente qué buscó y dónde):
 *
 *   core/load.ts       loadPerson(personDir): Promise<LoadedPerson>
 *   core/i18n.ts       localizeProfile(person, locale): PersonProfile
 *   core/compose.ts    composeConfig({ root, region, industry, seniority, target, overlay })
 *                        → ResolvedProfileConfig
 *   core/resolve.ts    resolveCV({ profile, target, overlay, job, config, locale, personSlug })
 *                        → ResolvedCV
 *   core/viewmodel.ts  buildViewModel(resolvedCV): ViewModel
 *   core/fit.ts        fitToBudget(vm, renderer, { maxPages, fit, themeDir, channel })
 *                        → RenderResult
 *   core/match.ts      matchProfile({ profile, job, taxonomy, eligibility }) → MatchResult
 *   renderers/<f>.ts   <f>Renderer: Renderer
 *   lint/<b>.ts        lint<B>(LintInput) → LintReport
 */

import { Command } from 'commander';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { PersonProfile } from './core/schema/sections.ts';
import type { Basics, Eligibility } from './core/schema/sections.ts';
import {
  ApplicationMeta,
  CoverLetter,
  Job,
  Overlay,
  OutputFormat,
  Questions,
  Target,
} from './core/schema/tailoring.ts';
// Budget se importa como valor, no como tipo: el CLI llama a Budget.parse({})
// para materializar los defaults del presupuesto cuando el target no lo declara.
import { Budget } from './core/schema/tailoring.ts';
import type { SectionName } from './core/schema/tailoring.ts';
import { SkillTaxonomy } from './core/schema/config.ts';
import type { ResolvedProfileConfig } from './core/schema/config.ts';
import { refineProfile } from './core/schema/refine.ts';
import type { Issue } from './core/schema/refine.ts';
import type {
  LintFinding,
  LintReport,
  LoadedPerson,
  RenderResult,
  Renderer,
  ResolvedCV,
  ViewModel,
} from './core/types.ts';
import { generateSchemas } from './scripts/gen-schemas.ts';

/* ========================================================================== *
 * Color y salida
 * ========================================================================== */

/**
 * `--no-color` se lee de argv crudo porque el color se decide antes de que
 * commander parsee, y los errores de parseo también tienen que respetarlo.
 */
const colorEnabled = ((): boolean => {
  if (process.argv.includes('--no-color')) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return process.stdout.isTTY === true;
})();

const paint =
  (open: number, close: number) =>
  (text: string): string =>
    colorEnabled ? `\u001B[${open}m${text}\u001B[${close}m` : text;

const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  blue: paint(34, 39),
  magenta: paint(35, 39),
  cyan: paint(36, 39),
  gray: paint(90, 39),
};

const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const warnOut = (line = ''): void => void process.stderr.write(`${line}\n`);

const badge = {
  ok: (): string => c.green('  ok  '),
  warn: (): string => c.yellow(' aviso'),
  fail: (): string => c.red(' error'),
  skip: (): string => c.gray(' omit '),
};

const VISIBLE = /\u001B\[[0-9;]*m/g;
const visibleLength = (text: string): number => text.replace(VISIBLE, '').length;

function padCell(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))),
  );
  out(c.bold(headers.map((h, i) => padCell(h, widths[i]!)).join('  ')));
  for (const row of rows) {
    out(row.map((cell, i) => padCell(cell ?? '', widths[i]!)).join('  '));
  }
}

function heading(text: string): void {
  out();
  out(c.bold(c.cyan(text)));
  out(c.gray('─'.repeat(Math.min(72, Math.max(24, text.length)))));
}

/* ========================================================================== *
 * Errores
 * ========================================================================== */

type ErrorDetail = {
  file?: string;
  keyPath?: string;
  expected?: string;
  received?: string;
  hint?: string;
};

class CliError extends Error {
  detail: ErrorDetail;
  constructor(message: string, detail: ErrorDetail = {}) {
    super(message);
    this.name = 'CliError';
    this.detail = detail;
  }
}

type Problem = {
  file: string;
  keyPath: string;
  message: string;
  expected?: string;
  received?: string;
  rule?: string;
  severity: 'error' | 'warning';
};

class ValidationError extends Error {
  problems: Problem[];
  constructor(message: string, problems: Problem[]) {
    super(message);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

function printProblems(problems: Problem[]): void {
  let currentFile = '';
  for (const problem of problems) {
    if (problem.file !== currentFile) {
      currentFile = problem.file;
      out();
      out(c.bold(currentFile));
    }
    const mark = problem.severity === 'error' ? badge.fail() : badge.warn();
    const rule = problem.rule ? c.gray(` [${problem.rule}]`) : '';
    out(`${mark} ${c.magenta(problem.keyPath || '(raíz)')}${rule}`);
    out(`       ${problem.message}`);
    if (problem.expected) out(`       ${c.gray('esperado:')} ${problem.expected}`);
    if (problem.received !== undefined) out(`       ${c.gray('recibido:')} ${problem.received}`);
  }
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'ausente';
  if (value === null) return 'null (en YAML, una clave sin valor es null)';
  if (Array.isArray(value)) return `array de ${value.length} elementos`;
  if (typeof value === 'string') return `"${value.length > 60 ? `${value.slice(0, 57)}…` : value}"`;
  if (typeof value === 'object') return `objeto con claves: ${Object.keys(value).join(', ')}`;
  return `${String(value)} (${typeof value})`;
}

function zodKeyPath(segments: ReadonlyArray<PropertyKey>): string {
  let result = '';
  for (const segment of segments) {
    if (typeof segment === 'number') result += `[${segment}]`;
    else result += result === '' ? String(segment) : `.${String(segment)}`;
  }
  return result;
}

function zodProblems(error: z.ZodError, file: string): Problem[] {
  return error.issues.map((issue): Problem => {
    const raw = issue as unknown as Record<string, unknown>;
    const problem: Problem = {
      file,
      keyPath: zodKeyPath(issue.path as ReadonlyArray<PropertyKey>),
      message: issue.message,
      severity: 'error',
    };
    if (issue.code === 'unrecognized_keys') {
      const keys = (raw.keys as string[] | undefined) ?? [];
      problem.message = `Clave no reconocida: ${keys.join(', ')}. El schema es estricto a propósito: un campo mal escrito se descartaría en silencio y el CV saldría sin esa información.`;
      problem.expected = 'una de las claves declaradas en el schema';
    } else if (issue.code === 'invalid_type') {
      problem.expected = String(raw.expected ?? 'otro tipo');
      problem.received = describeValue(raw.input);
    } else if ('input' in raw) {
      problem.received = describeValue(raw.input);
    }
    return problem;
  });
}

function reportFatal(error: unknown): void {
  out();
  if (error instanceof ValidationError) {
    printProblems(error.problems);
    out();
    warnOut(`${badge.fail()} ${c.bold(error.message)}`);
    return;
  }
  if (error instanceof CliError) {
    warnOut(`${badge.fail()} ${c.bold(error.message)}`);
    const { file, keyPath, expected, received, hint } = error.detail;
    if (file) warnOut(`       ${c.gray('archivo: ')}${file}`);
    if (keyPath) warnOut(`       ${c.gray('clave:   ')}${c.magenta(keyPath)}`);
    if (expected) warnOut(`       ${c.gray('esperado:')} ${expected}`);
    if (received !== undefined) warnOut(`       ${c.gray('recibido:')} ${received}`);
    if (hint) warnOut(`       ${c.gray('detalle: ')}${hint}`);
    return;
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  warnOut(`${badge.fail()} ${c.bold('Error inesperado')}`);
  warnOut(message);
}

/* ========================================================================== *
 * Rutas del workspace
 * ========================================================================== */

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(cliDir, '..');

const workspace = {
  root: repoRoot,
  people: path.join(repoRoot, 'people'),
  out: path.join(repoRoot, 'out'),
  config: path.join(repoRoot, 'config'),
  themes: path.join(repoRoot, 'src', 'themes'),
  schemas: path.join(repoRoot, 'schemas'),
  assets: path.join(repoRoot, 'assets'),
};

const rel = (file: string): string => path.relative(repoRoot, file).split(path.sep).join('/');

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(parent: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listYamlFiles(parent: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function requirePersonDir(slug: string): Promise<string> {
  const dir = path.join(workspace.people, slug);
  if (await exists(dir)) return dir;

  // Las personas de ejemplo viven en fixtures/ para no mezclarse con datos
  // reales, pero se resuelven igual: así el workspace se puede probar entero
  // recién clonado, sin copiar nada a people/.
  const fixtureDir = path.join(repoRoot, 'fixtures', 'people', slug);
  if (await exists(fixtureDir)) return fixtureDir;

  const available = [...(await listDirs(workspace.people)), ...(await listDirs(path.join(repoRoot, 'fixtures', 'people')))];
  throw new CliError(`No existe la persona "${slug}".`, {
    file: rel(dir),
    hint:
      available.length > 0
        ? `Personas disponibles: ${available.join(', ')}.`
        : 'No hay ninguna persona todavía. Creá una con `cv new <slug>`.',
  });
}

/* ========================================================================== *
 * Lectura de YAML con errores que apuntan al archivo y a la clave
 * ========================================================================== */

/**
 * Nunca se le pasa `{ version: '1.1' }` al parser: en YAML 1.1 `NO` se lee
 * como `false` (el "Norway problem"), `2023-04-01` se convierte en Date y
 * `01234` se interpreta en octal. El default del paquete es 1.2 core.
 */
async function readYaml<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new CliError(`No se encontró ${rel(file)}.`, { file: rel(file) });
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    throw new CliError(`El YAML de ${rel(file)} no se pudo parsear.`, {
      file: rel(file),
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ValidationError(
      `${parsed.error.issues.length} problema(s) de validación en ${rel(file)}.`,
      zodProblems(parsed.error, rel(file)),
    );
  }
  return parsed.data;
}

async function readYamlIfExists<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  if (!(await exists(file))) return undefined;
  return readYaml(file, schema);
}

/* ========================================================================== *
 * Carga perezosa de los módulos del pipeline
 * ========================================================================== */

type AnyModule = Record<string, unknown>;
const moduleCache = new Map<string, AnyModule>();

async function importLocal(relative: string): Promise<AnyModule> {
  const cached = moduleCache.get(relative);
  if (cached) return cached;
  try {
    const mod = (await import(new URL(relative, import.meta.url).href)) as AnyModule;
    moduleCache.set(relative, mod);
    return mod;
  } catch (error) {
    throw new CliError(`No se pudo cargar el módulo ${relative}.`, {
      file: `src/${relative.replace(/^\.\//, '')}`,
      hint: error instanceof Error ? error.message : String(error),
    });
  }
}

function pickExport<T>(mod: AnyModule, moduleName: string, candidates: string[]): T {
  for (const name of candidates) {
    const value = mod[name];
    if (typeof value === 'function' || (typeof value === 'object' && value !== null)) {
      return value as T;
    }
  }
  throw new CliError(`${moduleName} no exporta nada utilizable.`, {
    file: moduleName,
    expected: `alguno de: ${candidates.join(', ')}`,
    received: `exports presentes: ${Object.keys(mod).join(', ') || '(ninguno)'}`,
  });
}

function pickOptional<T>(mod: AnyModule, candidates: string[]): T | undefined {
  for (const name of candidates) {
    const value = mod[name];
    if (typeof value === 'function' || (typeof value === 'object' && value !== null)) {
      return value as T;
    }
  }
  return undefined;
}

/* ========================================================================== *
 * Tipos que la CLI define (no forman parte del contrato de datos)
 * ========================================================================== */

type OutputFormatName = z.infer<typeof OutputFormat>;

type ManifestFile = {
  format: OutputFormatName;
  file: string;
  bytes: number;
  sha256: string;
  pages?: number;
};

type BuildManifest = {
  slug: string;
  target: string;
  application?: string;
  locale: string;
  theme: string;
  paper: 'A4' | 'Letter';
  maxPages: number;
  density: string;
  generatedAt: string;
  files: ManifestFile[];
};

/** Entrada única de las cinco baterías del linter. */
type LintInput = {
  root: string;
  themeDir: string;
  locale: string;
  paper: 'A4' | 'Letter';
  maxPages: number;
  documentTitle: string;
  /** Ground truth textual: todo token de acá tiene que sobrevivir en PDF y DOCX. */
  txt: string;
  pdf?: Buffer;
  docx?: Buffer;
  profile?: z.infer<typeof PersonProfile>;
  resolved?: ResolvedCV;
  viewModel?: ViewModel;
  config?: ResolvedProfileConfig;
  overlay?: z.infer<typeof Overlay>;
  job?: z.infer<typeof Job>;
  i18n?: Record<string, Record<string, unknown>>;
  region?: string;
  companyName?: string;
  questions?: z.infer<typeof Questions>;
  coverLetter?: z.infer<typeof CoverLetter>;
};

type MatchEvidence = { id: string; score?: number };

type MatchRequirementResult = {
  id: string;
  text: string;
  kind: 'must' | 'nice';
  weight: number;
  evidence?: Array<string | MatchEvidence>;
  hint?: string;
};

type MatchResult = {
  score?: number;
  covered?: MatchRequirementResult[];
  missing?: MatchRequirementResult[];
  excludedButRelevant?: Array<{ id: string; reason?: string; requirements?: string[]; score?: number }>;
  knockouts?: Array<{ id: string; question: string; expects: string; answer?: string; ok?: boolean; note?: string }>;
  ranked?: Array<{ id: string; score: number; section?: SectionName }>;
  scores?: Record<string, number>;
};

/* ========================================================================== *
 * Utilidades
 * ========================================================================== */

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function parseFormats(value: string | undefined): OutputFormatName[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const parsed = z.array(OutputFormat).safeParse(names);
  if (!parsed.success) {
    throw new CliError(`Formato de salida desconocido en "--format ${value}".`, {
      expected: `una lista separada por comas de: ${OutputFormat.options.join(', ')}`,
      received: value,
    });
  }
  return parsed.data;
}

/** Sustituye {First} {Last} {Role} {Company} {ext} y sanea para el filesystem. */
function applyFileNameTemplate(
  template: string,
  values: { name: string; role: string; company: string; ext: string },
): string {
  const parts = values.name.trim().split(/\s+/);
  const first = parts[0] ?? 'CV';
  const last = parts.length > 1 ? parts[parts.length - 1]! : '';
  const clean = (text: string): string =>
    text
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .replace(/\s+/g, '-');

  return template
    .replaceAll('{First}', clean(first))
    .replaceAll('{Last}', clean(last))
    .replaceAll('{Role}', clean(values.role))
    .replaceAll('{Company}', clean(values.company))
    .replaceAll('{ext}', values.ext)
    .replace(/-+/g, '-')
    .replace(/-\./g, '.');
}

async function writeArtifact(file: string, content: Buffer | string): Promise<ManifestFile['bytes']> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (typeof content === 'string') {
    await fsp.writeFile(file, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
  }
  await fsp.writeFile(file, content);
  return content.byteLength;
}

/* ========================================================================== *
 * Resolución de target / overlay / aplicación
 * ========================================================================== */

type BuildContext = {
  slug: string;
  personDir: string;
  person: LoadedPerson;
  profile: z.infer<typeof PersonProfile>;
  target: z.infer<typeof Target>;
  targetId: string;
  overlay?: z.infer<typeof Overlay>;
  job?: z.infer<typeof Job>;
  application?: string;
  applicationDir?: string;
  locale: string;
  config: ResolvedProfileConfig;
  resolved: ResolvedCV;
  viewModel: ViewModel;
  themeDir: string;
  budget: Budget;
};

async function resolveApplicationDir(personDir: string, application: string): Promise<string> {
  const dir = path.join(personDir, 'applications', application);
  if (await exists(dir)) return dir;
  const available = await listDirs(path.join(personDir, 'applications'));
  throw new CliError(`No existe la postulación "${application}".`, {
    file: rel(dir),
    hint:
      available.length > 0
        ? `Postulaciones disponibles:\n         ${available.join('\n         ')}`
        : 'Todavía no hay postulaciones para esta persona.',
  });
}

async function resolveTargetId(
  personDir: string,
  explicit: string | undefined,
  overlay: z.infer<typeof Overlay> | undefined,
): Promise<string> {
  if (explicit) return explicit;
  if (overlay) return overlay.extends;
  const files = await listYamlFiles(path.join(personDir, 'targets'));
  if (files.length === 1) return files[0]!.replace(/\.ya?ml$/, '');
  throw new CliError(
    files.length === 0
      ? 'La persona no tiene ningún arquetipo en targets/.'
      : 'Hay más de un arquetipo y no se indicó cuál usar.',
    {
      file: rel(path.join(personDir, 'targets')),
      expected: '--target <id>',
      hint:
        files.length === 0
          ? 'Creá targets/<id>.yaml: ahí vive el 80 % del trabajo de adaptación y se reusa en todas las vacantes.'
          : `Arquetipos disponibles: ${files.map((f) => f.replace(/\.ya?ml$/, '')).join(', ')}.`,
    },
  );
}

async function loadTarget(personDir: string, targetId: string): Promise<z.infer<typeof Target>> {
  const yamlFile = path.join(personDir, 'targets', `${targetId}.yaml`);
  const ymlFile = path.join(personDir, 'targets', `${targetId}.yml`);
  const file = (await exists(yamlFile)) ? yamlFile : ymlFile;
  if (!(await exists(file))) {
    const available = await listYamlFiles(path.join(personDir, 'targets'));
    throw new CliError(`No existe el arquetipo "${targetId}".`, {
      file: rel(yamlFile),
      hint:
        available.length > 0
          ? `Disponibles: ${available.map((f) => f.replace(/\.ya?ml$/, '')).join(', ')}.`
          : 'Creá targets/<id>.yaml.',
    });
  }
  return readYaml(file, Target);
}

function mergeBudget(
  target: z.infer<typeof Target>,
  overlay: z.infer<typeof Overlay> | undefined,
  config: ResolvedProfileConfig,
): Budget {
  const base = target.budget ?? Budget.parse({});
  const maxPages = overlay?.budget?.maxPages ?? base.maxPages ?? config.pageBudget.max;
  return {
    maxPages: Math.min(maxPages, config.pageBudget.max),
    bulletsPerRole: overlay?.budget?.bulletsPerRole ?? base.bulletsPerRole,
    maxWords: overlay?.budget?.maxWords ?? base.maxWords,
  };
}

/**
 * Recorre las cinco primeras etapas del pipeline. Todo lo que sigue (render,
 * lint, reporte) trabaja sobre el `BuildContext` que devuelve.
 */
async function prepare(options: {
  slug: string;
  target?: string;
  application?: string;
  locale?: string;
  theme?: string;
}): Promise<BuildContext> {
  const personDir = await requirePersonDir(options.slug);

  const applicationDir = options.application
    ? await resolveApplicationDir(personDir, options.application)
    : undefined;

  const overlay = applicationDir
    ? await readYamlIfExists(path.join(applicationDir, 'overlay.yaml'), Overlay)
    : undefined;

  const job = applicationDir
    ? await readYamlIfExists(path.join(applicationDir, 'job.yaml'), Job)
    : undefined;

  const targetId = await resolveTargetId(personDir, options.target, overlay);
  const target = await loadTarget(personDir, targetId);

  const loadModule = await importLocal('./core/load.ts');
  const loadPerson = pickExport<(dir: string) => Promise<LoadedPerson> | LoadedPerson>(
    loadModule,
    'src/core/load.ts',
    ['loadPerson', 'loadProfile', 'load'],
  );
  const person = await loadPerson(personDir);

  const locale = options.locale ?? overlay?.locale ?? target.locale ?? person.profile.meta.primaryLocale;

  const i18nModule = await importLocal('./core/i18n.ts');
  const localizeProfile = pickExport<
    (person: LoadedPerson, locale: string) => Promise<z.infer<typeof PersonProfile>> | z.infer<typeof PersonProfile>
  >(i18nModule, 'src/core/i18n.ts', ['localizeProfile', 'applyLocale', 'resolveI18n', 'localize']);
  const profile = await localizeProfile(person, locale);

  const composeModule = await importLocal('./core/compose.ts');
  const composeConfig = pickExport<(input: unknown) => Promise<ResolvedProfileConfig> | ResolvedProfileConfig>(
    composeModule,
    'src/core/compose.ts',
    ['composeConfig', 'composeProfileConfig', 'compose'],
  );
  const config = await composeConfig({
    root: workspace.root,
    configDir: workspace.config,
    region: target.region,
    industry: target.industry,
    seniority: target.seniority,
    target,
    overlay,
  });

  const budget = mergeBudget(target, overlay, config);

  // Selección: qué ítems del perfil entran, en qué orden y con qué variante de
  // texto. Es el paso donde el arquetipo y el overlay dejan de ser declaraciones
  // y se convierten en el contenido del CV.
  const selectModule = await importLocal('./core/select.ts');
  const selectSections = pickExport<
    (profile: z.infer<typeof PersonProfile>, overlay: unknown, target: unknown) => z.infer<typeof PersonProfile>
  >(selectModule, 'src/core/select.ts', ['selectSections', 'select', 'applySelection']);
  const bulletVariants = pickOptional<(overlay: unknown) => Record<string, 'short' | 'long'>>(
    selectModule,
    ['bulletVariants'],
  );
  const selected = selectSections(profile, overlay ?? null, target);
  const variants = bulletVariants ? bulletVariants(overlay ?? null) : {};

  const resolveModule = await importLocal('./core/resolve.ts');
  const resolveCV = pickExport<(input: unknown) => Promise<ResolvedCV> | ResolvedCV>(
    resolveModule,
    'src/core/resolve.ts',
    ['resolveCV', 'buildResolvedCV', 'resolve'],
  );
  const resolved = await resolveCV({
    personSlug: options.slug,
    profile: selected,
    bulletVariants: variants,
    target,
    overlay,
    job,
    config,
    locale,
    budget,
  });

  const vmModule = await importLocal('./core/viewmodel.ts');
  const buildViewModel = pickExport<(cv: ResolvedCV) => Promise<ViewModel> | ViewModel>(
    vmModule,
    'src/core/viewmodel.ts',
    ['buildViewModel', 'toViewModel', 'viewModel'],
  );
  const viewModel = await buildViewModel(resolved);

  const themeName = options.theme ?? overlay?.theme ?? target.theme;

  return {
    slug: options.slug,
    personDir,
    person,
    // El perfil ya seleccionado: es el que describe este CV. La verificación de
    // datos tiene que correr sobre lo que se imprime, no sobre el pool completo.
    profile: selected,
    target,
    targetId,
    overlay,
    job,
    application: options.application,
    applicationDir,
    locale,
    config,
    resolved,
    viewModel,
    themeDir: path.join(workspace.themes, themeName),
    budget,
  };
}

async function loadRenderer(format: OutputFormatName): Promise<Renderer> {
  const moduleName = `./renderers/${format}.ts`;
  const mod = await importLocal(moduleName);
  return pickExport<Renderer>(mod, `src/renderers/${format}.ts`, [
    `${format}Renderer`,
    format === 'jsonresume' ? 'jsonResumeRenderer' : `${format}Renderer`,
    'renderer',
    'default',
  ]);
}

const LINT_BATTERIES = ['css', 'data', 'ethics', 'pdf', 'text', 'docx'] as const;
type LintBattery = (typeof LINT_BATTERIES)[number];

/**
 * Corre una batería a través de `src/lint/index.ts`.
 *
 * Cada batería tiene la forma de entrada que le conviene —la de CSS quiere las
 * hojas de estilo, la de PDF el binario, la de datos el modelo— y ese adaptador
 * es el único lugar que conoce las seis. El CLI le pasa el contexto completo y
 * no sabe nada de esas diferencias.
 */
async function runLintBattery(battery: LintBattery, input: LintInput): Promise<LintReport> {
  const mod = await importLocal('./lint/index.ts');
  const runLint = pickExport<
    (context: LintInput, only?: readonly LintBattery[]) => Promise<LintReport[]>
  >(mod, 'src/lint/index.ts', ['runLint', 'run']);
  const reports = await runLint(input, [battery]);
  return (
    reports[0] ?? {
      format: battery === 'text' ? 'txt' : battery,
      findings: [],
      passed: true,
    }
  );
}

function printLintReports(reports: LintReport[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const report of reports) {
    const failures = report.findings.filter((f) => f.severity === 'error');
    const notices = report.findings.filter((f) => f.severity === 'warning');
    errors += failures.length;
    warnings += notices.length;

    const mark = failures.length > 0 ? badge.fail() : notices.length > 0 ? badge.warn() : badge.ok();
    out(
      `${mark} ${c.bold(report.format.padEnd(11))} ${failures.length} error(es), ${notices.length} aviso(s)`,
    );
    for (const finding of report.findings) {
      printFinding(finding);
    }
  }
  return { errors, warnings };
}

function printFinding(finding: LintFinding): void {
  const tone = finding.severity === 'error' ? c.red : c.yellow;
  out(`        ${tone(finding.rule)} ${finding.message}`);
  if (finding.where) out(`        ${c.gray(`dónde: ${finding.where}`)}`);
  if (finding.fix) out(`        ${c.gray(`arreglo: ${finding.fix}`)}`);
}

/* ========================================================================== *
 * cv new
 * ========================================================================== */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const REGION_BY_COUNTRY: Record<string, string> = {
  AR: 'ar',
  AU: 'au',
  CA: 'ca',
  DE: 'de',
  ES: 'es',
  FR: 'fr',
  GB: 'uk',
  NL: 'nl',
  PL: 'pl',
  US: 'us',
};

async function ask(rl: readline.Interface | undefined, question: string, fallback: string): Promise<string> {
  if (!rl) return fallback;
  const answer = (await rl.question(`${c.cyan('?')} ${question} ${c.gray(`(${fallback})`)} `)).trim();
  return answer === '' ? fallback : answer;
}

function personMetaTemplate(slug: string, locale: string, name: string): string {
  return `# yaml-language-server: $schema=../../schemas/generated/person-meta.schema.json
#
# primaryLocale es el idioma en el que están redactados los campos narrativos
# de profile/. Los demás idiomas viven en i18n/<locale>.yaml indexados por id,
# nunca duplicando la estructura: si duplicás el CV por idioma, cada empresa,
# fecha y URL pasa a mantenerse dos veces y se desincroniza en semanas.

slug: "${slug}"
primaryLocale: ${locale}
locales: []
modelVersion: "1.0.0"
consent:
  grantedBy: "${name}"
  grantedAt: "${new Date().toISOString().slice(0, 10)}"
`;
}

function basicsTemplate(values: {
  name: string;
  label: string;
  email: string;
  city: string;
  countryCode: string;
}): string {
  return `# yaml-language-server: $schema=../../../schemas/generated/basics.schema.json
#
# Comillas obligatorias en todo lo que YAML podría leer como número:
#   phone: +5491155555555   -> se parsea como número y PIERDE el "+"
#   countryCode: NO         -> se parsea como false
#   postalCode: 01234       -> se parsea como 1234
#
# El teléfono y la dirección postal viven en contact.private.yaml, que está
# fuera de git. Acá quedan sólo los datos publicables.

name: "${values.name}"
# Narrativo y traducible: es la línea que lee el reclutador debajo del nombre.
label: "${values.label}"
# Dos a cuatro frases. Sin pronombres personales. Es lo único que se lee entero.
summary: >-
  Escribí acá dos a cuatro frases: qué hacés, con qué stack, con qué escala y
  qué buscás. Evitá adjetivos sin evidencia ("apasionado", "proactivo").
email: "${values.email}"
location:
  city: "${values.city}"
  countryCode: "${values.countryCode}"
profiles:
  - id: profile.linkedin
    network: "LinkedIn"
    username: "usuario"
    # El renderer emite la URL completa como texto visible, nunca la palabra
    # "LinkedIn": un ATS no resuelve un hipervínculo sin texto.
    url: "https://www.linkedin.com/in/usuario"
`;
}

const WORK_TEMPLATE = `# yaml-language-server: $schema=../../../schemas/generated/work.schema.json
#
# Una entrada por EMPLEADOR. Las promociones son varias \`positions\` dentro de
# la misma entrada: así la empresa aparece una sola vez y el ATS no ve dos
# trabajos distintos.
#
# Cada bullet sigue la fórmula XYZ: "logré [X] medido por [Y] haciendo [Z]".
# \`metric\` es OPCIONAL a propósito. Exigir un número en cada bullet empuja a
# inventarlos, y eso es exactamente lo que se cae en la entrevista.

- id: work.ejemplo-2023
  company:
    # Con sufijo legal ("Inc.", "S.A.", "GmbH"): varios ATS parsean peor sin él.
    name: "Empresa Ejemplo S.A."
    url: "https://ejemplo.example"
    industry: "Sector"
  location:
    city: "Ciudad"
    countryCode: "AR"
    remote: hybrid
  positions:
    - id: work.ejemplo-2023.senior
      # Sin abreviaturas: "Senior Backend Engineer", nunca "Sr. SW Eng".
      title: "Cargo Completo Sin Abreviar"
      startDate: "2023-04"
      current: true
      seniority: senior
  summary: "Una línea de contexto: qué hace el equipo, a qué escala."
  tags: [ejemplo]
  priority: 100
  bullets:
    - id: work.ejemplo-2023.b1
      # X: el resultado va primero. El reclutador rara vez pasa del tercer bullet.
      outcome: "Redujo la latencia p99 de la API de autenticación un 40%"
      metric:
        value: "40%"
        type: delta_pct
        confidence: measured
      # Z: el método, al final.
      method: "migrando el servicio de REST a gRPC"
      tags: [performance]
      priority: 95
      variants:
        short: "Latencia p99 de auth -40% migrando REST a gRPC."
      provenance: { source: human }
      verified: true
`;

const EDUCATION_TEMPLATE = `# yaml-language-server: $schema=../../../schemas/generated/education.schema.json
#
# \`area\` y \`studyType\` son narrativos: se traducen en i18n/<locale>.yaml.
# \`score\` va entre comillas: 4.0 sin comillas se parsea como 4 y se imprime "4".

- id: education.universidad
  institution: "Universidad Ejemplo"
  area: "Ingeniería en Sistemas"
  studyType: "Licenciatura"
  startDate: "2014-03"
  endDate: "2019-12"
  courses: []
  priority: 60
`;

const SKILLS_TEMPLATE = `# yaml-language-server: $schema=../../../schemas/generated/skills.schema.json
#
# \`canonical\` es lo que se imprime por defecto; \`aliases\` son las otras formas
# de nombrar lo mismo. El matcher las resuelve y el renderer emite la que usa
# la vacante: varios ATS no resuelven que "PMP certified" y "Project Management
# Professional" son el mismo requisito.

- id: skill.ejemplo
  canonical: "TypeScript"
  aliases: ["TS"]
  category: "Lenguajes"
  level: advanced
  keywords: [node, esm]
  priority: 80
`;

const EMPTY_ARRAY_TEMPLATES: Array<{ file: string; schema: string; comment: string }> = [
  {
    file: 'projects.yaml',
    schema: 'projects',
    comment:
      '# Proyectos propios o de terceros. `highlights` usa el mismo formato XYZ que\n# los bullets de work.yaml.',
  },
  {
    file: 'certificates.yaml',
    schema: 'certificates',
    comment:
      '# `expiresAt` alimenta las preguntas eliminatorias del formulario, que son el\n# único auto-rechazo masivo y real del proceso.',
  },
  {
    file: 'awards.yaml',
    schema: 'awards',
    comment: '# Premios y distinciones, con fecha y entidad que los otorgó.',
  },
  {
    file: 'languages.yaml',
    schema: 'languages',
    comment: '# Nivel en Marco Común Europeo (A1..C2) o `native`. `fluency` es traducible.',
  },
  {
    file: 'publications.yaml',
    schema: 'publications',
    comment:
      '# CSL-JSON: la cita se guarda estructurada, nunca ya formateada, para que el\n# estilo (APA, Chicago, Vancouver, IEEE) lo decida el renderer.',
  },
  {
    file: 'references.yaml',
    schema: 'references',
    comment:
      '# Sólo iniciales y rol. Los datos de contacto de un tercero tienen otra base\n# legal que los propios: esa persona no consintió vivir en tu repositorio.',
  },
];

const ELIGIBILITY_TEMPLATE = `# yaml-language-server: $schema=../../../schemas/generated/eligibility.schema.json
#
# Este bloque existe porque el único auto-rechazo masivo y real del proceso son
# las knockout questions del formulario, no el parseo del PDF. \`cv build\` valida
# que las respuestas enviadas (applications/*/questions.yaml) sean consistentes
# con lo declarado acá.

workAuthorization:
  - countryCode: "AR"
    status: citizen
workModes: [remote, hybrid]
relocation:
  willing: false
  regions: []
`;

const CONTACT_TEMPLATE = `# Datos de contacto sensibles.
#
# contact.private.yaml está en .gitignore; contact.example.yaml se commitea con
# placeholders para que el pipeline sea reproducible por un tercero sin exponer
# a nadie. Git no olvida: nunca muevas datos reales al archivo de ejemplo.
#
# Es un parche PLANO sobre basics: el cargador ubica address y postalCode
# dentro de basics.location por vos.

# ENTRE COMILLAS: sin ellas se parsea como número y pierde el "+".
phone: "+54 9 11 5555 5555"

address: "Calle Ejemplo 123"

# ENTRE COMILLAS: 01425 sin comillas se convierte en 1425.
postalCode: "1425"
`;

function targetTemplate(values: {
  id: string;
  locale: string;
  region: string;
  label: string;
}): string {
  return `# yaml-language-server: $schema=../../../schemas/generated/target.schema.json
#
# El arquetipo es la capa reutilizable: "backend senior en inglés para mercado
# US". Se escribe una vez y se reusa en N vacantes. Sin esta capa, cada
# postulación rehace el trabajo desde cero y el sistema deja de escalar justo
# cuando empieza a servir.

id: ${values.id}
locale: ${values.locale}
region: ${values.region}
industry: tech
seniority: senior
theme: ats-classic
titleTarget: "${values.label}"
keywords: []
sectionOrder: [contact, summary, skills, work, education, certificates, projects]
budget:
  maxPages: 2
  bulletsPerRole: { recent: 5, mid: 3, old: 2 }
fileNameTemplate: "{First}-{Last}-{Role}.{ext}"
formats: [pdf, docx, txt]
`;
}

async function cmdNew(
  slug: string,
  options: { name?: string; email?: string; city?: string; country?: string; locale?: string; yes?: boolean; force?: boolean },
): Promise<void> {
  if (!SLUG_PATTERN.test(slug)) {
    throw new CliError(`El slug "${slug}" no es válido.`, {
      expected: 'minúsculas, dígitos y guiones (ej. "jane-doe")',
      received: slug,
    });
  }

  const dir = path.join(workspace.people, slug);
  if ((await exists(dir)) && options.force !== true) {
    throw new CliError(`Ya existe ${rel(dir)}.`, {
      file: rel(dir),
      hint: 'Usá --force para sobrescribir los archivos que falten (no borra los existentes).',
    });
  }

  const interactive = options.yes !== true && process.stdin.isTTY === true;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined;

  try {
    const defaultName = slug
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');

    const name = options.name ?? (await ask(rl, 'Nombre completo:', defaultName));
    const email = options.email ?? (await ask(rl, 'Email:', `${slug}@example.com`));
    const city = options.city ?? (await ask(rl, 'Ciudad:', 'Buenos Aires'));
    const country = (options.country ?? (await ask(rl, 'País (ISO-3166 alpha-2):', 'AR'))).toUpperCase();
    const locale = options.locale ?? (await ask(rl, 'Idioma primario (es/en/de/fr/pt/it):', 'es'));
    const label = 'Cargo objetivo';

    if (!/^[A-Z]{2}$/.test(country)) {
      throw new CliError(`El código de país "${country}" no es ISO-3166-1 alpha-2.`, {
        expected: 'dos letras mayúsculas (ej. "AR", "ES", "DE")',
        received: country,
      });
    }

    const profileDir = path.join(dir, 'profile');
    const files: Array<[string, string]> = [
      [path.join(dir, 'meta.yaml'), personMetaTemplate(slug, locale, name)],
      [path.join(profileDir, 'basics.yaml'), basicsTemplate({ name, label, email, city, countryCode: country })],
      [path.join(profileDir, 'work.yaml'), WORK_TEMPLATE],
      [path.join(profileDir, 'education.yaml'), EDUCATION_TEMPLATE],
      [path.join(profileDir, 'skills.yaml'), SKILLS_TEMPLATE],
      [path.join(profileDir, 'eligibility.yaml'), ELIGIBILITY_TEMPLATE],
      [path.join(dir, 'contact.example.yaml'), CONTACT_TEMPLATE],
      [path.join(dir, 'contact.private.yaml'), CONTACT_TEMPLATE],
      [
        path.join(dir, 'targets', 'general.yaml'),
        targetTemplate({
          id: 'general',
          locale,
          region: REGION_BY_COUNTRY[country] ?? 'us',
          label,
        }),
      ],
    ];

    for (const entry of EMPTY_ARRAY_TEMPLATES) {
      files.push([
        path.join(profileDir, entry.file),
        `# yaml-language-server: $schema=../../../schemas/generated/${entry.schema}.schema.json\n#\n${entry.comment}\n\n[]\n`,
      ]);
    }

    const created: string[] = [];
    const skipped: string[] = [];
    for (const [file, content] of files) {
      if (await exists(file)) {
        skipped.push(rel(file));
        continue;
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, 'utf8');
      created.push(rel(file));
    }

    for (const sub of ['i18n', 'applications', 'jds']) {
      await fsp.mkdir(path.join(dir, sub), { recursive: true });
      const keep = path.join(dir, sub, '.gitkeep');
      if (!(await exists(keep))) await fsp.writeFile(keep, '', 'utf8');
    }

    heading(`Persona creada: ${slug}`);
    for (const file of created) out(`${badge.ok()} ${file}`);
    for (const file of skipped) out(`${badge.skip()} ${file} ${c.gray('(ya existía)')}`);

    out();
    out(c.bold('Siguientes pasos'));
    out(`  1. Editá ${c.cyan(rel(path.join(profileDir, 'basics.yaml')))} y ${c.cyan('work.yaml')}.`);
    out(`  2. ${c.cyan('npm run schema')} si todavía no generaste los JSON Schema del editor.`);
    out(`  3. ${c.cyan(`cv validate ${slug}`)} para verificar fechas, ids y campos.`);
    out(`  4. ${c.cyan(`cv build ${slug}`)} para generar el CV.`);
    out();
    out(
      c.gray(
        'contact.private.yaml está en .gitignore. Los datos reales van ahí; el .example queda con placeholders.',
      ),
    );
  } finally {
    rl?.close();
  }
}

/* ========================================================================== *
 * cv validate
 * ========================================================================== */

function issuesToProblems(issues: Issue[], file: string): Problem[] {
  return issues.map((issue) => ({
    file,
    keyPath: issue.path,
    message: issue.message,
    rule: issue.rule,
    severity: issue.severity,
  }));
}

async function validatePerson(slug: string): Promise<Problem[]> {
  const personDir = await requirePersonDir(slug);
  const problems: Problem[] = [];

  const loadModule = await importLocal('./core/load.ts');
  const loadPerson = pickExport<(dir: string) => Promise<LoadedPerson> | LoadedPerson>(
    loadModule,
    'src/core/load.ts',
    ['loadPerson', 'loadProfile', 'load'],
  );

  let person: LoadedPerson;
  try {
    person = await loadPerson(personDir);
  } catch (error) {
    if (error instanceof ValidationError) return error.problems;
    throw error;
  }

  problems.push(...issuesToProblems(refineProfile(person.profile), `${rel(personDir)}/profile/`));

  for (const file of await listYamlFiles(path.join(personDir, 'targets'))) {
    const full = path.join(personDir, 'targets', file);
    try {
      await readYaml(full, Target);
    } catch (error) {
      if (error instanceof ValidationError) problems.push(...error.problems);
      else throw error;
    }
  }

  const applicationsDir = path.join(personDir, 'applications');
  for (const application of await listDirs(applicationsDir)) {
    const dir = path.join(applicationsDir, application);
    const checks: Array<[string, z.ZodType<unknown>]> = [
      ['overlay.yaml', Overlay],
      ['job.yaml', Job],
      ['meta.yaml', ApplicationMeta],
      ['questions.yaml', Questions],
      ['cover-letter.yaml', CoverLetter],
    ];
    for (const [name, schema] of checks) {
      const file = path.join(dir, name);
      if (!(await exists(file))) continue;
      try {
        await readYaml(file, schema);
      } catch (error) {
        if (error instanceof ValidationError) problems.push(...error.problems);
        else throw error;
      }
    }
  }

  return problems;
}

async function cmdValidate(slug: string | undefined): Promise<void> {
  const slugs = slug ? [slug] : await listDirs(workspace.people);
  if (slugs.length === 0) {
    throw new CliError('No hay ninguna persona en people/.', {
      hint: 'Creá una con `cv new <slug>`.',
    });
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const current of slugs) {
    heading(`Validando ${current}`);
    const problems = await validatePerson(current);
    const errors = problems.filter((p) => p.severity === 'error');
    const warnings = problems.filter((p) => p.severity === 'warning');
    totalErrors += errors.length;
    totalWarnings += warnings.length;

    if (problems.length === 0) {
      out(`${badge.ok()} sin problemas`);
      continue;
    }
    printProblems(problems);
  }

  out();
  const summary = `${slugs.length} persona(s) · ${totalErrors} error(es) · ${totalWarnings} aviso(s)`;
  if (totalErrors > 0) {
    warnOut(`${badge.fail()} ${c.bold(summary)}`);
    process.exitCode = 1;
    return;
  }
  out(`${badge.ok()} ${c.bold(summary)}`);
}

/* ========================================================================== *
 * cv build
 * ========================================================================== */

async function cmdBuild(
  slug: string,
  options: {
    target?: string;
    application?: string;
    format?: string;
    locale?: string;
    theme?: string;
    channel?: string;
    lint?: boolean;
    outDir?: string;
  },
): Promise<void> {
  const started = Date.now();
  heading(`Generando el CV de ${slug}`);

  const context = await prepare({
    slug,
    target: options.target,
    application: options.application,
    locale: options.locale,
    theme: options.theme,
  });

  const requested =
    parseFormats(options.format) ?? context.overlay?.formats ?? context.target.formats;

  // El TXT es el ground truth del linter (regla ATS-050): se renderiza siempre,
  // aunque no se pida como entregable, para poder comparar contra él.
  const formats = requested.includes('txt') ? requested : [...requested, 'txt' as const];

  const outDir = options.outDir
    ? path.resolve(process.cwd(), options.outDir)
    : context.application
      ? path.join(workspace.out, slug, context.application)
      : path.join(workspace.out, slug);
  await fsp.mkdir(outDir, { recursive: true });

  const nameValues = {
    name: context.resolved.contact.name,
    role: context.target.titleTarget ?? context.resolved.contact.label,
    company: context.job?.company.name ?? '',
    ext: '',
  };
  const template = context.overlay?.fileNameTemplate ?? context.target.fileNameTemplate;

  const rendered = new Map<OutputFormatName, RenderResult>();
  const manifestFiles: ManifestFile[] = [];
  let fitAdjustments: string[] = [];

  // El PDF va primero porque es el único formato paginado y, por lo tanto, el
  // único que puede obligar a recortar. El ViewModel que sobreviva a ese ajuste
  // es el que usan los demás formatos, para que todos describan el mismo
  // documento.
  const ordered = [...formats].sort((a, b) => (a === 'pdf' ? -1 : b === 'pdf' ? 1 : 0));

  for (const format of ordered) {
    const renderer = await loadRenderer(format);
    let result: RenderResult;

    if (format === 'pdf') {
      const fitModule = await importLocal('./core/fit.ts');
      const fitToBudget = pickExport<
        (
          vm: ViewModel,
          renderer: Renderer,
          opts: unknown,
        ) => Promise<RenderResult & { viewModel?: ViewModel; adjustments?: string[] }>
      >(fitModule, 'src/core/fit.ts', ['fitToBudget', 'fitPdf', 'runFitLoop', 'fit']);
      const outcome = await fitToBudget(context.viewModel, renderer, {
        maxPages: context.budget.maxPages,
        fit: context.config.fit,
        themeDir: context.themeDir,
        channel: options.channel === 'preview' ? 'preview' : 'release',
      });
      result = outcome;

      // El fit-loop puede haber recortado bullets o descartado secciones para
      // entrar en el presupuesto. A partir de acá ese ViewModel recortado es el
      // único válido: el resto de los formatos y la verificación ATS tienen que
      // describir el mismo documento que se imprimió, no el que se pensó.
      if (outcome.viewModel) context.viewModel = outcome.viewModel;
      fitAdjustments = outcome.adjustments ?? [];
    } else {
      result = await renderer.render(context.viewModel, {
        themeDir: context.themeDir,
        density: context.viewModel.density,
        resolved: context.resolved,
      });
    }

    rendered.set(format, result);

    const isDeliverable = requested.includes(format);
    if (!isDeliverable) continue;

    const fileName = applyFileNameTemplate(template, { ...nameValues, ext: renderer.extension });
    const file = path.join(outDir, fileName);
    const bytes = await writeArtifact(file, result.content);
    manifestFiles.push({
      format,
      file: fileName,
      bytes,
      sha256: sha256(result.content),
      pages: result.pages,
    });
  }

  const manifest: BuildManifest = {
    slug,
    target: context.targetId,
    application: context.application,
    locale: context.locale,
    theme: path.basename(context.themeDir),
    paper: context.config.paper,
    maxPages: context.budget.maxPages,
    density: context.viewModel.density,
    generatedAt: new Date().toISOString(),
    files: manifestFiles,
  };
  await fsp.writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  out();
  printTable(
    ['formato', 'archivo', 'tamaño', 'páginas'],
    manifestFiles.map((f) => [
      c.cyan(f.format),
      f.file,
      formatBytes(f.bytes),
      f.pages === undefined ? c.gray('—') : String(f.pages),
    ]),
  );
  out();
  out(`${c.gray('salida:')}    ${rel(outDir)}`);
  out(`${c.gray('arquetipo:')} ${context.targetId} · ${c.gray('idioma:')} ${context.locale}`);
  out(
    `${c.gray('papel:')}     ${context.config.paper} · ${c.gray('densidad:')} ${context.viewModel.density} · ${c.gray('máx. páginas:')} ${context.budget.maxPages}`,
  );

  // Lo que el fit-loop tuvo que sacrificar para entrar en el presupuesto. Sin
  // esto el autor manda un CV con dos bullets menos sin haberse enterado, que
  // es exactamente el modo de falla que el ajuste automático podría introducir.
  if (fitAdjustments.length > 0) {
    out();
    out(`${c.yellow('ajustes para entrar en el presupuesto de páginas:')}`);
    for (const adjustment of fitAdjustments) out(`  · ${adjustment}`);
  }

  if (context.viewModel.omittedSections.length > 0) {
    out();
    out(
      `${c.yellow('secciones con datos que el arquetipo dejó fuera:')} ${context.viewModel.omittedSections.join(', ')}`,
    );
    out(`  ${c.gray('Agregalas a sectionOrder del target si las querés en el CV.')}`);
  }

  let lintPassed: boolean | undefined;
  if (options.lint !== false) {
    const txt = rendered.get('txt');
    const reports = await lintArtifacts({
      context,
      txt: typeof txt?.content === 'string' ? txt.content : '',
      pdf: asBuffer(rendered.get('pdf')?.content),
      docx: asBuffer(rendered.get('docx')?.content),
    });
    heading('Verificación ATS');
    const counts = printLintReports(reports);
    lintPassed = counts.errors === 0;
    out();
    out(
      lintPassed
        ? `${badge.ok()} ${c.bold(`lint OK`)} ${c.gray(`(${counts.warnings} aviso(s))`)}`
        : `${badge.fail()} ${c.bold(`lint FALLÓ`)} ${c.gray(`(${counts.errors} error(es), ${counts.warnings} aviso(s))`)}`,
    );
  }

  const pdfPages = manifestFiles.find((f) => f.format === 'pdf')?.pages;
  out();
  const parts = [
    `${manifestFiles.length} archivo(s) en ${rel(outDir)}`,
    pdfPages === undefined ? undefined : `${pdfPages} página(s)`,
    lintPassed === undefined ? 'lint omitido' : lintPassed ? 'lint OK' : 'lint FALLÓ',
    `${((Date.now() - started) / 1000).toFixed(1)} s`,
  ].filter((p): p is string => p !== undefined);

  if (lintPassed === false) {
    warnOut(`${badge.fail()} ${c.bold(parts.join(' · '))}`);
    process.exitCode = 1;
    return;
  }
  out(`${badge.ok()} ${c.bold(parts.join(' · '))}`);
}

function asBuffer(content: Buffer | string | undefined): Buffer | undefined {
  if (content === undefined) return undefined;
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

async function lintArtifacts(input: {
  context: BuildContext;
  txt: string;
  pdf?: Buffer;
  docx?: Buffer;
}): Promise<LintReport[]> {
  const { context } = input;
  const lintInput: LintInput = {
    root: workspace.root,
    themeDir: context.themeDir,
    locale: context.locale,
    paper: context.config.paper,
    maxPages: context.budget.maxPages,
    documentTitle: context.viewModel.documentTitle,
    txt: input.txt,
    pdf: input.pdf,
    docx: input.docx,
    profile: context.profile,
    resolved: context.resolved,
    viewModel: context.viewModel,
    config: context.config,
    overlay: context.overlay,
    job: context.job,
    // Sin esto la batería de datos no puede distinguir "no hay traducción para
    // este id" de "no existe el archivo del locale", y reporta lo segundo
    // aunque el archivo esté ahí.
    i18n: context.person.i18n,
    region: context.target.region,
    companyName: context.job?.company.name,
  };

  if (context.applicationDir) {
    lintInput.questions = await readYamlIfExists(
      path.join(context.applicationDir, 'questions.yaml'),
      Questions,
    );
    lintInput.coverLetter = await readYamlIfExists(
      path.join(context.applicationDir, 'cover-letter.yaml'),
      CoverLetter,
    );
  }

  const reports: LintReport[] = [];
  for (const battery of LINT_BATTERIES) {
    if (battery === 'pdf' && !lintInput.pdf) continue;
    if (battery === 'text' && !lintInput.pdf) continue;
    if (battery === 'docx' && !lintInput.docx) continue;
    reports.push(await runLintBattery(battery, lintInput));
  }
  return reports;
}

/* ========================================================================== *
 * cv lint
 * ========================================================================== */

async function cmdLint(slug: string, options: { application?: string }): Promise<void> {
  const outDir = options.application
    ? path.join(workspace.out, slug, options.application)
    : path.join(workspace.out, slug);
  const manifestFile = path.join(outDir, 'manifest.json');

  if (!(await exists(manifestFile))) {
    throw new CliError(`No hay nada generado en ${rel(outDir)}.`, {
      file: rel(manifestFile),
      hint: `Corré primero \`cv build ${slug}${options.application ? ` --application ${options.application}` : ''}\`.`,
    });
  }

  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8')) as BuildManifest;
  heading(`Verificación ATS de ${slug}${manifest.application ? ` / ${manifest.application}` : ''}`);
  out(c.gray(`generado el ${manifest.generatedAt} · arquetipo ${manifest.target}`));

  const context = await prepare({
    slug,
    target: manifest.target,
    application: manifest.application,
    locale: manifest.locale,
    theme: manifest.theme,
  });

  const read = async (format: OutputFormatName): Promise<Buffer | undefined> => {
    const entry = manifest.files.find((f) => f.format === format);
    if (!entry) return undefined;
    const file = path.join(outDir, entry.file);
    if (!(await exists(file))) return undefined;
    return fsp.readFile(file);
  };

  const txtBuffer = await read('txt');
  const txt = txtBuffer
    ? txtBuffer.toString('utf8')
    : await (async () => {
        // Sin cv.txt no hay comparador de recall (ATS-050): se regenera al vuelo.
        const renderer = await loadRenderer('txt');
        const result = await renderer.render(context.viewModel, { themeDir: context.themeDir });
        return typeof result.content === 'string' ? result.content : result.content.toString('utf8');
      })();

  const reports = await lintArtifacts({
    context,
    txt,
    pdf: await read('pdf'),
    docx: await read('docx'),
  });

  out();
  const counts = printLintReports(reports);
  out();
  if (counts.errors > 0) {
    warnOut(`${badge.fail()} ${c.bold(`${counts.errors} error(es), ${counts.warnings} aviso(s)`)}`);
    process.exitCode = 1;
    return;
  }
  out(`${badge.ok()} ${c.bold(`lint OK (${counts.warnings} aviso(s))`)}`);
}

/* ========================================================================== *
 * cv match
 * ========================================================================== */

function evidenceIds(entry: MatchRequirementResult): string[] {
  return (entry.evidence ?? []).map((e) => (typeof e === 'string' ? e : e.id));
}

function formatMatchReport(input: {
  slug: string;
  job: z.infer<typeof Job>;
  result: MatchResult;
  eligibility?: Eligibility;
}): string {
  const { job, result } = input;
  const lines: string[] = [];
  lines.push(`# Match: ${job.title} — ${job.company.name}`);
  lines.push('');
  lines.push(`- Persona: \`${input.slug}\``);
  lines.push(`- Capturada: ${job.source.capturedAt}`);
  if (job.source.url) lines.push(`- Aviso: ${job.source.url}`);
  if (typeof result.score === 'number') lines.push(`- Score global: **${result.score.toFixed(1)}**`);
  lines.push('');
  lines.push(
    '> El objetivo es cobertura de requisitos MUST y encontrabilidad en la búsqueda del reclutador, no "pasar el ATS".',
  );
  lines.push('');

  const section = (title: string, entries: MatchRequirementResult[] | undefined): void => {
    lines.push(`## ${title}`);
    lines.push('');
    if (!entries || entries.length === 0) {
      lines.push('_(nada)_');
      lines.push('');
      return;
    }
    for (const entry of entries) {
      const ids = evidenceIds(entry);
      const evidence = ids.length > 0 ? ` ← ${ids.map((i) => `\`${i}\``).join(', ')}` : '';
      const hint = entry.hint ? ` → ${entry.hint}` : '';
      lines.push(`- **${entry.id}** (${entry.kind}, peso ${entry.weight}) ${entry.text}${evidence}${hint}`);
    }
    lines.push('');
  };

  const covered = result.covered ?? [];
  const missing = result.missing ?? [];
  section('Cubiertos', covered);
  section('Faltantes (must)', missing.filter((m) => m.kind === 'must'));
  section('Faltantes (nice)', missing.filter((m) => m.kind === 'nice'));

  lines.push('## Excluidos pero relevantes');
  lines.push('');
  const excluded = result.excludedButRelevant ?? [];
  if (excluded.length === 0) {
    lines.push('_(nada)_');
  } else {
    lines.push('Están en el perfil maestro y esta vacante los pide, pero la selección actual los deja afuera:');
    lines.push('');
    for (const item of excluded) {
      const requirements = item.requirements?.length ? ` (matchea ${item.requirements.join(', ')})` : '';
      lines.push(`- \`${item.id}\`${requirements}${item.reason ? ` — ${item.reason}` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Preguntas eliminatorias');
  lines.push('');
  const knockouts = result.knockouts ?? [];
  if (knockouts.length === 0 && job.knockouts.length === 0) {
    lines.push('_(la vacante no declara ninguna)_');
  } else {
    const rows = knockouts.length > 0 ? knockouts : job.knockouts.map((k) => ({ ...k, ok: undefined }));
    for (const knockout of rows) {
      const mark = knockout.ok === undefined ? '?' : knockout.ok ? 'OK' : '**BLOQUEA**';
      const note = 'note' in knockout && knockout.note ? ` — ${knockout.note}` : '';
      lines.push(`- ${mark} \`${knockout.id}\` ${knockout.question} (espera: ${knockout.expects})${note}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    'Este reporte es el insumo de `cv tailor`. Revisalo a mano antes de generar el overlay: la selección la decide una persona, no el matcher.',
  );
  lines.push('');
  return lines.join('\n');
}

async function runMatch(input: {
  slug: string;
  jobFile: string;
  locale?: string;
  target?: string;
  application?: string;
}): Promise<{ result: MatchResult; job: z.infer<typeof Job>; context: BuildContext | undefined; profile: z.infer<typeof PersonProfile> }> {
  const job = await readYaml(input.jobFile, Job);
  const personDir = await requirePersonDir(input.slug);

  const loadModule = await importLocal('./core/load.ts');
  const loadPerson = pickExport<(dir: string) => Promise<LoadedPerson> | LoadedPerson>(
    loadModule,
    'src/core/load.ts',
    ['loadPerson', 'loadProfile', 'load'],
  );
  const person = await loadPerson(personDir);
  const locale = input.locale ?? person.profile.meta.primaryLocale;

  const i18nModule = await importLocal('./core/i18n.ts');
  const localizeProfile = pickExport<
    (person: LoadedPerson, locale: string) => Promise<z.infer<typeof PersonProfile>> | z.infer<typeof PersonProfile>
  >(i18nModule, 'src/core/i18n.ts', ['localizeProfile', 'applyLocale', 'resolveI18n', 'localize']);
  const profile = await localizeProfile(person, locale);

  const taxonomy = await readYamlIfExists(
    path.join(workspace.config, 'taxonomy', 'skills.yaml'),
    SkillTaxonomy,
  );

  const matchModule = await importLocal('./core/match.ts');
  const matchProfile = pickExport<(input: unknown) => Promise<MatchResult> | MatchResult>(
    matchModule,
    'src/core/match.ts',
    ['matchProfile', 'matchAgainstJob', 'match'],
  );

  const result = await matchProfile({
    profile,
    job,
    taxonomy,
    locale,
    eligibility: profile.eligibility,
  });

  return { result, job, context: undefined, profile };
}

async function cmdMatch(slug: string, options: { job: string; locale?: string; out?: string }): Promise<void> {
  const jobFile = path.resolve(process.cwd(), options.job);
  heading(`Match de ${slug} contra ${rel(jobFile)}`);

  const { result, job, profile } = await runMatch({ slug, jobFile, locale: options.locale });

  const markdownModule = await importLocal('./core/match.ts');
  const custom = pickOptional<(result: MatchResult, job: unknown) => string>(markdownModule, [
    'renderMatchReport',
    'formatMatchReport',
    'matchReportMarkdown',
  ]);
  const markdown =
    custom !== undefined
      ? custom(result, job)
      : formatMatchReport({ slug, job, result, eligibility: profile.eligibility });

  const reportFile = options.out
    ? path.resolve(process.cwd(), options.out)
    : path.join(path.dirname(jobFile), 'match-report.md');
  await fsp.mkdir(path.dirname(reportFile), { recursive: true });
  await fsp.writeFile(reportFile, markdown, 'utf8');

  const covered = result.covered ?? [];
  const missing = result.missing ?? [];
  const mustMissing = missing.filter((m) => m.kind === 'must');
  const blocking = (result.knockouts ?? []).filter((k) => k.ok === false);

  out();
  printTable(
    ['', 'requisitos'],
    [
      [c.green('cubiertos'), String(covered.length)],
      [c.red('faltan (must)'), String(mustMissing.length)],
      [c.yellow('faltan (nice)'), String(missing.length - mustMissing.length)],
      [c.magenta('excluidos relevantes'), String((result.excludedButRelevant ?? []).length)],
    ],
  );

  if (blocking.length > 0) {
    out();
    for (const knockout of blocking) {
      out(`${badge.fail()} knockout ${c.bold(knockout.id)}: ${knockout.question}`);
      if (knockout.note) out(`       ${c.gray(knockout.note)}`);
    }
  }

  out();
  out(`${badge.ok()} ${c.bold(`reporte en ${rel(reportFile)}`)}`);
  out(c.gray('Revisalo a mano y después corré `cv tailor` para el borrador del overlay.'));
}

/* ========================================================================== *
 * cv tailor
 * ========================================================================== */

/** id → sección canónica, para agrupar lo que el matcher devuelve plano. */
function buildSectionIndex(profile: z.infer<typeof PersonProfile>): Map<string, SectionName> {
  const index = new Map<string, SectionName>();
  for (const entry of profile.work) index.set(entry.id, 'work');
  for (const entry of profile.education) index.set(entry.id, 'education');
  for (const entry of profile.skills) index.set(entry.id, 'skills');
  for (const entry of profile.projects) index.set(entry.id, 'projects');
  for (const entry of profile.certificates) index.set(entry.id, 'certificates');
  for (const entry of profile.awards) index.set(entry.id, 'awards');
  for (const entry of profile.languages) index.set(entry.id, 'languages');
  for (const entry of profile.publications) index.set(entry.id, 'publications');
  for (const entry of profile.references) index.set(entry.id, 'references');
  return index;
}

function collectScores(result: MatchResult): Map<string, number> {
  const scores = new Map<string, number>();
  const bump = (id: string, value: number): void => {
    scores.set(id, Math.max(scores.get(id) ?? 0, value));
  };

  for (const item of result.ranked ?? []) bump(item.id, item.score);
  for (const [id, score] of Object.entries(result.scores ?? {})) bump(id, score);
  for (const entry of result.covered ?? []) {
    for (const evidence of entry.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence.id;
      const score = typeof evidence === 'string' ? entry.weight : evidence.score ?? entry.weight;
      bump(id, score);
    }
  }
  for (const item of result.excludedButRelevant ?? []) bump(item.id, item.score ?? 1);
  return scores;
}

async function cmdTailor(
  slug: string,
  application: string,
  options: { target?: string; locale?: string; force?: boolean },
): Promise<void> {
  const personDir = await requirePersonDir(slug);
  const applicationDir = await resolveApplicationDir(personDir, application);
  const jobFile = path.join(applicationDir, 'job.yaml');
  const reportFile = path.join(applicationDir, 'match-report.md');
  const overlayFile = path.join(applicationDir, 'overlay.yaml');

  if (!(await exists(jobFile))) {
    throw new CliError(`Falta ${rel(jobFile)}.`, {
      file: rel(jobFile),
      hint: 'La vacante atomizada es la entrada del matcher. Escribila antes de adaptar.',
    });
  }
  if (!(await exists(reportFile))) {
    throw new CliError(`Falta ${rel(reportFile)}.`, {
      file: rel(reportFile),
      hint: `Corré \`cv match ${slug} --job ${rel(jobFile)}\` y revisá el reporte antes de generar el overlay.`,
    });
  }
  if ((await exists(overlayFile)) && options.force !== true) {
    throw new CliError(`Ya existe ${rel(overlayFile)}.`, {
      file: rel(overlayFile),
      hint: 'Usá --force para reemplazarlo. El overlay es un borrador que se edita a mano: pisarlo descarta tus decisiones.',
    });
  }

  heading(`Borrador de overlay para ${slug} / ${application}`);

  const targetId = await resolveTargetId(personDir, options.target, undefined);
  const target = await loadTarget(personDir, targetId);
  const locale = options.locale ?? target.locale;

  const { result, job, profile } = await runMatch({ slug, jobFile, locale });
  const scores = collectScores(result);
  const sections = buildSectionIndex(profile);

  const budget = target.budget ?? Budget.parse({});
  const limits: Partial<Record<SectionName, number>> = {
    work: 5,
    skills: 12,
    projects: 3,
    certificates: 4,
    education: 3,
  };

  const grouped = new Map<SectionName, string[]>();
  const ordered = [...scores.entries()]
    .filter(([id]) => sections.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  for (const [id] of ordered) {
    const section = sections.get(id)!;
    const list = grouped.get(section) ?? [];
    if (list.length >= (limits[section] ?? 10)) continue;
    list.push(id);
    grouped.set(section, list);
  }

  // Los bullets se seleccionan dentro de su entrada de trabajo, no globalmente:
  // el presupuesto es "N bullets por rol", no "N bullets en el CV".
  const overrides: Record<string, unknown> = {};
  for (const workId of grouped.get('work') ?? []) {
    const entry = profile.work.find((w) => w.id === workId);
    if (!entry) continue;
    const bullets = entry.bullets
      .map((bullet) => ({ id: bullet.id, score: scores.get(bullet.id) ?? bullet.priority / 10 }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, budget.bulletsPerRole.recent)
      .map((b) => b.id);
    if (bullets.length === 0) continue;
    overrides[workId] = { bullets: { include: bullets, order: bullets } };
  }

  const overlayData: Record<string, unknown> = {
    extends: targetId,
    job: './job.yaml',
    locale,
    sections: Object.fromEntries(
      [...grouped.entries()].map(([section, ids]) => [
        section,
        section === 'work' && Object.keys(overrides).length > 0
          ? { include: ids, order: ids, overrides }
          : { include: ids, order: ids },
      ]),
    ),
    budget: { maxPages: budget.maxPages },
  };

  const header = `# yaml-language-server: $schema=../../../../schemas/generated/overlay.schema.json
#
# BORRADOR generado por \`cv tailor\` a partir de match-report.md. Revisalo.
#
# Vacante: ${job.title} — ${job.company.name}
# Generado: ${new Date().toISOString()}
#
# El overlay SELECCIONA y REORDENA hechos que ya existen en profile/. No puede
# inventar ni modificar empleadores, fechas ni títulos: esa restricción es lo
# que hace que la adaptación sea auditable con \`cv review\`.
#
# Antes de aprobarlo, sacá lo que no describa con exactitud tu experiencia real.

`;

  await fsp.writeFile(
    overlayFile,
    header + stringifyYaml(overlayData, { lineWidth: 0 }),
    'utf8',
  );

  out();
  printTable(
    ['sección', 'ítems incluidos'],
    [...grouped.entries()].map(([section, ids]) => [c.cyan(section), String(ids.length)]),
  );
  out();
  out(`${badge.ok()} ${c.bold(`borrador en ${rel(overlayFile)}`)}`);
  out(c.gray(`Editalo, después: cv review ${slug} ${application} · cv build ${slug} --application ${application}`));
}

/* ========================================================================== *
 * cv review — diff palabra por palabra, con foco en los verbos
 * ========================================================================== */

/**
 * Verbos débiles y fuertes, normalizados sin acentos.
 *
 * La inflación del verbo es el modo de falla más probable de un generador
 * automático y es exactamente lo que se cae en la entrevista: "colaboré en"
 * convertido en "lideré" no cambia un hecho verificable en el papel, pero sí
 * la pregunta que sigue.
 */
const WEAK_VERBS = new Set([
  'colabore',
  'colaboramos',
  'participe',
  'participamos',
  'ayude',
  'asisti',
  'apoye',
  'contribui',
  'trabaje',
  'acompane',
  'collaborated',
  'participated',
  'helped',
  'assisted',
  'supported',
  'contributed',
  'worked',
  'aided',
  'involved',
]);

const STRONG_VERBS = new Set([
  'lidere',
  'dirigi',
  'encabece',
  'conduje',
  'impulse',
  'arquitecte',
  'disene',
  'construi',
  'implemente',
  'lance',
  'optimice',
  'reduje',
  'aumente',
  'acelere',
  'mentoree',
  'coordine',
  'fundé',
  'led',
  'drove',
  'owned',
  'architected',
  'spearheaded',
  'headed',
  'directed',
  'built',
  'shipped',
  'designed',
  'launched',
  'reduced',
  'cut',
  'increased',
  'accelerated',
  'streamlined',
  'mentored',
  'coordinated',
  'managed',
  'delivered',
  'pioneered',
  'transformed',
]);

function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

type DiffOp = { op: 'eq' | 'del' | 'ins'; token: string };

/** LCS clásico. Los textos son bullets y resúmenes: el O(n·m) no molesta. */
function diffWords(before: string, after: string): DiffOp[] {
  const a = before.split(/\s+/).filter((t) => t.length > 0);
  const b = after.split(/\s+/).filter((t) => t.length > 0);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        normalizeWord(a[i]!) === normalizeWord(b[j]!)
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (normalizeWord(a[i]!) === normalizeWord(b[j]!)) {
      ops.push({ op: 'eq', token: b[j]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ op: 'del', token: a[i]! });
      i += 1;
    } else {
      ops.push({ op: 'ins', token: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ op: 'del', token: a[i++]! });
  while (j < b.length) ops.push({ op: 'ins', token: b[j++]! });
  return ops;
}

function renderDiff(ops: DiffOp[]): string {
  return ops
    .map((op) => {
      if (op.op === 'eq') return op.token;
      if (op.op === 'del') return c.red(`[-${op.token}-]`);
      return c.green(`{+${op.token}+}`);
    })
    .join(' ');
}

type VerbChange = { removed: string; added: string; inflation: boolean };

function detectVerbChanges(ops: DiffOp[]): VerbChange[] {
  const removed = ops.filter((o) => o.op === 'del').map((o) => normalizeWord(o.token));
  const added = ops.filter((o) => o.op === 'ins').map((o) => normalizeWord(o.token));
  const changes: VerbChange[] = [];

  for (const from of removed) {
    if (!WEAK_VERBS.has(from) && !STRONG_VERBS.has(from)) continue;
    for (const to of added) {
      if (!WEAK_VERBS.has(to) && !STRONG_VERBS.has(to)) continue;
      changes.push({ removed: from, added: to, inflation: WEAK_VERBS.has(from) && STRONG_VERBS.has(to) });
    }
  }
  return changes;
}

function bulletText(bullet: { outcome: string; method?: string }): string {
  return [bullet.outcome, bullet.method].filter((p): p is string => Boolean(p)).join(' ');
}

async function cmdReview(
  slug: string,
  application: string,
  options: { locale?: string; strict?: boolean },
): Promise<void> {
  const personDir = await requirePersonDir(slug);
  const applicationDir = await resolveApplicationDir(personDir, application);
  const overlayFile = path.join(applicationDir, 'overlay.yaml');

  if (!(await exists(overlayFile))) {
    throw new CliError(`Falta ${rel(overlayFile)}.`, {
      file: rel(overlayFile),
      hint: `Generá el borrador con \`cv tailor ${slug} ${application}\`.`,
    });
  }

  const overlay = await readYaml(overlayFile, Overlay);
  const target = await loadTarget(personDir, overlay.extends);
  const locale = options.locale ?? overlay.locale ?? target.locale;

  const loadModule = await importLocal('./core/load.ts');
  const loadPerson = pickExport<(dir: string) => Promise<LoadedPerson> | LoadedPerson>(
    loadModule,
    'src/core/load.ts',
    ['loadPerson', 'loadProfile', 'load'],
  );
  const person = await loadPerson(personDir);

  const i18nModule = await importLocal('./core/i18n.ts');
  const localizeProfile = pickExport<
    (person: LoadedPerson, locale: string) => Promise<z.infer<typeof PersonProfile>> | z.infer<typeof PersonProfile>
  >(i18nModule, 'src/core/i18n.ts', ['localizeProfile', 'applyLocale', 'resolveI18n', 'localize']);
  const profile = await localizeProfile(person, locale);

  heading(`Diff de ${slug} / ${application} contra el perfil base`);
  out(c.gray('[-texto del perfil base-]  {+texto de esta postulación+}'));

  type Change = { where: string; ops: DiffOp[]; verbs: VerbChange[] };
  const changes: Change[] = [];

  const compare = (where: string, base: string | undefined, variant: string | undefined): void => {
    if (variant === undefined || base === undefined) return;
    if (base.trim() === variant.trim()) return;
    const ops = diffWords(base, variant);
    changes.push({ where, ops, verbs: detectVerbChanges(ops) });
  };

  compare('basics.label', profile.basics.label, overlay.basics?.label);
  compare('basics.summary', profile.basics.summary, overlay.basics?.summary);

  for (const [sectionName, selection] of Object.entries(overlay.sections)) {
    if (!selection?.overrides) continue;
    for (const [id, override] of Object.entries(selection.overrides)) {
      if (!override) continue;
      const workEntry = profile.work.find((w) => w.id === id);
      const projectEntry = profile.projects.find((p) => p.id === id);

      compare(`${sectionName}.${id}.summary`, workEntry?.summary ?? projectEntry?.description, override.summary);

      const variant = override.bullets?.variant;
      if (!variant || variant === 'default') continue;
      const pool = workEntry?.bullets ?? projectEntry?.highlights ?? [];
      const included = override.bullets?.include;
      for (const bullet of pool) {
        if (included && !included.includes(bullet.id)) continue;
        const alternative = bullet.variants?.[variant];
        compare(`${sectionName}.${id}.${bullet.id} (${variant})`, bulletText(bullet), alternative);
      }
    }
  }

  if (changes.length === 0) {
    out();
    out(`${badge.ok()} ${c.bold('El overlay no reescribe ningún texto: sólo selecciona y reordena.')}`);
    out(c.gray('Es la forma más segura de adaptar: nada que decir en la entrevista que no esté en el perfil base.'));
    return;
  }

  let inflation = 0;
  for (const change of changes) {
    out();
    out(c.bold(change.where));
    out(`  ${renderDiff(change.ops)}`);
    for (const verb of change.verbs) {
      if (verb.inflation) {
        inflation += 1;
        out(
          `  ${badge.fail()} ${c.bold('inflación de verbo')}: "${verb.removed}" → "${verb.added}". Es exactamente lo que se cae en la entrevista.`,
        );
      } else {
        out(`  ${badge.warn()} cambio de verbo: "${verb.removed}" → "${verb.added}"`);
      }
    }
  }

  out();
  const summary = `${changes.length} texto(s) reescrito(s) · ${inflation} inflación(es) de verbo`;
  if (inflation > 0) {
    warnOut(`${badge.fail()} ${c.bold(summary)}`);
    warnOut(
      c.gray(
        'Un verbo más fuerte no cambia el hecho en el papel, pero sí la pregunta que sigue. Volvé al verbo del perfil base salvo que puedas sostenerlo.',
      ),
    );
    if (options.strict === true) process.exitCode = 1;
    return;
  }
  out(`${badge.ok()} ${c.bold(summary)}`);
}

/* ========================================================================== *
 * cv report — el funnel
 * ========================================================================== */

const RESPONSE_STATES = new Set(['ack', 'screening', 'tech', 'onsite', 'offer', 'rejected']);

type ApplicationRow = {
  slug: string;
  application: string;
  archetype: string;
  state: string;
  sentAt?: Date;
  firstResponseDays?: number;
  rejectedStage: string | null;
};

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function collectApplications(slug: string): Promise<ApplicationRow[]> {
  const personDir = path.join(workspace.people, slug);
  const applicationsDir = path.join(personDir, 'applications');
  const rows: ApplicationRow[] = [];

  for (const application of await listDirs(applicationsDir)) {
    const dir = path.join(applicationsDir, application);
    const meta = await readYamlIfExists(path.join(dir, 'meta.yaml'), ApplicationMeta);
    if (!meta) continue;

    const overlay = await readYamlIfExists(path.join(dir, 'overlay.yaml'), Overlay);
    const timeline = [...meta.timeline].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
    );
    const sent = timeline.find((e) => e.state === 'sent');
    const sentAt = sent ? new Date(sent.at) : undefined;
    const response = timeline.find(
      (e) => RESPONSE_STATES.has(e.state) && (!sentAt || new Date(e.at).getTime() >= sentAt.getTime()),
    );

    rows.push({
      slug,
      application,
      archetype: overlay?.extends ?? c.gray('(sin overlay)'),
      state: meta.state,
      sentAt,
      firstResponseDays:
        sentAt && response
          ? (new Date(response.at).getTime() - sentAt.getTime()) / (1000 * 60 * 60 * 24)
          : undefined,
      rejectedStage: meta.rejectedStage,
    });
  }
  return rows;
}

async function cmdReport(slug: string | undefined): Promise<void> {
  const slugs = slug ? [slug] : await listDirs(workspace.people);
  const rows: ApplicationRow[] = [];
  for (const current of slugs) rows.push(...(await collectApplications(current)));

  heading(slug ? `Funnel de postulaciones — ${slug}` : 'Funnel de postulaciones');

  if (rows.length === 0) {
    out(`${badge.warn()} No hay postulaciones con meta.yaml todavía.`);
    out(
      c.gray(
        'A partir de ~30 postulaciones el funnel propio vale más que cualquier estadística de vendor: todas las cifras públicas de efectividad vienen de empresas cuyo negocio depende del mito del ATS.',
      ),
    );
    return;
  }

  const sent = rows.filter((r) => r.sentAt !== undefined);
  const responded = rows.filter((r) => r.firstResponseDays !== undefined);

  out();
  out(
    `${c.bold(String(rows.length))} postulación(es) · ${c.bold(String(sent.length))} enviada(s) · ${c.bold(String(responded.length))} con respuesta`,
  );
  const overallMedian = median(responded.map((r) => r.firstResponseDays!));
  if (overallMedian !== undefined) {
    out(`Mediana hasta la primera respuesta: ${c.bold(`${overallMedian.toFixed(1)} días`)}`);
  }

  const byArchetype = new Map<string, ApplicationRow[]>();
  for (const row of rows) {
    const list = byArchetype.get(row.archetype) ?? [];
    list.push(row);
    byArchetype.set(row.archetype, list);
  }

  out();
  out(c.bold('Por arquetipo'));
  printTable(
    ['arquetipo', 'enviadas', 'con respuesta', 'tasa', 'mediana días'],
    [...byArchetype.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([archetype, list]) => {
        const listSent = list.filter((r) => r.sentAt !== undefined);
        const listResponded = list.filter((r) => r.firstResponseDays !== undefined);
        const rate = listSent.length > 0 ? (listResponded.length / listSent.length) * 100 : 0;
        const days = median(listResponded.map((r) => r.firstResponseDays!));
        return [
          c.cyan(archetype),
          String(listSent.length),
          String(listResponded.length),
          listSent.length > 0 ? `${rate.toFixed(0)} %` : c.gray('—'),
          days === undefined ? c.gray('—') : days.toFixed(1),
        ];
      }),
  );

  const byState = new Map<string, number>();
  for (const row of rows) byState.set(row.state, (byState.get(row.state) ?? 0) + 1);
  out();
  out(c.bold('Por estado'));
  printTable(
    ['estado', 'cantidad'],
    [...byState.entries()].sort((a, b) => b[1] - a[1]).map(([state, count]) => [state, String(count)]),
  );

  const stages = new Map<string, number>();
  for (const row of rows) {
    if (row.rejectedStage) stages.set(row.rejectedStage, (stages.get(row.rejectedStage) ?? 0) + 1);
  }
  if (stages.size > 0) {
    out();
    out(c.bold('Etapa de rechazo'));
    printTable(
      ['etapa', 'cantidad'],
      [...stages.entries()].sort((a, b) => b[1] - a[1]).map(([stage, count]) => [stage, String(count)]),
    );
  }

  if (rows.length < 30) {
    out();
    out(
      c.gray(
        `Con ${rows.length} postulación(es) todavía no hay señal estadística: el funnel empieza a decir algo real a partir de ~30.`,
      ),
    );
  }
}

/* ========================================================================== *
 * cv schema
 * ========================================================================== */

/* ========================================================================== *
 * Generadores de esqueleto
 * ========================================================================== */

/** Carga la persona por su directorio, sin pasar por el pipeline completo. */
async function loadPersonFrom(personDir: string): Promise<LoadedPerson> {
  const mod = await importLocal('./core/load.ts');
  const loadPerson = pickExport<(dir: string) => Promise<LoadedPerson> | LoadedPerson>(
    mod,
    'src/core/load.ts',
    ['loadPerson', 'loadProfile', 'load'],
  );
  return await loadPerson(personDir);
}

async function cmdNewTarget(
  slug: string,
  id: string,
  options: {
    locale?: string;
    region?: string;
    industry?: string;
    seniority?: string;
    title?: string;
    force?: boolean;
  },
): Promise<void> {
  heading(`Nuevo arquetipo "${id}" para ${slug}`);
  const personDir = await requirePersonDir(slug);
  const person = await loadPersonFrom(personDir);

  const scaffold = await importLocal('./core/scaffold.ts');
  const newTarget = pickExport<(o: unknown) => Promise<{ file: string; created: boolean }>>(
    scaffold,
    'src/core/scaffold.ts',
    ['newTarget'],
  );
  const result = await newTarget({
    personDir,
    root: repoRoot,
    id,
    locale: options.locale ?? person.profile.meta.primaryLocale,
    region: options.region ?? 'ar',
    industry: options.industry,
    seniority: options.seniority,
    titleTarget: options.title ?? person.profile.basics.label,
    force: options.force,
  });

  if (!result.created) {
    throw new CliError(`Ya existe ${rel(result.file)}.`, { hint: 'Usá --force para sobrescribirlo.' });
  }
  out();
  out(`  ${c.green('ok')}   ${rel(result.file)}`);
  out();
  out(`Editá el archivo y después generá con:`);
  out(`  ${c.gray('$')} cv build ${slug} --target ${id}`);
}

async function cmdNewLocale(
  slug: string,
  locale: string,
  options: { force?: boolean },
): Promise<void> {
  heading(`Nuevo idioma "${locale}" para ${slug}`);
  const personDir = await requirePersonDir(slug);
  const person = await loadPersonFrom(personDir);

  if (locale === person.profile.meta.primaryLocale) {
    throw new CliError(`"${locale}" ya es el idioma primario de ${slug}.`, {
      hint: 'La narrativa en el idioma primario vive en profile/, no en i18n/.',
    });
  }

  const scaffold = await importLocal('./core/scaffold.ts');
  const newLocale = pickExport<(o: unknown) => Promise<{ file: string; created: boolean }>>(
    scaffold,
    'src/core/scaffold.ts',
    ['newLocale'],
  );
  const result = await newLocale({ personDir, profile: person.profile, locale, force: options.force });

  if (!result.created) {
    throw new CliError(`Ya existe ${rel(result.file)}.`, { hint: 'Usá --force para regenerarlo.' });
  }
  out();
  out(`  ${c.green('ok')}   ${rel(result.file)}`);
  out();
  out(`Cada clave trae comentado el texto original. Traducilos y agregá el`);
  out(`idioma a meta.locales; el build falla si falta alguno de los que se usan.`);
}

async function cmdNewApplication(
  slug: string,
  company: string,
  role: string,
  options: { target?: string; date?: string; force?: boolean },
): Promise<void> {
  heading(`Nueva postulación: ${role} en ${company}`);
  const personDir = await requirePersonDir(slug);

  const scaffold = await importLocal('./core/scaffold.ts');
  const newApplication = pickExport<
    (o: unknown) => Promise<{ dir: string; files: string[]; created: boolean }>
  >(scaffold, 'src/core/scaffold.ts', ['newApplication']);
  const readTargetIds = pickExport<(dir: string) => Promise<string[]>>(scaffold, 'src/core/scaffold.ts', [
    'readTargetIds',
  ]);
  const targets = await readTargetIds(personDir);
  const target = options.target ?? targets[0];
  if (!target) {
    throw new CliError('No hay ningún arquetipo del que heredar.', {
      hint: `Creá uno primero: cv new-target ${slug} <id>`,
    });
  }
  if (options.target && !targets.includes(options.target)) {
    throw new CliError(`No existe el arquetipo "${options.target}".`, {
      hint: targets.length > 0 ? `Disponibles: ${targets.join(', ')}.` : `Creá uno con: cv new-target ${slug} <id>`,
    });
  }

  const result = await newApplication({
    personDir,
    root: repoRoot,
    company,
    role,
    target,
    date: options.date,
    force: options.force,
  });

  if (!result.created) {
    throw new CliError(`Ya existe ${rel(result.dir)}.`, { hint: 'Usá --force para sobrescribirla.' });
  }

  out();
  for (const file of result.files) out(`  ${c.green('ok')}   ${rel(file)}`);
  out();
  const dirName = path.basename(result.dir);
  out('Siguiente paso: pegá el aviso en job.raw.md, atomizalo en job.yaml y después:');
  out(`  ${c.gray('$')} cv match ${slug} --job ${rel(path.join(result.dir, 'job.yaml'))}`);
  out(`  ${c.gray('$')} cv build ${slug} --application ${dirName}`);
}

async function cmdSchema(): Promise<void> {
  heading('Generando JSON Schema');
  const result = await generateSchemas(workspace.root);

  for (const file of result.generated) {
    const changed = result.changed.includes(file);
    out(`${changed ? badge.ok() : badge.skip()} ${file}${changed ? '' : c.gray('  (sin cambios)')}`);
  }
  for (const file of result.vendored) out(`${badge.ok()} ${file} ${c.gray('(pinneado)')}`);
  for (const warning of result.warnings) out(`${badge.warn()} ${warning}`);

  out();
  out(
    `${badge.ok()} ${c.bold(`${result.generated.length} schemas · ${result.changed.length} con cambios · ${result.vendored.length} vendorizados`)}`,
  );
  out(
    c.gray(
      'Los globs de .vscode/settings.json apuntan acá y overridean el auto-binding de SchemaStore, que asociaría los YAML al JSON Resume v1.0.0 archivado.',
    ),
  );
}

/* ========================================================================== *
 * cv doctor
 * ========================================================================== */

type Check = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; hint?: string };

function compareSemver(actual: string, minimum: string): number {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(actual);
  const b = parse(minimum);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

async function checkBrowser(channel: 'bundled' | 'chrome'): Promise<Check> {
  const label = channel === 'bundled' ? 'Chromium (release)' : 'Chrome del sistema (preview)';
  let playwright: { chromium: { executablePath(): string; launch(opts?: unknown): Promise<{ version(): string; close(): Promise<void> }> } };
  try {
    playwright = (await import('playwright')) as never;
  } catch {
    return {
      name: label,
      status: 'fail',
      detail: 'playwright no está instalado',
      hint: 'npm install',
    };
  }

  try {
    const browser = await playwright.chromium.launch(
      channel === 'chrome' ? { channel: 'chrome' } : undefined,
    );
    const version = browser.version();
    await browser.close();
    return {
      name: label,
      status: 'ok',
      detail: version,
      hint:
        channel === 'bundled'
          ? 'Los golden y el conteo de páginas corren siempre contra este binario.'
          : undefined,
    };
  } catch (error) {
    return {
      name: label,
      status: channel === 'bundled' ? 'fail' : 'warn',
      detail: error instanceof Error ? error.message.split('\n')[0]! : String(error),
      hint:
        channel === 'bundled'
          ? 'npx playwright install chromium'
          : 'Opcional: sólo lo usa `cv build --channel preview`.',
    };
  }
}

async function checkDependencies(): Promise<Check[]> {
  const manifest = JSON.parse(
    await fsp.readFile(path.join(workspace.root, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  const missing: string[] = [];
  const found: string[] = [];

  for (const name of Object.keys(declared).sort()) {
    const packageFile = path.join(workspace.root, 'node_modules', ...name.split('/'), 'package.json');
    if (await exists(packageFile)) {
      const installed = JSON.parse(await fsp.readFile(packageFile, 'utf8')) as { version?: string };
      found.push(`${name}@${installed.version ?? '?'}`);
    } else {
      missing.push(name);
    }
  }

  const checks: Check[] = [
    {
      name: 'Dependencias',
      status: missing.length === 0 ? 'ok' : 'fail',
      detail:
        missing.length === 0
          ? `${found.length} instaladas`
          : `faltan ${missing.length}: ${missing.join(', ')}`,
      hint: missing.length === 0 ? undefined : 'npm install',
    },
  ];

  // Las fuentes variables se ven idénticas en el editor y NO las embebe
  // Chromium: el PDF sale con otra tipografía y otra paginación en la máquina
  // del reclutador, sin ningún error visible.
  const variablePackages = Object.keys(declared).filter((n) => n.startsWith('@fontsource-variable/'));
  checks.push({
    name: 'Fuentes variables',
    status: variablePackages.length === 0 ? 'ok' : 'fail',
    detail:
      variablePackages.length === 0
        ? 'ninguna declarada'
        : `prohibidas y presentes: ${variablePackages.join(', ')}`,
    hint:
      variablePackages.length === 0
        ? undefined
        : 'Chromium no embebe fuentes con tabla fvar. Usá los paquetes estáticos (@fontsource/...).',
  });

  return checks;
}

async function cmdDoctor(options: { quick?: boolean }): Promise<void> {
  heading('Diagnóstico del entorno');

  const checks: Check[] = [];

  const nodeOk = compareSemver(process.versions.node, '24.12.0') >= 0;
  checks.push({
    name: 'Node',
    status: nodeOk ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    hint: nodeOk ? undefined : 'Se necesita >= 24.12.0: antes el type stripping no es estable.',
  });

  const typescriptFeature = (process.features as unknown as Record<string, unknown>).typescript;
  checks.push({
    name: 'TypeScript nativo',
    status: typescriptFeature ? 'ok' : 'warn',
    detail: typescriptFeature ? String(typescriptFeature) : 'no reportado por process.features',
    hint: typescriptFeature ? undefined : 'El proyecto corre .ts sin build step; sin esto hace falta un runner.',
  });

  checks.push(...(await checkDependencies()));

  const schemasDir = path.join(workspace.schemas, 'generated');
  const generated = (await listYamlFiles(schemasDir)).length;
  const generatedJson = (await exists(schemasDir))
    ? (await fsp.readdir(schemasDir)).filter((f) => f.endsWith('.schema.json')).length
    : 0;
  checks.push({
    name: 'JSON Schema',
    status: generatedJson >= 16 ? 'ok' : 'warn',
    detail: `${generatedJson + generated} archivo(s) en ${rel(schemasDir)}`,
    hint: generatedJson >= 16 ? undefined : 'Ejecutá `cv schema` para regenerarlos.',
  });

  const fontDirs = await listDirs(path.join(workspace.assets, 'fonts'));
  checks.push({
    name: 'Fuentes vendorizadas',
    status: fontDirs.length > 0 ? 'ok' : 'warn',
    detail: fontDirs.length > 0 ? fontDirs.join(', ') : 'assets/fonts/ vacío',
    hint:
      fontDirs.length > 0
        ? undefined
        : 'Copiá los woff2 estáticos y su LICENSE. Si falta la familia primaria, Chromium embebe la siguiente del stack en silencio.',
  });

  const themes = await listDirs(workspace.themes);
  checks.push({
    name: 'Temas',
    status: themes.length > 0 ? 'ok' : 'warn',
    detail: themes.length > 0 ? themes.join(', ') : 'src/themes/ vacío',
  });

  const people = await listDirs(workspace.people);
  checks.push({
    name: 'Personas',
    status: 'ok',
    detail: people.length > 0 ? people.join(', ') : 'ninguna todavía (cv new <slug>)',
  });

  if (options.quick !== true) {
    checks.push(await checkBrowser('bundled'));
    checks.push(await checkBrowser('chrome'));
  } else {
    checks.push({ name: 'Navegador', status: 'warn', detail: 'omitido por --quick' });
  }

  out();
  for (const check of checks) {
    const mark = check.status === 'ok' ? badge.ok() : check.status === 'warn' ? badge.warn() : badge.fail();
    out(`${mark} ${c.bold(check.name.padEnd(22))} ${check.detail}`);
    if (check.hint) out(`       ${c.gray(check.hint)}`);
  }

  const failures = checks.filter((c2) => c2.status === 'fail').length;
  const warnings = checks.filter((c2) => c2.status === 'warn').length;
  out();
  const summary = `${checks.length} chequeo(s) · ${failures} error(es) · ${warnings} aviso(s)`;
  if (failures > 0) {
    warnOut(`${badge.fail()} ${c.bold(summary)}`);
    process.exitCode = 1;
    return;
  }
  out(`${badge.ok()} ${c.bold(summary)}`);
}

/* ========================================================================== *
 * Definición de comandos
 * ========================================================================== */

const program = new Command();

program
  .name('cv')
  .description(
    'Workspace de CVs: los datos viven una sola vez en YAML y cada formato es una proyección hermana del mismo modelo.',
  )
  .version('0.1.0', '-v, --version', 'muestra la versión')
  .option('--no-color', 'desactiva el color ANSI (también se respeta NO_COLOR)')
  .showHelpAfterError('(usá --help para ver las opciones)')
  .configureOutput({
    outputError: (message, write) => write(c.red(message)),
  });

program
  .command('new')
  .argument('<slug>', 'identificador en minúsculas y guiones, ej. jane-doe')
  .description('crea people/<slug>/ con los YAML comentados y listos para editar')
  .option('--name <nombre>', 'nombre completo, para no preguntarlo')
  .option('--email <email>', 'email de contacto')
  .option('--city <ciudad>', 'ciudad de residencia')
  .option('--country <iso>', 'país en ISO-3166-1 alpha-2, ej. AR')
  .option('--locale <locale>', 'idioma primario del perfil (es, en, de, fr, pt, it)')
  .option('-y, --yes', 'no pregunta nada y usa los valores por defecto')
  .option('--force', 'escribe dentro de un directorio que ya existe')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv new jane-doe
  $ cv new jane-doe --yes --name "Jane Doe" --email jane@example.com --country US --locale en

Qué crea:
  people/jane-doe/meta.yaml           idioma primario, versión del modelo, consentimiento
  people/jane-doe/profile/*.yaml      estructura + narrativa en el idioma primario
  people/jane-doe/targets/general.yaml arquetipo inicial reutilizable
  people/jane-doe/contact.private.yaml datos sensibles (fuera de git)
`,
  )
  .action(cmdNew);

program
  .command('validate')
  .argument('[slug]', 'persona a validar; sin argumento valida todas')
  .description('valida los YAML contra el schema y las reglas que cruzan campos')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv validate
  $ cv validate jane-doe

Qué verifica además del schema:
  - ids únicos en TODO el perfil (los overlays los referencian sin decir la sección)
  - fechas que existen en el calendario: el patrón ISO acepta 2024-02-31
  - startDate <= endDate, ninguna fecha futura, un solo puesto vigente por empresa
`,
  )
  .action((slug: string | undefined) => cmdValidate(slug));

program
  .command('build')
  .argument('<slug>', 'persona')
  .description('compone, resuelve, renderiza y verifica; escribe en out/<slug>/')
  .option('-t, --target <id>', 'arquetipo de targets/<id>.yaml')
  .option('-a, --application <dir>', 'postulación de applications/<dir>/ (aplica su overlay)')
  .option('-f, --format <lista>', `formatos separados por coma: ${OutputFormat.options.join(', ')}`)
  .option('-l, --locale <locale>', 'idioma de salida; debe existir en i18n/ si no es el primario')
  .option('--theme <nombre>', 'tema de src/themes/<nombre>/')
  .option('--channel <canal>', 'release (Chromium pinneado) o preview (Chrome del sistema)', 'release')
  .option('--out-dir <dir>', 'directorio de salida alternativo')
  .option('--no-lint', 'no corre la verificación ATS después de generar')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv build jane-doe
  $ cv build jane-doe --target backend-senior-en --format pdf,docx
  $ cv build jane-doe --application 2026-08-06--acme--staff-backend
  $ cv build jane-doe --locale en --channel preview

Notas:
  - El TXT se genera siempre, aunque no lo pidas: es el ground truth contra el
    que se compara lo que un parser extrae del PDF y del DOCX.
  - El PDF pasa por el fit-loop de densidad hasta entrar en el presupuesto de
    páginas antes de darse por bueno.
  - --channel release usa el Chromium pinneado por el lockfile. Chrome se
    autoactualiza y con él cambia la paginación.
`,
  )
  .action(cmdBuild);

program
  .command('lint')
  .argument('<slug>', 'persona')
  .description('corre las cinco baterías de verificación sobre lo último generado')
  .option('-a, --application <dir>', 'postulación cuyos artefactos se verifican')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv lint jane-doe
  $ cv lint jane-doe --application 2026-08-06--acme--staff-backend

Las cinco baterías:
  css     propiedades que rompen el orden de extracción (float, position, opacity…)
  data    ids, fechas, campos prohibidos por el perfil regional
  ethics  procedencia de los textos y coherencia entre variantes
  pdf     papel, fuentes embebidas, páginas, etiquetado, metadatos
  text    extracción DUAL: si el orden lógico difiere entre los dos modos, falla
  docx    altChunk, runs de texto, estilos nombrados
`,
  )
  .action(cmdLint);

program
  .command('match')
  .argument('<slug>', 'persona')
  .requiredOption('-j, --job <path>', 'ruta a job.yaml')
  .option('-l, --locale <locale>', 'idioma del perfil a usar para el matching')
  .option('-o, --out <path>', 'dónde escribir el reporte (default: junto al job.yaml)')
  .description('puntúa el perfil contra una vacante y escribe match-report.md')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv match jane-doe --job people/jane-doe/applications/2026-08-06--acme--staff-backend/job.yaml
  $ cv match jane-doe --job ./job.yaml --out ./reporte.md

El reporte es un gap accionable, no un número: qué requisitos MUST están
cubiertos y con qué evidencia, cuáles faltan, qué está en tu perfil maestro y
esta vacante pide pero tu selección deja afuera, y qué knockout te bloquea.
`,
  )
  .action((slug: string, options: { job: string; locale?: string; out?: string }) => cmdMatch(slug, options));

program
  .command('tailor')
  .argument('<slug>', 'persona')
  .argument('<application>', 'directorio dentro de applications/')
  .description('genera un overlay.yaml borrador a partir del match-report')
  .option('-t, --target <id>', 'arquetipo del que extiende el overlay')
  .option('-l, --locale <locale>', 'idioma de la postulación')
  .option('--force', 'sobrescribe un overlay.yaml existente')
  .addHelpText(
    'after',
    `
Ejemplo:
  $ cv tailor jane-doe 2026-08-06--acme--staff-backend

El overlay que sale de acá es un BORRADOR: selecciona y reordena por id, y
nunca toca empleadores, fechas ni títulos. Editalo, después pasalo por
\`cv review\` para ver exactamente qué cambió respecto de tu perfil base.
`,
  )
  .action((slug: string, application: string, options: { target?: string; locale?: string; force?: boolean }) =>
    cmdTailor(slug, application, options),
  );

program
  .command('review')
  .argument('<slug>', 'persona')
  .argument('<application>', 'directorio dentro de applications/')
  .description('diff palabra por palabra contra el perfil base, resaltando los cambios de verbo')
  .option('-l, --locale <locale>', 'idioma con el que comparar')
  .option('--strict', 'sale con código 1 si detecta inflación de verbo')
  .addHelpText(
    'after',
    `
Ejemplo:
  $ cv review jane-doe 2026-08-06--acme--staff-backend --strict

Ahí vive la inflación: "colaboré en" convertido en "lideré" no cambia ningún
hecho verificable en el papel, pero sí la pregunta que sigue en la entrevista.
`,
  )
  .action((slug: string, application: string, options: { locale?: string; strict?: boolean }) =>
    cmdReview(slug, application, options),
  );

program
  .command('report')
  .argument('[slug]', 'persona; sin argumento agrega todas')
  .description('funnel de postulaciones: tasa de respuesta, días hasta la primera, etapa de rechazo')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv report
  $ cv report jane-doe

Lee applications/*/meta.yaml. A partir de ~30 postulaciones tenés señal propia,
que vale más que cualquier estadística publicada por un vendor de CVs.
`,
  )
  .action((slug: string | undefined) => cmdReport(slug));

program
  .command('schema')
  .description('regenera schemas/generated/*.json y vendoriza los oficiales de JSON Resume')
  .addHelpText(
    'after',
    `
Ejemplo:
  $ cv schema

Se generan en modo "input" a propósito: el YAML es la entrada, y en modo
"output" los campos con default aparecerían como obligatorios en el editor.
`,
  )
  .action(() => cmdSchema());

program
  .command('new-target')
  .argument('<slug>', 'persona')
  .argument('<id>', 'identificador del arquetipo, ej. backend-senior-en')
  .description('crea people/<slug>/targets/<id>.yaml: a qué puesto, mercado e idioma apuntás')
  .option('-l, --locale <locale>', 'idioma de salida (es, en, de, fr, pt, it)')
  .option('-r, --region <region>', 'mercado: us, ca, uk, de, fr, es, nl, pl, ar, au')
  .option('-i, --industry <industry>', 'tech, consulting, finance, academia, design, medicine, general')
  .option('-s, --seniority <seniority>', 'student, entry, mid, senior, exec')
  .option('--title <titulo>', 'puesto objetivo, ej. "Senior Backend Engineer"')
  .option('--force', 'sobrescribe si ya existe')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv new-target jane-doe backend-senior-en --locale en --region us --title "Senior Backend Engineer"
  $ cv new-target jane-doe consultoria-es --locale es --region es --industry consulting

Por qué existe esta capa:
  El arquetipo concentra el 80 % del trabajo de adaptación y se reutiliza en
  todas las postulaciones que lo compartan. Cada vacante concreta necesita
  después sólo un overlay con el diff mínimo.
`,
  )
  .action(cmdNewTarget);

program
  .command('new-locale')
  .argument('<slug>', 'persona')
  .argument('<locale>', 'idioma a agregar (es, en, de, fr, pt, it)')
  .description('crea people/<slug>/i18n/<locale>.yaml con todos los ids que falta traducir')
  .option('--force', 'sobrescribe si ya existe')
  .addHelpText(
    'after',
    `
Ejemplo:
  $ cv new-locale jane-doe en

Qué genera:
  Un archivo con cada id que tiene texto narrativo y, comentado al lado, el
  original en el idioma primario. El CV no se duplica por idioma: la estructura
  (empresas, fechas, URLs, ids) vive una sola vez en profile/.
`,
  )
  .action(cmdNewLocale);

program
  .command('new-application')
  .argument('<slug>', 'persona')
  .argument('<empresa>', 'nombre de la empresa')
  .argument('<puesto>', 'título del puesto')
  .description('crea la carpeta de una postulación con sus cinco archivos')
  .option('-t, --target <id>', 'arquetipo del que hereda el overlay')
  .option('--date <YYYY-MM-DD>', 'fecha de la postulación (por defecto, hoy)')
  .option('--force', 'sobrescribe si ya existe')
  .addHelpText(
    'after',
    `
Ejemplo:
  $ cv new-application jane-doe "Contoso Payments Inc." "Staff Backend Engineer" --target backend-senior-en

Qué crea en applications/<fecha>--<empresa>--<puesto>/:
  job.raw.md         el aviso crudo (los avisos se borran a las semanas)
  job.yaml           requisitos atomizados y ponderados
  overlay.yaml       el diff contra el arquetipo
  questions.yaml     las respuestas exactas del formulario
  cover-letter.yaml  companyContext obligatorio, escrito a mano
  meta.yaml          estado, timeline y hash de lo enviado
`,
  )
  .action(cmdNewApplication);

program
  .command('doctor')
  .description('diagnóstico del entorno: Node, navegador, fuentes y dependencias')
  .option('--quick', 'no levanta el navegador (más rápido, menos completo)')
  .addHelpText(
    'after',
    `
Ejemplos:
  $ cv doctor
  $ cv doctor --quick
`,
  )
  .action((options: { quick?: boolean }) => cmdDoctor(options));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  reportFatal(error);
  process.exitCode = 1;
}
