import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { z } from 'zod';
import type { LoadedPerson } from './types.ts';
import {
  Awards,
  Basics,
  Certificates,
  Education,
  Eligibility,
  Languages,
  PersonMeta,
  PersonProfile,
  Projects,
  Publications,
  References,
  Skills,
  Work,
} from './schema/sections.ts';
import { refineProfile } from './schema/refine.ts';
import type { Issue } from './schema/refine.ts';

/**
 * Carga de datos de una persona: YAML → PersonProfile validado.
 *
 * Este módulo es el principal punto de contacto del usuario con el sistema: el
 * error de validación es lo único que ve cuando algo está mal escrito. Un
 * mensaje críptico acá hace que abandone el workspace, así que todo error dice
 * archivo, path exacto de la clave, línea y qué se esperaba.
 */

// Los mensajes de Zod salen en español para todo el proceso. Es configuración
// global del paquete; se hace acá porque este módulo es la puerta de entrada.
z.config(z.locales.es());

/* ========================================================================== *
 * Presentación en consola
 * ========================================================================== */

/** Convención NO_COLOR/FORCE_COLOR; sin TTY se emite texto plano. */
function colorEnabled(): boolean {
  const noColor = process.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  if (process.env['TERM'] === 'dumb') return false;
  return process.stderr.isTTY === true;
}

/** Introductor de secuencias ANSI. Se arma en runtime para no meter un carácter de control en el fuente. */
const CSI = `${String.fromCharCode(27)}[`;

function paint(code: string, text: string): string {
  return colorEnabled() ? `${CSI}${code}m${text}${CSI}0m` : text;
}

/** Estilos con significado, no colores sueltos: los reusan i18n.ts y compose.ts. */
export const style = {
  file: (t: string) => paint('1;36', t),
  error: (t: string) => paint('31', t),
  warn: (t: string) => paint('33', t),
  ok: (t: string) => paint('32', t),
  key: (t: string) => paint('1', t),
  hint: (t: string) => paint('2', t),
};

/** Error de datos ya formateado para consola. El CLI imprime `message` tal cual. */
export class CvDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CvDataError';
  }
}

/* ========================================================================== *
 * Utilidades de path y de forma
 * ========================================================================== */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `["work", 0, "positions", 1, "title"]` → `work[0].positions[1].title`. */
function formatPath(segments: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out === '' ? '(raíz del archivo)' : out;
}

/** La inversa de `formatPath`, para los paths que `refineProfile` emite como string. */
function parsePathString(value: string): PropertyKey[] {
  const segments: PropertyKey[] = [];
  for (const match of value.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    const index = match[1];
    const key = match[2];
    if (index !== undefined) segments.push(Number(index));
    else if (key !== undefined) segments.push(key);
  }
  return segments;
}

function valueAt(data: unknown, segments: readonly PropertyKey[]): unknown {
  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (typeof segment !== 'number') return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<PropertyKey, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function typeName(value: unknown): string {
  if (value === null) return 'null (una clave sin valor en YAML es null)';
  if (Array.isArray(value)) return 'una lista';
  if (value instanceof Date) return 'una fecha';
  return typeof value === 'object' ? 'un mapeo' : `un ${typeof value}`;
}

/* ========================================================================== *
 * Sugerencia de clave: el caso que z.strictObject existe para atrapar
 * ========================================================================== */

function editDistance(a: string, b: string): number {
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min((previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = temp;
    }
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function suggestKey(unknownKey: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(unknownKey.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const tolerance = Math.max(2, Math.floor(unknownKey.length / 3));
  return best !== undefined && bestDistance <= tolerance ? best : undefined;
}

/** Desenvuelve optional/default/nullable hasta el schema que realmente describe la forma. */
function unwrapSchema(schema: unknown): Record<string, unknown> | undefined {
  let current = schema;
  for (let depth = 0; depth < 12; depth++) {
    if (!isRecord(current)) return undefined;
    const def = current['def'];
    const kind = isRecord(def) ? def['type'] : undefined;
    if (
      kind === 'optional' ||
      kind === 'default' ||
      kind === 'prefault' ||
      kind === 'nullable' ||
      kind === 'readonly' ||
      kind === 'nonoptional'
    ) {
      const unwrap = current['unwrap'];
      if (typeof unwrap !== 'function') return undefined;
      current = (unwrap as () => unknown).call(current);
      continue;
    }
    return current;
  }
  return undefined;
}

/** Claves válidas del objeto que vive en `segments`, para sugerir ante una clave desconocida. */
function shapeKeysAt(schema: unknown, segments: readonly PropertyKey[]): string[] | undefined {
  let current = unwrapSchema(schema);
  for (const segment of segments) {
    if (current === undefined) return undefined;
    const def = current['def'];
    const kind = isRecord(def) ? def['type'] : undefined;
    if (kind === 'object' && isRecord(current['shape'])) {
      current = unwrapSchema(current['shape'][String(segment)]);
      continue;
    }
    if (kind === 'array') {
      current = unwrapSchema(current['element']);
      continue;
    }
    if (kind === 'record') {
      current = unwrapSchema(current['valueType']);
      continue;
    }
    return undefined;
  }
  if (current === undefined) return undefined;
  const def = current['def'];
  const kind = isRecord(def) ? def['type'] : undefined;
  if (kind !== 'object' || !isRecord(current['shape'])) return undefined;
  return Object.keys(current['shape']);
}

/* ========================================================================== *
 * Lectura de YAML
 * ========================================================================== */

export type YamlSource = {
  /** Ruta absoluta: la que se abre en el editor. */
  file: string;
  /** Ruta relativa al root del workspace: la que se muestra en consola. */
  label: string;
  data: unknown;
  doc: Document;
  lineCounter: LineCounter;
};

function formatYamlErrors(doc: Document, label: string): string {
  const lines = [`${style.error('✖')} ${style.file(label)} — el YAML no se puede parsear`];
  for (const error of doc.errors) {
    const at = error.linePos?.[0];
    const where = at ? style.hint(`línea ${at.line}, columna ${at.col}`) : '';
    lines.push(`  ${style.error('✖')} ${style.key(error.code)}${where ? `  ${where}` : ''}`);
    for (const line of error.message.split('\n')) lines.push(`      ${line}`);
  }
  return lines.join('\n');
}

/**
 * Lee y parsea un YAML. Devuelve `null` si el archivo no existe (los llamadores
 * deciden si eso es un error), y lanza si el archivo existe pero está roto.
 *
 * Se usa la configuración POR DEFECTO del parser (YAML 1.2 core). Con
 * `{ version: '1.1' }` el país `NO` se vuelve `false`, `2023-04-01` se vuelve un
 * objeto Date y `01234` se interpreta en octal como 668.
 */
export async function readYaml(file: string, label?: string): Promise<YamlSource | null> {
  const shown = label ?? file;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: true });
  if (doc.errors.length > 0) throw new CvDataError(formatYamlErrors(doc, shown));
  return { file, label: shown, data: doc.toJS(), doc, lineCounter };
}

/** Valida `src.data` contra `schema`; si falla, lanza el error ya formateado. */
export function parseYamlWith<S extends z.ZodType>(schema: S, src: YamlSource): z.output<S> {
  const result = schema.safeParse(src.data);
  if (!result.success) {
    throw new CvDataError(formatIssues(result.error.issues, src.label, src, schema));
  }
  return result.data as z.output<S>;
}

/* ========================================================================== *
 * Formateo de diagnósticos
 * ========================================================================== */

type Normalized = {
  segments: PropertyKey[];
  display: string;
  message: string;
  severity: 'error' | 'warning';
  rule?: string;
  hint?: string;
};

function isRefineIssue(issue: z.core.$ZodIssue | Issue): issue is Issue {
  return typeof (issue as Issue).path === 'string';
}

/** Ubica el path dentro del documento YAML; si no lo encuentra, sube al ancestro más cercano. */
function locate(src: YamlSource, segments: readonly PropertyKey[]): string | undefined {
  // El segundo candidato cubre los paths de refineProfile, que arrancan con el
  // nombre de la sección mientras que el archivo ya es esa sección.
  const bases: PropertyKey[][] = [[...segments], segments.slice(1)];
  for (let length = segments.length; length >= 0; length--) {
    for (const base of bases) {
      if (length > base.length) continue;
      let node: unknown;
      try {
        node = src.doc.getIn(base.slice(0, length), true);
      } catch {
        continue;
      }
      const range = isRecord(node) ? node['range'] : undefined;
      if (!Array.isArray(range) || typeof range[0] !== 'number') continue;
      const at = src.lineCounter.linePos(range[0]);
      return `línea ${at.line}, columna ${at.col}`;
    }
  }
  return undefined;
}

function hintFor(
  issue: z.core.$ZodIssue,
  actual: unknown,
  schema: z.ZodType | undefined,
): string | undefined {
  if (issue.code === 'unrecognized_keys') {
    const keys = schema === undefined ? undefined : shapeKeysAt(schema, issue.path);
    for (const key of issue.keys) {
      const guess = keys === undefined ? undefined : suggestKey(key, keys);
      if (guess !== undefined) return `¿Quisiste decir "${guess}"?`;
    }
    return keys === undefined
      ? 'El schema es estricto a propósito: una clave mal escrita se descartaría en silencio y el CV saldría sin ese dato.'
      : `Claves válidas acá: ${keys.join(', ')}.`;
  }
  if (issue.code === 'invalid_type' && issue.expected === 'string' && typeof actual === 'number') {
    return 'YAML convierte a número lo que parece un número: "+54 9 11…" pierde el +, 01234 queda en 1234 y 4.0 se imprime "4". Poné el valor entre comillas.';
  }
  if (issue.code === 'invalid_type' && actual === null) {
    return 'Una clave sin valor (`endDate:`) vale null. Borrá la clave o dale un valor.';
  }
  if (issue.code === 'invalid_type' && issue.expected === 'array' && isRecord(actual)) {
    return 'Esta sección es una lista: cada ítem arranca con "- ".';
  }
  return undefined;
}

function normalize(
  issue: z.core.$ZodIssue | Issue,
  source: YamlSource | undefined,
  schema: z.ZodType | undefined,
): Normalized {
  if (isRefineIssue(issue)) {
    return {
      segments: parsePathString(issue.path),
      display: issue.path,
      message: issue.message,
      severity: issue.severity,
      rule: issue.rule,
    };
  }
  const segments = [...issue.path];
  const actual = source === undefined ? undefined : valueAt(source.data, segments);
  const parentExists =
    segments.length > 0 &&
    source !== undefined &&
    valueAt(source.data, segments.slice(0, -1)) !== undefined;
  const missingKey = issue.code === 'invalid_type' && actual === undefined && parentExists;
  const last = segments[segments.length - 1];
  return {
    segments,
    display: formatPath(segments),
    message: missingKey
      ? `Falta la clave obligatoria "${String(last)}".`
      : source === undefined || actual === undefined
        ? issue.message
        : `${issue.message} (llegó ${typeName(actual)})`,
    severity: 'error',
    hint: hintFor(issue, actual, schema),
  };
}

/**
 * Salida legible en consola de un conjunto de issues, con colores ANSI.
 * Acepta tanto los issues de Zod v4 como los de `refineProfile`.
 */
export function formatIssues(
  issues: readonly (z.core.$ZodIssue | Issue)[],
  file: string,
  source?: YamlSource,
  schema?: z.ZodType,
): string {
  const normalized = issues.map((issue) => normalize(issue, source, schema));
  const errors = normalized.filter((n) => n.severity === 'error').length;
  const warnings = normalized.length - errors;
  const counts: string[] = [];
  if (errors > 0) counts.push(errors === 1 ? '1 error' : `${errors} errores`);
  if (warnings > 0) counts.push(warnings === 1 ? '1 aviso' : `${warnings} avisos`);

  const marker = errors > 0 ? style.error('✖') : style.warn('⚠');
  const lines = [`${marker} ${style.file(file)} — ${counts.join(', ')}`];
  for (const item of normalized) {
    const bullet = item.severity === 'error' ? style.error('✖') : style.warn('⚠');
    const where = source === undefined ? undefined : locate(source, item.segments);
    const rule = item.rule === undefined ? '' : ` ${style.hint(`[${item.rule}]`)}`;
    const at = where === undefined ? '' : `  ${style.hint(where)}`;
    lines.push(`  ${bullet} ${style.key(item.display)}${rule}${at}`);
    lines.push(`      ${item.message}`);
    if (item.hint !== undefined) lines.push(`      ${style.hint(`↳ ${item.hint}`)}`);
  }
  return lines.join('\n');
}

/* ========================================================================== *
 * Carga de una persona
 * ========================================================================== */

/** Secciones de `profile/` que son listas; ausentes valen array vacío. */
const LIST_SECTIONS = {
  work: Work,
  education: Education,
  skills: Skills,
  projects: Projects,
  certificates: Certificates,
  awards: Awards,
  languages: Languages,
  publications: Publications,
  references: References,
} as const;

/** Datos sensibles: viven fuera de git y se fusionan sobre basics en tiempo de carga. */
const ContactPrivate = z.strictObject({
  phone: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  postalCode: z.string().min(1).optional(),
  nationalId: z.string().min(1).optional(),
});
type ContactPrivate = z.infer<typeof ContactPrivate>;

function mergeContact(basics: unknown, contact: ContactPrivate | undefined): unknown {
  if (contact === undefined || !isRecord(basics)) return basics;
  const merged: Record<string, unknown> = { ...basics };
  if (contact.phone !== undefined) merged['phone'] = contact.phone;
  if (contact.nationalId !== undefined) merged['nationalId'] = contact.nationalId;
  if (contact.address !== undefined || contact.postalCode !== undefined) {
    const location = isRecord(merged['location']) ? { ...merged['location'] } : {};
    if (contact.address !== undefined) location['address'] = contact.address;
    if (contact.postalCode !== undefined) location['postalCode'] = contact.postalCode;
    merged['location'] = location;
  }
  return merged;
}

/** `contact.private.yaml` manda; si no está, se usa el ejemplo commiteado; si no, nada. */
async function loadContact(dir: string, root: string): Promise<ContactPrivate | undefined> {
  for (const name of ['contact.private.yaml', 'contact.example.yaml']) {
    const file = path.join(dir, name);
    const src = await readYaml(file, path.relative(root, file));
    if (src === null) continue;
    if (src.data === null || src.data === undefined) return undefined;
    return parseYamlWith(ContactPrivate, src);
  }
  return undefined;
}

async function loadListSection<S extends z.ZodType>(
  dir: string,
  root: string,
  name: string,
  schema: S,
): Promise<{ value: z.output<S>; source: YamlSource | undefined }> {
  const file = path.join(dir, 'profile', `${name}.yaml`);
  const src = await readYaml(file, path.relative(root, file));
  if (src === null || src.data === null || src.data === undefined) {
    return { value: schema.parse([]) as z.output<S>, source: src ?? undefined };
  }
  return { value: parseYamlWith(schema, src), source: src };
}

/** Agrupa los issues de `refineProfile` por sección para poder citar archivo y línea. */
function reportProfileIssues(
  issues: readonly Issue[],
  sources: ReadonlyMap<string, YamlSource>,
  fallback: string,
): string {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const section = issue.path.split(/[.[]/)[0] ?? '';
    const bucket = groups.get(section);
    if (bucket === undefined) groups.set(section, [issue]);
    else bucket.push(issue);
  }
  const blocks: string[] = [];
  for (const [section, bucket] of groups) {
    const source = sources.get(section);
    blocks.push(formatIssues(bucket, source?.label ?? fallback, source));
  }
  return blocks.join('\n\n');
}

async function loadI18n(
  dir: string,
  root: string,
  locales: readonly string[],
  primaryLocale: string,
): Promise<Record<string, Record<string, unknown>>> {
  const i18nDir = path.join(dir, 'i18n');
  let entries: string[];
  try {
    entries = await readdir(i18nDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  const table: Record<string, Record<string, unknown>> = {};
  for (const entry of entries.sort()) {
    const extension = path.extname(entry);
    if (extension !== '.yaml' && extension !== '.yml') continue;
    const locale = path.basename(entry, extension);
    const file = path.join(i18nDir, entry);
    const label = path.relative(root, file);
    if (locale === primaryLocale) {
      throw new CvDataError(
        `${style.error('✖')} ${style.file(label)} — el locale primario es "${primaryLocale}": su narrativa vive en profile/, no en i18n/.\n      ${style.hint('Borrá el archivo o cambiá meta.primaryLocale.')}`,
      );
    }
    if (!locales.includes(locale)) {
      throw new CvDataError(
        `${style.error('✖')} ${style.file(label)} — el locale "${locale}" no está declarado en meta.yaml.\n      ${style.hint(`Agregalo a locales: [${[...locales, locale].join(', ')}] o corregí el nombre del archivo.`)}`,
      );
    }
    const src = await readYaml(file, label);
    if (src === null) continue;
    if (src.data === null || src.data === undefined) {
      table[locale] = {};
      continue;
    }
    if (!isRecord(src.data)) {
      throw new CvDataError(
        `${style.error('✖')} ${style.file(label)} — se esperaba un mapeo indexado por id.`,
      );
    }
    table[locale] = src.data;
  }
  const missing = locales.filter((locale) => table[locale] === undefined);
  if (missing.length > 0) {
    throw new CvDataError(
      `${style.error('✖')} ${style.file(path.relative(root, path.join(dir, 'meta.yaml')))} — declara locales sin archivo de narrativa: ${missing.join(', ')}.\n      ${style.hint(`Creá ${missing.map((locale) => path.join('i18n', `${locale}.yaml`)).join(', ')} o sacalos de meta.locales.`)}`,
    );
  }
  return table;
}

/**
 * Carga y valida el perfil completo de una persona.
 *
 * Admite dos formas de llamada porque hay dos maneras naturales de nombrar a
 * una persona según desde dónde se la invoque:
 *
 *   loadPerson('/repo', 'jane-doe')          → '<root>/people/jane-doe'
 *   loadPerson('/repo/fixtures/people/jane-doe')
 *
 * La segunda existe para poder cargar personas que no viven bajo `people/`,
 * como las fixtures del repositorio, sin duplicar la lógica de carga.
 */
export async function loadPerson(rootOrDir: string, slug?: string): Promise<LoadedPerson> {
  const dir = slug === undefined ? path.resolve(rootOrDir) : path.join(rootOrDir, 'people', slug);
  // Con el directorio directo, la raíz del workspace es el abuelo: los mensajes
  // de error se muestran relativos a ella y así quedan legibles en ambos casos.
  const root = slug === undefined ? path.resolve(dir, '..', '..') : rootOrDir;
  const resolvedSlug = slug ?? path.basename(dir);
  const label = (...parts: string[]) => path.relative(root, path.join(dir, ...parts));

  const metaSrc = await readYaml(path.join(dir, 'meta.yaml'), label('meta.yaml'));
  if (metaSrc === null) {
    throw new CvDataError(
      `${style.error('✖')} No existe ${style.file(label('meta.yaml'))}.\n      ${style.hint('Toda persona necesita meta.yaml con slug, primaryLocale y modelVersion.')}`,
    );
  }
  const meta = parseYamlWith(PersonMeta, metaSrc);
  if (meta.slug !== resolvedSlug) {
    throw new CvDataError(
      `${style.error('✖')} ${style.file(label('meta.yaml'))} — meta.slug es "${meta.slug}" pero el directorio se llama "${resolvedSlug}".\n      ${style.hint('El directorio manda: los overlays y los reportes referencian ese nombre.')}`,
    );
  }

  const basicsSrc = await readYaml(path.join(dir, 'profile', 'basics.yaml'), label('profile', 'basics.yaml'));
  if (basicsSrc === null) {
    throw new CvDataError(
      `${style.error('✖')} No existe ${style.file(label('profile', 'basics.yaml'))}.\n      ${style.hint('Sin basics no hay nombre ni contacto: es la única sección obligatoria del perfil.')}`,
    );
  }
  const contact = await loadContact(dir, root);
  const basics = parseYamlWith(Basics, { ...basicsSrc, data: mergeContact(basicsSrc.data, contact) });

  const sources = new Map<string, YamlSource>([
    ['meta', metaSrc],
    ['basics', basicsSrc],
  ]);
  const sections: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(LIST_SECTIONS)) {
    const loaded = await loadListSection(dir, root, name, schema);
    sections[name] = loaded.value;
    if (loaded.source !== undefined) sources.set(name, loaded.source);
  }

  const eligibilityFile = path.join(dir, 'profile', 'eligibility.yaml');
  const eligibilitySrc = await readYaml(eligibilityFile, label('profile', 'eligibility.yaml'));
  const eligibility =
    eligibilitySrc === null || eligibilitySrc.data === null || eligibilitySrc.data === undefined
      ? undefined
      : parseYamlWith(Eligibility, eligibilitySrc);
  if (eligibilitySrc !== null) sources.set('eligibility', eligibilitySrc);

  const candidate = {
    meta,
    basics,
    ...sections,
    ...(eligibility === undefined ? {} : { eligibility }),
  };
  const parsed = PersonProfile.safeParse(candidate);
  if (!parsed.success) {
    throw new CvDataError(
      formatIssues(parsed.error.issues, path.relative(root, dir), undefined, PersonProfile),
    );
  }
  const profile = parsed.data;

  const issues = refineProfile(profile);
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (warnings.length > 0) {
    process.stderr.write(`${reportProfileIssues(warnings, sources, path.relative(root, dir))}\n`);
  }
  if (errors.length > 0) {
    throw new CvDataError(reportProfileIssues(errors, sources, path.relative(root, dir)));
  }

  const i18n = await loadI18n(dir, root, meta.locales, meta.primaryLocale);
  return { slug: resolvedSlug, dir, profile, i18n };
}

/** Slugs de `<root>/people/` que tienen meta.yaml, en orden estable. */
export async function listPeople(root: string): Promise<string[]> {
  const peopleDir = path.join(root, 'people');
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(peopleDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(peopleDir, entry.name, 'meta.yaml'));
      slugs.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return slugs.sort();
}
