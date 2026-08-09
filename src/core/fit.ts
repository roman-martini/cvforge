import type { ViewModel, Renderer, RenderResult, VMSection } from './types.ts';
import type { FitPolicy } from './schema/config.ts';

/**
 * Ajuste del CV al presupuesto de páginas.
 *
 * La razón de existir de este módulo: un presupuesto de páginas sin política de
 * ajuste es un assert que bloquea al usuario y lo empuja a editar el CV a mano
 * —bajar la tipografía, borrar un bullet— reintroduciendo exactamente el
 * acoplamiento entre datos y presentación que el workspace existe para evitar.
 *
 * El orden de sacrificio es deliberado y va de lo menos a lo más destructivo:
 *
 *   1. Densidad tipográfica: no se pierde información, sólo aire.
 *   2. Bullets por rol: se pierde detalle, se conservan todos los empleos.
 *   3. Corte de antigüedad: los roles viejos colapsan en una línea.
 *   4. Secciones enteras: lo último, y sólo las que el perfil declara sacrificables.
 *
 * Si tras todo eso no entra, falla diciendo qué recortar. Fallar con un
 * diagnóstico es útil; recortar en silencio hasta que entre, no: el autor
 * mandaría un CV al que le falta algo sin enterarse.
 */

export type FitOptions = {
  maxPages: number;
  fit: FitPolicy;
  themeDir?: string;
  channel?: 'preview' | 'release';
};

export type FitOutcome = RenderResult & {
  /** Qué ajustes hicieron falta, para poder avisarle al autor. */
  adjustments: string[];
  /**
   * El ViewModel que efectivamente se imprimió.
   *
   * Devolverlo no es una comodidad: es la condición para que los formatos sean
   * hermanos de verdad. Si el TXT se generara del ViewModel original mientras
   * el PDF salió de uno recortado, el TXT tendría contenido que el PDF no, y
   * la comparación de recall entre ambos —que es el corazón de la verificación
   * ATS— fallaría por una diferencia que nadie introdujo a propósito.
   */
  viewModel: ViewModel;
};

const DENSITY_ORDER = ['comfortable', 'normal', 'dense', 'ultra'] as const;
type Density = (typeof DENSITY_ORDER)[number];

/** Recorta los bullets de cada entrada según su antigüedad relativa. */
function trimBullets(vm: ViewModel, limits: { recent: number; mid: number; old: number }): ViewModel {
  const sections = vm.sections.map((section): VMSection => {
    if (section.kind !== 'entries' || section.name !== 'work') return section;
    const entries = section.entries.map((entry, index) => {
      const limit = index === 0 ? limits.recent : index < 3 ? limits.mid : limits.old;
      return entry.bullets.length <= limit ? entry : { ...entry, bullets: entry.bullets.slice(0, limit) };
    });
    return { ...section, entries };
  });
  return { ...vm, sections };
}

/**
 * Colapsa los roles anteriores al corte en una única línea de resumen.
 * Se conserva el hecho (empresa, cargo, fechas) y se sueltan los detalles:
 * borrar el empleo entero abriría un hueco temporal que un reclutador lee como
 * una señal de alarma.
 */
function collapseOldRoles(vm: ViewModel, cutoffYears: number): { vm: ViewModel; collapsed: number } {
  const cutoffYear = new Date().getFullYear() - cutoffYears;
  let collapsed = 0;

  const sections = vm.sections.map((section): VMSection => {
    if (section.kind !== 'entries' || section.name !== 'work') return section;
    const entries = section.entries.map((entry) => {
      const years = entry.dateRange.match(/\d{4}/g) ?? [];
      const last = years.length > 0 ? Number(years[years.length - 1]) : cutoffYear + 1;
      if (last >= cutoffYear || entry.bullets.length === 0) return entry;
      collapsed += 1;
      return { ...entry, bullets: [], summary: undefined };
    });
    return { ...section, entries };
  });

  return { vm: { ...vm, sections }, collapsed };
}

function dropSection(vm: ViewModel, name: string): { vm: ViewModel; dropped: boolean } {
  const sections = vm.sections.filter((s) => s.name !== name);
  return { vm: { ...vm, sections }, dropped: sections.length !== vm.sections.length };
}

/** Estimación de cuánto sobra, para que el mensaje de error sea accionable. */
function estimateOverflow(vm: ViewModel, pages: number, maxPages: number): string {
  const excessPages = pages - maxPages;
  const totalBullets = vm.sections
    .filter((s) => s.kind === 'entries')
    .reduce((sum, s) => sum + s.entries.reduce((n, e) => n + e.bullets.length, 0), 0);
  const biggest = [...vm.sections]
    .filter((s) => s.kind === 'entries')
    .sort(
      (a, b) =>
        b.entries.reduce((n, e) => n + e.bullets.length, 0) -
        a.entries.reduce((n, e) => n + e.bullets.length, 0),
    )[0];
  const approxLines = excessPages * 45;
  const target = biggest ? `"${biggest.heading}"` : 'alguna sección';
  return `sobran unas ${approxLines} líneas (${excessPages} página(s)). La sección más cargada es ${target}, con ${totalBullets} bullets en total.`;
}

/**
 * Renderiza probando escalones de densidad y, si hace falta, aplicando la
 * política de recorte declarada por el perfil.
 */
export async function fitToBudget(
  vm: ViewModel,
  renderer: Renderer,
  opts: FitOptions,
): Promise<FitOutcome> {
  const adjustments: string[] = [];
  const steps = (opts.fit.densitySteps ?? DENSITY_ORDER) as readonly Density[];

  const attempt = async (candidate: ViewModel, density: Density): Promise<RenderResult> =>
    renderer.render(
      { ...candidate, density },
      { density, themeDir: opts.themeDir, channel: opts.channel },
    );

  let last: RenderResult | undefined;

  /**
   * Prueba la escalera de densidad completa sobre un candidato y se queda con
   * el primer escalón que entra.
   *
   * Se vuelve a recorrer desde el más holgado después de CADA recorte
   * estructural, y no se sigue apretando desde donde había quedado. La razón:
   * un CV al que ya se le sacaron dos bullets probablemente entre con
   * tipografía normal, y devolverlo en "ultra" sería entregar un documento
   * apretado sin necesidad. Entre dos versiones que caben en el presupuesto,
   * siempre gana la más legible.
   */
  const tryDensities = async (
    candidate: ViewModel,
  ): Promise<{ result: RenderResult; density: Density } | undefined> => {
    for (const density of steps) {
      const result = await attempt(candidate, density);
      last = result;
      if ((result.pages ?? 1) <= opts.maxPages) return { result, density };
    }
    return undefined;
  };

  const succeed = (
    found: { result: RenderResult; density: Density },
    candidate: ViewModel,
  ): FitOutcome => {
    if (found.density !== steps[0]) adjustments.push(`densidad tipográfica "${found.density}"`);
    return {
      ...found.result,
      adjustments,
      viewModel: { ...candidate, density: found.density },
    };
  };

  // ── 1. Sólo densidad: no se pierde información ──────────────────────────
  const first = await tryDensities(vm);
  if (first) return succeed(first, vm);

  let candidate = vm;

  // ── 2. Menos bullets por rol ────────────────────────────────────────────
  if (opts.fit.maxBulletsPerRole) {
    candidate = trimBullets(candidate, opts.fit.maxBulletsPerRole);
    adjustments.push(
      `bullets recortados a ${opts.fit.maxBulletsPerRole.recent}/${opts.fit.maxBulletsPerRole.mid}/${opts.fit.maxBulletsPerRole.old} por rol`,
    );
    const found = await tryDensities(candidate);
    if (found) return succeed(found, candidate);
  }

  // ── 3. Roles antiguos sin detalle ───────────────────────────────────────
  if (opts.fit.experienceCutoffYears !== undefined) {
    const { vm: collapsedVm, collapsed } = collapseOldRoles(candidate, opts.fit.experienceCutoffYears);
    if (collapsed > 0) {
      candidate = collapsedVm;
      adjustments.push(
        `${collapsed} rol(es) anterior(es) a ${opts.fit.experienceCutoffYears} años quedaron sin bullets`,
      );
      const found = await tryDensities(candidate);
      if (found) return succeed(found, candidate);
    }
  }

  // ── 4. Secciones enteras, sólo las declaradas sacrificables ─────────────
  for (const name of opts.fit.dropSections ?? []) {
    const { vm: reduced, dropped } = dropSection(candidate, name);
    if (!dropped) continue;
    candidate = reduced;
    adjustments.push(`sección "${name}" descartada`);
    const found = await tryDensities(candidate);
    if (found) return succeed(found, candidate);
  }

  const pages = last?.pages ?? 0;
  if (opts.fit.failIfStillOverflows !== false) {
    throw new Error(
      `El CV ocupa ${pages} páginas y el presupuesto es ${opts.maxPages}. ` +
        `Ya se aplicó todo el ajuste automático disponible (${adjustments.join('; ') || 'ninguno'}). ` +
        `Para que entre, ${estimateOverflow(candidate, pages, opts.maxPages)}`,
    );
  }

  adjustments.push(`no entró en ${opts.maxPages} página(s): quedó en ${pages}`);
  return {
    ...(last as RenderResult),
    adjustments,
    viewModel: { ...candidate, density: steps[steps.length - 1] ?? 'ultra' },
  };
}

export { fitToBudget as fit };
