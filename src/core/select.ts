import type { PersonProfile } from './schema/sections.ts';
import type { Budget, Overlay, SectionName, Target } from './schema/tailoring.ts';

/**
 * Selección por overlay: qué ítems entran al CV y en qué orden.
 *
 * Tres invariantes que sostienen todo lo demás:
 *
 * 1. **Nunca hay merge de arrays.** La composición es por `id`: incluir,
 *    excluir, reordenar. Un deep merge de `work[]` mezcla la empresa de un
 *    ítem con las fechas de otro y produce un hecho que nunca ocurrió.
 * 2. **Un id ausente rompe el build.** Descubrir la omisión acá cuesta diez
 *    segundos; descubrirla en el PDF ya enviado no se puede deshacer.
 * 3. **Un overlay sólo toca narrativa.** Empleador, fechas, título del cargo e
 *    institución son inmutables desde esta capa: es lo que hace que el fraude
 *    sea estructuralmente difícil y no meramente desaconsejado.
 *
 * El orden declarado (`include` / `order`) se materializa además en `priority`,
 * de modo que las etapas posteriores —que recortan por presupuesto de páginas—
 * sacrifiquen lo último que el autor puso primero.
 */

type Selectable = { id: string; priority: number };

type IdSelection = {
  include?: string[];
  exclude?: string[];
  order?: string[];
};

const SELECTABLE_SECTIONS = [
  'work',
  'education',
  'skills',
  'projects',
  'certificates',
  'awards',
  'languages',
  'publications',
  'references',
] as const;

type SelectableSection = (typeof SELECTABLE_SECTIONS)[number];

/**
 * Qué campo narrativo admite cada sección. Se declara en tabla y no se detecta
 * con `in`: un campo opcional ausente en el YAML no existe como clave del
 * objeto, y `'summary' in entry` daría false para una entrada perfectamente
 * overrideable.
 */
const SECTION_NARRATIVE: Record<
  SelectableSection,
  { summaryField?: 'summary' | 'description'; bulletsField?: 'bullets' | 'highlights' }
> = {
  work: { summaryField: 'summary', bulletsField: 'bullets' },
  projects: { summaryField: 'description', bulletsField: 'highlights' },
  awards: { summaryField: 'summary' },
  education: {},
  skills: {},
  certificates: {},
  languages: {},
  publications: {},
  references: {},
};

/** Campos que describen un hecho verificable. Ningún overlay los toca. */
const FACT_FIELDS = new Set([
  'id',
  'company',
  'employer',
  'positions',
  'title',
  'startDate',
  'endDate',
  'date',
  'expiresAt',
  'current',
  'seniority',
  'institution',
  'area',
  'studyType',
  'score',
  'courses',
  'issuer',
  'credentialId',
  'awarder',
  'name',
  'canonical',
  'aliases',
  'category',
  'level',
  'yearsOfExperience',
  'language',
  'fluency',
  'certification',
  'author',
  'issued',
  'DOI',
  'URL',
  'url',
  'location',
  'initials',
  'role',
  'relationship',
  'outcome',
  'metric',
  'method',
  'provenance',
  'verified',
  'visibility',
  'priority',
  'tags',
  'keywords',
]);

const ALLOWED_OVERRIDE_KEYS = new Set(['summary', 'bullets']);

export function selectSections(
  profile: PersonProfile,
  overlay: Overlay | null,
  target: Target | null,
): PersonProfile {
  const next = structuredClone(profile);

  // El arquetipo aporta el título objetivo; el overlay siempre gana sobre él.
  const label = overlay?.basics?.label ?? target?.titleTarget;
  if (label) next.basics.label = label;
  if (overlay?.basics?.summary) next.basics.summary = overlay.basics.summary;

  if (!overlay) return next;

  for (const [rawName, selection] of Object.entries(overlay.sections)) {
    // `z.record()` con clave de enum exige todas las claves: una sección sin
    // ninguna directiva es ruido del parser, no una intención del autor.
    if (!selection || !declaresSelection(selection)) continue;
    const name = rawName as SectionName;

    if (!isSelectableSection(name)) {
      throw new Error(
        `[ATS-082] La sección "${name}" no admite selección por id: no es una lista de ítems del perfil. ` +
          `Secciones seleccionables: ${SELECTABLE_SECTIONS.join(', ')}. ` +
          `Para "contact" y "summary" usá el bloque "basics" del overlay.`,
      );
    }

    const where = `overlay.sections.${name}`;
    const pool = next[name] as unknown as Selectable[];
    let chosen = applySelection(pool, selection, where, name);
    chosen = applyOverrides(chosen, selection.overrides, name, where);
    (next as unknown as Record<string, unknown>)[name] = chosen;
  }

  return next;
}

/**
 * Variante de bullet pedida por entrada (`short` | `long`), extraída del overlay.
 *
 * Vive fuera de `selectSections` porque `PersonProfile` no tiene dónde guardar
 * una decisión de presentación: el consumidor la pasa a `resolveCV` en
 * `opts.bulletVariants`. Las entradas sin variante explícita no aparecen acá, y
 * `resolveCV` compone entonces `outcome` + `method`.
 */
export function bulletVariants(overlay: Overlay | null): Record<string, 'short' | 'long'> {
  const chosen: Record<string, 'short' | 'long'> = {};
  if (!overlay) return chosen;

  for (const selection of Object.values(overlay.sections)) {
    for (const [entryId, override] of Object.entries(selection?.overrides ?? {})) {
      const variant = override?.bullets?.variant;
      if (variant === 'short' || variant === 'long') chosen[entryId] = variant;
    }
  }
  return chosen;
}

/** Orden de secciones efectivo: overlay > target > perfil compuesto. */
export function resolveSectionOrder(
  overlay: Overlay | null,
  target: Target | null,
  fallback: SectionName[],
): SectionName[] {
  return overlay?.sectionOrder ?? target?.sectionOrder ?? fallback;
}

/** Presupuesto efectivo: el overlay parchea campo a campo lo que fija el target. */
export function resolveBudget(
  overlay: Overlay | null,
  target: Target | null,
  fallback: Budget,
): Budget {
  const base = target?.budget ?? fallback;
  const patch = overlay?.budget;
  if (!patch) return base;

  const merged: Budget = {
    maxPages: patch.maxPages ?? base.maxPages,
    bulletsPerRole: { ...base.bulletsPerRole, ...patch.bulletsPerRole },
  };
  const maxWords = patch.maxWords ?? base.maxWords;
  if (maxWords !== undefined) merged.maxWords = maxWords;
  return merged;
}

function isSelectableSection(name: SectionName): name is SelectableSection {
  return (SELECTABLE_SECTIONS as readonly string[]).includes(name);
}

function declaresSelection(selection: IdSelection & { overrides?: Record<string, unknown> }): boolean {
  return Boolean(
    selection.include ??
      selection.exclude ??
      selection.order ??
      (selection.overrides && Object.keys(selection.overrides).length > 0),
  );
}

function applySelection<T extends Selectable>(
  pool: T[],
  selection: IdSelection,
  where: string,
  sectionLabel: string,
): T[] {
  if (selection.include && selection.exclude) {
    throw new Error(
      `[ATS-082] ${where} declara "include" y "exclude" a la vez. Son excluyentes: ` +
        `"include" enumera lo único que entra, "exclude" quita sobre todo lo demás. Elegí uno.`,
    );
  }

  const byId = new Map(pool.map((item) => [item.id, item]));
  const known = [...byId.keys()];

  for (const field of ['include', 'exclude', 'order'] as const) {
    const ids = selection[field];
    if (!ids) continue;
    assertNoDuplicates(ids, `${where}.${field}`);
    for (const id of ids) {
      if (!byId.has(id)) throw unknownId(id, sectionLabel, `${where}.${field}`, known);
    }
  }

  let chosen: T[];
  if (selection.include) {
    chosen = selection.include.map((id) => byId.get(id)!);
  } else if (selection.exclude) {
    const dropped = new Set(selection.exclude);
    chosen = pool.filter((item) => !dropped.has(item.id));
  } else {
    chosen = [...pool];
  }

  if (selection.order) {
    const present = new Set(chosen.map((item) => item.id));
    for (const id of selection.order) {
      if (!present.has(id)) {
        throw new Error(
          `[ATS-082] El id "${id}" aparece en ${where}.order pero no forma parte de la selección ` +
            `de "${sectionLabel}". Ordenar no incluye: agregalo a "include" o quitalo de "exclude".`,
        );
      }
    }
    const rank = new Map(selection.order.map((id, index) => [id, index]));
    const tail = selection.order.length;
    // sort estable: lo no listado conserva su orden relativo detrás de lo listado.
    chosen = [...chosen].sort((a, b) => (rank.get(a.id) ?? tail) - (rank.get(b.id) ?? tail));
  }

  // El orden declarado se vuelve prioridad para que el recorte por presupuesto
  // sacrifique de atrás hacia adelante y no contradiga la intención del autor.
  if (selection.include || selection.order) {
    chosen = chosen.map((item, index) => ({ ...item, priority: Math.max(0, 100 - index) }));
  }

  return chosen;
}

function applyOverrides<T extends Selectable>(
  chosen: T[],
  overrides: Record<string, { summary?: string; bullets?: IdSelection } | undefined> | undefined,
  section: SelectableSection,
  where: string,
): T[] {
  if (!overrides) return chosen;

  const caps = SECTION_NARRATIVE[section];
  const byId = new Map(chosen.map((item) => [item.id, item]));

  for (const [entryId, override] of Object.entries(overrides)) {
    if (!override) continue;
    const target = byId.get(entryId);
    const at = `${where}.overrides["${entryId}"]`;

    if (!target) {
      throw new Error(
        `[ATS-082] ${at} apunta a un id que no está en la selección final de "${section}". ` +
          `Un override sobre algo que no se imprime es siempre un error de tipeo o una exclusión olvidada.`,
      );
    }

    for (const key of Object.keys(override)) {
      if (ALLOWED_OVERRIDE_KEYS.has(key)) continue;
      if (FACT_FIELDS.has(key)) {
        throw new Error(
          `[ATS-091] ${at} intenta cambiar "${key}", que es un hecho (empleador, fechas, título del ` +
            `cargo, institución, métrica). Los hechos son inmutables desde un overlay por diseño: ` +
            `viven una sola vez en people/<slug>/profile/ y se corrigen ahí. Un overlay sólo ` +
            `selecciona y reordena, y sólo puede reescribir ${[...ALLOWED_OVERRIDE_KEYS].join(' y ')}.`,
        );
      }
      throw new Error(
        `[ATS-082] ${at} declara la clave desconocida "${key}". ` +
          `Claves admitidas: ${[...ALLOWED_OVERRIDE_KEYS].join(', ')}.`,
      );
    }

    if (override.summary !== undefined) {
      if (!caps.summaryField) {
        throw new Error(
          `[ATS-082] La sección "${section}" no tiene campo narrativo overrideable, ` +
            `pero ${at} define "summary".`,
        );
      }
      (target as unknown as Record<string, unknown>)[caps.summaryField] = override.summary;
    }

    if (override.bullets) {
      if (!caps.bulletsField) {
        throw new Error(
          `[ATS-082] La sección "${section}" no tiene bullets, pero ${at} define "bullets".`,
        );
      }
      const field = caps.bulletsField;
      const pool = ((target as unknown as Record<string, unknown>)[field] ?? []) as Selectable[];
      (target as unknown as Record<string, unknown>)[field] = applySelection(
        pool,
        override.bullets,
        `${at}.bullets`,
        entryId,
      );
    }
  }

  return chosen;
}

function assertNoDuplicates(ids: string[], where: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`[ATS-082] El id "${id}" aparece repetido en ${where}. Listalo una sola vez.`);
    }
    seen.add(id);
  }
}

function unknownId(id: string, section: string, where: string, known: string[]): Error {
  // Los ids son jerárquicos ("work.acme-2023.b1"); referenciar el sufijo suelto
  // es el error de tipeo más habitual y merece una sugerencia concreta.
  const nested = known.filter((candidate) => candidate.endsWith(`.${id}`));
  const hint = nested.length === 1 ? ` ¿Quisiste decir "${nested[0]}"?` : '';
  const sample = known.slice(0, 20).join(', ');
  const more = known.length > 20 ? `, y ${known.length - 20} más` : '';
  const available = known.length ? `Ids disponibles: ${sample}${more}.` : 'La sección está vacía.';
  return new Error(
    `[ATS-082] El id "${id}", referenciado en ${where}, no existe en "${section}".${hint} ${available}`,
  );
}
