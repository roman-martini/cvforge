/**
 * Genera `schemas/generated/*.json` desde los schemas Zod y vendoriza los
 * schemas oficiales de JSON Resume.
 *
 * Dos decisiones que no son de estilo:
 *
 * 1. `io: 'input'`. El YAML es la ENTRADA del sistema. Con `io: 'output'` los
 *    campos que tienen `.default()` se emiten como obligatorios, y el editor
 *    subrayaría en rojo un `work.yaml` perfectamente válido por no declarar
 *    `tags: []`. Como efecto colateral deseado, en modo input `z.strictObject`
 *    sí emite `additionalProperties: false` — que es lo que atrapa un
 *    `sumary:` mal escrito antes de que el CV salga sin resumen.
 *
 * 2. Los oficiales se COPIAN y se PINEAN por versión en `schemas/vendor/`.
 *    Mutan entre versiones menores: 1.2.1 → 1.3.1 eliminó 20 `additionalItems:
 *    false` y el job-schema pasó de draft-04 a draft-07. Validar contra "el
 *    último publicado" convierte una garantía en una lotería de `npm install`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  Awards,
  Basics,
  Certificates,
  Education,
  Eligibility,
  Languages,
  PersonMeta,
  Projects,
  Publications,
  References,
  Skills,
  Work,
} from '../core/schema/sections.ts';
import { ApplicationMeta, Job, Overlay, Target } from '../core/schema/tailoring.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raíz del repositorio, deducida de la ubicación de este archivo. */
export const repoRoot = path.resolve(here, '..', '..');

export type SchemaEntry = {
  /** Nombre base del archivo. Debe coincidir con los globs de .vscode/settings.json. */
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
};

/**
 * El catálogo es la única lista de schemas publicados al editor. Si acá falta
 * una entrada que `.vscode/settings.json` referencia, el YAML queda sin
 * autocompletado y sin validación en vivo: el error aparece recién en el build.
 */
export const schemaCatalog: SchemaEntry[] = [
  {
    name: 'basics',
    title: 'Datos personales (basics.yaml)',
    description: 'Nombre, titular, resumen y contacto. Teléfono y códigos siempre entre comillas.',
    schema: Basics,
  },
  {
    name: 'work',
    title: 'Experiencia laboral (work.yaml)',
    description:
      'Una entrada por empleador, con posiciones múltiples para modelar promociones y bullets en formato XYZ.',
    schema: Work,
  },
  {
    name: 'education',
    title: 'Formación (education.yaml)',
    description: 'Títulos y estudios en curso. `area` y `studyType` son campos traducibles.',
    schema: Education,
  },
  {
    name: 'skills',
    title: 'Habilidades (skills.yaml)',
    description:
      'Forma canónica más alias. El renderer emite el alias que usa la vacante cuando corresponde.',
    schema: Skills,
  },
  {
    name: 'projects',
    title: 'Proyectos (projects.yaml)',
    description: 'Proyectos propios o de terceros, con highlights en el mismo formato que los bullets.',
    schema: Projects,
  },
  {
    name: 'certificates',
    title: 'Certificaciones (certificates.yaml)',
    description: '`expiresAt` alimenta las preguntas eliminatorias del formulario de postulación.',
    schema: Certificates,
  },
  {
    name: 'awards',
    title: 'Premios y distinciones (awards.yaml)',
    description: 'Reconocimientos con fecha y entidad que los otorgó.',
    schema: Awards,
  },
  {
    name: 'languages',
    title: 'Idiomas (languages.yaml)',
    description: 'Nivel expresado en el Marco Común Europeo (A1..C2) o `native`.',
    schema: Languages,
  },
  {
    name: 'publications',
    title: 'Publicaciones (publications.yaml)',
    description:
      'CSL-JSON: la cita se guarda estructurada para que el estilo (APA, IEEE…) lo decida el renderer.',
    schema: Publications,
  },
  {
    name: 'references',
    title: 'Referencias (references.yaml)',
    description: 'Sólo iniciales y rol: los datos de contacto de un tercero no viven en el repositorio.',
    schema: References,
  },
  {
    name: 'eligibility',
    title: 'Elegibilidad (eligibility.yaml)',
    description:
      'Permisos de trabajo, disponibilidad y pretensiones. Es la base para responder las knockout questions.',
    schema: Eligibility,
  },
  {
    name: 'person-meta',
    title: 'Metadatos de la persona (meta.yaml)',
    description: 'Locale primario, locales disponibles, versión del modelo y registro de consentimiento.',
    schema: PersonMeta,
  },
  {
    name: 'target',
    title: 'Arquetipo de postulación (targets/*.yaml)',
    description:
      'Capa reutilizable: región, industria, idioma, orden de secciones y presupuesto. Acá vive el 80 % del tailoring.',
    schema: Target,
  },
  {
    name: 'job',
    title: 'Vacante atomizada (applications/*/job.yaml)',
    description: 'Requisitos ponderados por tipo y peso, más las preguntas eliminatorias del formulario.',
    schema: Job,
  },
  {
    name: 'overlay',
    title: 'Overlay de postulación (applications/*/overlay.yaml)',
    description:
      'Selección y reordenamiento por id sobre un arquetipo. Sólo puede tocar campos narrativos, nunca hechos.',
    schema: Overlay,
  },
  {
    name: 'application-meta',
    title: 'Estado de la postulación (applications/*/meta.yaml)',
    description: 'Timeline, artefactos enviados por SHA-256 y procedencia del build.',
    schema: ApplicationMeta,
  },
];

export type SchemaGenerationResult = {
  /** Rutas relativas de todos los schemas emitidos. */
  generated: string[];
  /** Subconjunto de `generated` cuyo contenido cambió respecto del disco. */
  changed: string[];
  /** Rutas relativas de los archivos copiados a schemas/vendor/. */
  vendored: string[];
  warnings: string[];
};

const DRAFT_7 = 'http://json-schema.org/draft-07/schema#';

function buildDocument(entry: SchemaEntry): string {
  const emitted = z.toJSONSchema(entry.schema, {
    target: 'draft-7',
    io: 'input',
  }) as Record<string, unknown>;

  // El `$schema` que emite Zod se reescribe para dejarlo siempre primero y en
  // el dialecto exacto que espera el servidor de YAML de VS Code.
  const { $schema: _emittedDialect, ...body } = emitted;

  const document = {
    $schema: DRAFT_7,
    $id: `urn:cv-workspace:schema:${entry.name}`,
    title: entry.title,
    description: entry.description,
    ...body,
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Escribe sólo si el contenido cambió: evita tocar mtime en cada pre-commit. */
async function writeIfChanged(file: string, content: string): Promise<boolean> {
  try {
    const previous = await fs.readFile(file, 'utf8');
    if (previous === content) return false;
  } catch {
    // No existía: se escribe.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return true;
}

async function copyPinned(source: string, target: string): Promise<void> {
  const raw = await fs.readFile(source, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  await writeIfChanged(target, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Copia los schemas oficiales de JSON Resume desde node_modules, con la versión
 * en el nombre del archivo. Si el paquete no está instalado no falla: el
 * workspace sigue siendo utilizable sin la validación de interoperabilidad.
 */
async function vendorJsonResume(root: string, result: SchemaGenerationResult): Promise<void> {
  const packageDir = path.join(root, 'node_modules', '@jsonresume', 'schema');
  const vendorDir = path.join(root, 'schemas', 'vendor');

  let version: string;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as {
      version?: string;
    };
    version = manifest.version ?? 'unknown';
  } catch {
    result.warnings.push(
      '@jsonresume/schema no está instalado: no se vendorizaron los schemas oficiales. Ejecutá `npm install`.',
    );
    return;
  }

  const pairs: Array<[string, string]> = [
    [path.join(packageDir, 'schema.json'), path.join(vendorDir, `jsonresume-${version}.schema.json`)],
    [
      path.join(packageDir, 'job-schema.json'),
      path.join(vendorDir, `jsonresume-job-${version}.schema.json`),
    ],
  ];

  for (const [source, target] of pairs) {
    try {
      await copyPinned(source, target);
      result.vendored.push(path.relative(root, target));
    } catch {
      result.warnings.push(`No se pudo copiar ${path.relative(root, source)}.`);
    }
  }

  // Los ejemplos oficiales son los golden files de la proyección a JSON Resume:
  // si un cambio nuestro rompe la lectura de un CV canónico, se nota acá.
  const examplesDir = path.join(packageDir, 'examples');
  let examples: string[] = [];
  try {
    examples = (await fs.readdir(examplesDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return;
  }

  for (const name of examples) {
    const target = path.join(vendorDir, 'examples', name);
    try {
      await copyPinned(path.join(examplesDir, name), target);
      result.vendored.push(path.relative(root, target));
    } catch {
      result.warnings.push(`No se pudo copiar el ejemplo ${name}.`);
    }
  }
}

export async function generateSchemas(root: string = repoRoot): Promise<SchemaGenerationResult> {
  const result: SchemaGenerationResult = { generated: [], changed: [], vendored: [], warnings: [] };
  const outDir = path.join(root, 'schemas', 'generated');
  await fs.mkdir(outDir, { recursive: true });

  for (const entry of schemaCatalog) {
    const file = path.join(outDir, `${entry.name}.schema.json`);
    const relative = path.relative(root, file);
    const wrote = await writeIfChanged(file, buildDocument(entry));
    result.generated.push(relative);
    if (wrote) result.changed.push(relative);
  }

  await vendorJsonResume(root, result);
  return result;
}

async function main(): Promise<void> {
  const result = await generateSchemas();
  process.stdout.write(
    `${result.generated.length} schemas en schemas/generated/ (${result.changed.length} con cambios), ` +
      `${result.vendored.length} archivos vendorizados.\n`,
  );
  for (const warning of result.warnings) process.stderr.write(`aviso: ${warning}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
