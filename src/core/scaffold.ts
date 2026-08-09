import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { PersonProfile } from './schema/sections.ts';

/**
 * Generadores de esqueletos: arquetipo, archivo de idioma y postulación.
 *
 * Existen porque son los tres puntos donde el flujo tiene más fricción manual.
 * Una postulación son cinco archivos que se referencian entre sí; escribirlos a
 * mano invita a errores de id que recién aparecen al renderizar. El esqueleto
 * de idioma es peor todavía: hay que enumerar a mano todos los ids con texto
 * narrativo, y omitir uno rompe el build recién cuando se pide ese locale.
 *
 * Todos los archivos salen comentados y con la referencia `$schema`, para que
 * el editor autocomplete y valide mientras se escriben.
 */

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Ruta relativa desde un archivo hasta el schema generado que lo valida. */
function schemaRef(fromDir: string, root: string, name: string): string {
  const target = path.join(root, 'schemas', 'generated', `${name}.schema.json`);
  return path.relative(fromDir, target).split(path.sep).join('/');
}

export type ScaffoldResult = { file: string; created: boolean };

/* ========================================================================== *
 * Arquetipo
 * ========================================================================== */

export type NewTargetOptions = {
  personDir: string;
  root: string;
  id: string;
  locale: string;
  region: string;
  industry?: string;
  seniority?: string;
  titleTarget?: string;
  force?: boolean;
};

export async function newTarget(opts: NewTargetOptions): Promise<ScaffoldResult> {
  const dir = path.join(opts.personDir, 'targets');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${opts.id}.yaml`);
  if ((await exists(file)) && !opts.force) return { file, created: false };

  const content = `# yaml-language-server: $schema=${schemaRef(dir, opts.root, 'target')}

# Arquetipo: "a qué tipo de puesto apunto, en qué mercado y en qué idioma".
#
# Acá se hace el 80 % del trabajo de adaptación, UNA vez, y se reutiliza en
# todas las postulaciones que compartan este perfil. Cada vacante concreta sólo
# necesita después un overlay con el diff mínimo contra este archivo.
#
# Sin esta capa intermedia, cada postulación rehace el trabajo desde cero y el
# sistema deja de escalar justo cuando empieza a servir.

id: ${opts.id}

# Idioma de salida. Si no es el primario de la persona, tiene que existir el
# archivo i18n/<locale>.yaml con la narrativa traducida.
locale: ${opts.locale}

# Mercado: decide el papel (A4/Letter), el máximo de páginas, el formato de
# fecha, las etiquetas de sección y qué campos están prohibidos por norma.
region: ${opts.region}

industry: ${opts.industry ?? 'tech'}
${opts.seniority ? `seniority: ${opts.seniority}\n` : '# seniority: senior\n'}
theme: ats-classic

# El puesto al que apuntás. Alimenta basics.label salvo que un overlay lo pise.
titleTarget: "${opts.titleTarget ?? 'Tu puesto objetivo'}"

# Términos canónicos del arquetipo: el matcher los usa como semilla.
keywords: []

# ORDEN Y SELECCIÓN de secciones: lo que no está acá no se imprime.
# El CLI avisa si dejás afuera una sección que tiene datos cargados.
sectionOrder: [contact, summary, skills, work, education, certificates, projects]

budget:
  maxPages: 2
  bulletsPerRole: { recent: 5, mid: 3, old: 2 }

# Placeholders: {First} {Last} {Role} {Company} {ext}
# Nunca incluyas la variante ni la empresa en el nombre si vas a subirlo a un
# portal: el reclutador ve el nombre del archivo.
fileNameTemplate: "{First}-{Last}-{Role}.{ext}"

formats: [pdf, docx, txt]
`;

  await writeFile(file, content, 'utf8');
  return { file, created: true };
}

/* ========================================================================== *
 * Archivo de idioma
 * ========================================================================== */

/** Recolecta los ids con texto narrativo y el texto original, para traducirlo. */
function narrativeEntries(profile: PersonProfile): Array<{ id: string; fields: Record<string, string> }> {
  const entries: Array<{ id: string; fields: Record<string, string> }> = [];

  for (const work of profile.work) {
    const fields: Record<string, string> = {};
    if (work.summary) fields['summary'] = work.summary;
    if (Object.keys(fields).length > 0) entries.push({ id: work.id, fields });
    for (const position of work.positions) {
      entries.push({ id: position.id, fields: { title: position.title } });
    }
    for (const bullet of work.bullets) {
      const bulletFields: Record<string, string> = { outcome: bullet.outcome };
      if (bullet.method) bulletFields['method'] = bullet.method;
      entries.push({ id: bullet.id, fields: bulletFields });
    }
  }

  for (const education of profile.education) {
    entries.push({ id: education.id, fields: { area: education.area, studyType: education.studyType } });
  }

  for (const project of profile.projects) {
    const fields: Record<string, string> = { name: project.name };
    if (project.description) fields['description'] = project.description;
    entries.push({ id: project.id, fields });
    for (const highlight of project.highlights) {
      entries.push({ id: highlight.id, fields: { outcome: highlight.outcome } });
    }
  }

  for (const award of profile.awards) {
    const fields: Record<string, string> = { title: award.title };
    if (award.summary) fields['summary'] = award.summary;
    entries.push({ id: award.id, fields });
  }

  for (const language of profile.languages) {
    entries.push({ id: language.id, fields: { language: language.language } });
  }

  return entries;
}

/**
 * Declara el locale en `meta.yaml`.
 *
 * Va junto con la creación del archivo y no como paso aparte: el cargador exige
 * que todo archivo de i18n esté declarado, así que crear uno sin declararlo
 * deja el repositorio en un estado que no compila. Un generador que produce un
 * estado inválido es peor que no tener generador.
 */
async function declareLocale(personDir: string, locale: string): Promise<void> {
  const metaFile = path.join(personDir, 'meta.yaml');
  const raw = await readFile(metaFile, 'utf8');
  if (new RegExp(`^\\s*-?\\s*["']?${locale}["']?\\s*$`, 'm').test(raw.split('locales:')[1]?.split('\n\n')[0] ?? '')) {
    return;
  }

  // Se edita el texto y no el árbol parseado para no perder los comentarios,
  // que en estos archivos son la mitad de la documentación.
  const inline = raw.match(/^locales:\s*\[(.*)\]\s*$/m);
  if (inline) {
    const current = inline[1]!.trim();
    if (current.includes(locale)) return;
    const next = current === '' ? locale : `${current}, ${locale}`;
    await writeFile(metaFile, raw.replace(inline[0], `locales: [${next}]`), 'utf8');
    return;
  }

  const block = raw.match(/^locales:\s*$/m);
  if (block) {
    await writeFile(metaFile, raw.replace(block[0], `locales:\n  - ${locale}`), 'utf8');
    return;
  }

  await writeFile(metaFile, `${raw.trimEnd()}\nlocales: [${locale}]\n`, 'utf8');
}

export async function newLocale(opts: {
  personDir: string;
  profile: PersonProfile;
  locale: string;
  force?: boolean;
}): Promise<ScaffoldResult> {
  const dir = path.join(opts.personDir, 'i18n');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${opts.locale}.yaml`);
  if ((await exists(file)) && !opts.force) return { file, created: false };
  await declareLocale(opts.personDir, opts.locale);

  const primary = opts.profile.meta.primaryLocale;
  const lines: string[] = [
    `# Narrativa en "${opts.locale}". SÓLO los campos que un lector ve; la`,
    `# estructura (ids, empresas, fechas, URLs) vive una sola vez en profile/.`,
    '#',
    `# Cada clave es un id del perfil y cada valor es el texto ya traducido.`,
    `# Debajo de cada uno quedó comentado el original en "${primary}" como`,
    '# referencia: reemplazá el valor y borrá el comentario cuando termines.',
    '#',
    '# El build FALLA si un id que entra al CV no tiene su traducción acá. Un CV',
    '# a medias en dos idiomas es peor que uno que no compila.',
    '',
    'basics:',
    `  label: "" # ${opts.profile.basics.label}`,
    `  summary: "" # ${opts.profile.basics.summary.replace(/\s+/g, ' ').slice(0, 120)}…`,
    '',
  ];

  for (const entry of narrativeEntries(opts.profile)) {
    lines.push(`${entry.id}:`);
    for (const [field, original] of Object.entries(entry.fields)) {
      const preview = original.replace(/\s+/g, ' ').slice(0, 100);
      lines.push(`  ${field}: "" # ${preview}${original.length > 100 ? '…' : ''}`);
    }
    lines.push('');
  }

  await writeFile(file, lines.join('\n'), 'utf8');
  return { file, created: true };
}

/* ========================================================================== *
 * Postulación
 * ========================================================================== */

export type NewApplicationOptions = {
  personDir: string;
  root: string;
  company: string;
  role: string;
  target: string;
  date?: string;
  force?: boolean;
};

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function newApplication(
  opts: NewApplicationOptions,
): Promise<{ dir: string; files: string[]; created: boolean }> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const name = `${date}--${slugify(opts.company)}--${slugify(opts.role)}`;
  const dir = path.join(opts.personDir, 'applications', name);

  if ((await exists(dir)) && !opts.force) return { dir, files: [], created: false };
  await mkdir(dir, { recursive: true });

  const files: string[] = [];
  const write = async (file: string, content: string) => {
    const full = path.join(dir, file);
    await writeFile(full, content, 'utf8');
    files.push(full);
  };

  await write(
    'job.raw.md',
    `# ${opts.role} — ${opts.company}

<!-- Pegá acá el aviso COMPLETO, tal como está publicado.

     Se guarda crudo a propósito: los avisos se borran a las pocas semanas y
     después no hay forma de reconstruir contra qué se postuló uno. Es también
     la fuente contra la que se revisa que job.yaml no haya inventado nada. -->
`,
  );

  await write(
    'job.yaml',
    `# yaml-language-server: $schema=${schemaRef(dir, opts.root, 'job')}

# La vacante, atomizada en requisitos verificables. Se llena a mano leyendo
# job.raw.md: es el trabajo que hace que el match sirva para algo.

source:
  url: ""
  capturedAt: "${date}"
  board: ""

company:
  name: "${opts.company}"
  industry: ""

title: "${opts.role}"
type: full-time
remote: Hybrid

location:
  city: ""
  countryCode: "AR"

# kind: must = excluyente · nice = deseable
# weight: 1-10, cuánto pesa en el score
# category: hard | soft | cert | domain | experience | education | language
requirements:
  - { id: r1, text: "", kind: must, category: hard, weight: 10 }

# Las preguntas eliminatorias del formulario. Éste es el único auto-rechazo
# masivo y real del proceso: se verifican contra profile/eligibility.yaml
# ANTES de invertir una tarde adaptando el CV.
knockouts: []

skills: []
`,
  );

  await write(
    'overlay.yaml',
    `# yaml-language-server: $schema=${schemaRef(dir, opts.root, 'overlay')}

# El diff mínimo contra el arquetipo. Todo lo que no esté acá se hereda de
# targets/${opts.target}.yaml.
#
# Lo que este archivo PUEDE hacer: elegir qué ítems entran (include), cuáles no
# (exclude), en qué orden (order) y con qué variante de texto (variant).
#
# Lo que NO puede: cambiar un hecho. No hay forma de tocar desde acá un
# empleador, una fecha, un título de puesto ni un título académico. Esa
# restricción es lo que hace que el fraude sea estructuralmente difícil y no
# meramente desaconsejado.

extends: ${opts.target}
job: ./job.yaml

# basics:
#   label: "${opts.role}"
#   summary: >-
#     Resumen específico para esta vacante. Es un override explícito y queda
#     diffeable contra el perfil base con \`cv review\`.

sections: {}
#   work:
#     include: []
#     order: []
#     overrides:
#       work.<id>:
#         bullets: { include: [], order: [], variant: long }
`,
  );

  await write(
    'questions.yaml',
    `# Las respuestas EXACTAS que enviaste en el formulario.
#
# Se guardan para que lo que respondiste, lo que dice el CV y lo que digas en la
# entrevista sean la misma cosa. El linter las contrasta contra eligibility.yaml.

answers: []
#   - id: q1
#     question: "¿Tenés autorización para trabajar sin patrocinio?"
#     answer: "Sí"
#     derivedFrom: eligibility.workAuthorization
`,
  );

  await write(
    'cover-letter.yaml',
    `# Carta de presentación: 250-400 palabras, cuatro párrafos
# (gancho / logro / encaje / cierre).
#
# companyContext es OBLIGATORIO y se escribe a mano: el build falla si está
# vacío. Lo que los reclutadores detectan y descartan no es que una carta esté
# generada, es que sea genérica.

companyContext: >-
  Qué hace esta empresa, qué problema tiene y por qué te interesa. Concreto:
  algo que sólo aplique a ${opts.company}.

achievements: []
`,
  );

  await write(
    'meta.yaml',
    `# yaml-language-server: $schema=${schemaRef(dir, opts.root, 'application-meta')}

# Trazabilidad y embudo. Se guarda el SHA-256 de lo enviado, no el binario:
# alcanza para probar qué mandaste sin meter datos personales en git.

state: draft
channel: portal

timeline: []
#   - { state: sent, at: "${date}T10:00:00Z" }

rejectedStage: null
artifacts: []
`,
  );

  return { dir, files, created: true };
}

/** Lee un target ya escrito, para validar que el overlay lo referencie bien. */
export async function readTargetIds(personDir: string): Promise<string[]> {
  const dir = path.join(personDir, 'targets');
  try {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(dir);
    const ids: string[] = [];
    for (const name of names.filter((n) => n.endsWith('.yaml'))) {
      const raw = parse(await readFile(path.join(dir, name), 'utf8')) as { id?: string } | null;
      ids.push(raw?.id ?? path.basename(name, '.yaml'));
    }
    return ids;
  } catch {
    return [];
  }
}
