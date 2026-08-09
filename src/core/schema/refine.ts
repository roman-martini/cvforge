import type { PersonProfile } from './sections.ts';

/**
 * Validaciones que Zod no puede expresar campo a campo porque cruzan ítems o
 * requieren aritmética de calendario.
 *
 * La más importante es la de calendario real: el pattern ISO-8601 que usan
 * JSON Resume y la mayoría de los validadores acepta `2024-02-31` y
 * `2020-19-39`. Un CV con una fecha imposible se renderiza sin quejarse y
 * el reclutador lo lee como un descuido.
 */

export type Issue = {
  path: string;
  message: string;
  severity: 'error' | 'warning';
  rule: string;
};

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Verdadero si la fecha existe en el calendario, no sólo si matchea el patrón. */
export function isRealDate(value: string): boolean {
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12) return false;
  if (parts.length === 2) return true;

  const day = Number(parts[2]);
  if (!Number.isInteger(day) || day < 1) return false;
  const max = month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1]!;
  return day <= max;
}

/** Compara fechas de precisión mixta (`2023-04` vs `2023-04-17`) de forma estable. */
export function compareFlexDates(a: string, b: string): number {
  const norm = (d: string) => (d.length === 7 ? `${d}-01` : d);
  return norm(a).localeCompare(norm(b));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Recorre el perfil recolectando `id` junto al path donde apareció. */
function collectIds(profile: PersonProfile): Array<{ id: string; path: string }> {
  const found: Array<{ id: string; path: string }> = [];
  const push = (id: string, path: string) => found.push({ id, path });

  profile.work.forEach((w, i) => {
    push(w.id, `work[${i}]`);
    w.positions.forEach((p, j) => push(p.id, `work[${i}].positions[${j}]`));
    w.bullets.forEach((b, j) => push(b.id, `work[${i}].bullets[${j}]`));
  });
  profile.projects.forEach((p, i) => {
    push(p.id, `projects[${i}]`);
    p.highlights.forEach((h, j) => push(h.id, `projects[${i}].highlights[${j}]`));
  });
  for (const key of [
    'education',
    'skills',
    'certificates',
    'awards',
    'languages',
    'publications',
    'references',
  ] as const) {
    const list = profile[key] as Array<{ id: string }>;
    list.forEach((item, i) => push(item.id, `${key}[${i}]`));
  }
  profile.basics.profiles.forEach((p, i) => push(p.id, `basics.profiles[${i}]`));

  return found;
}

/**
 * ATS-080/081: unicidad global de `id` y coherencia temporal.
 *
 * La unicidad es global y no por sección porque los overlays referencian ids
 * sin decir de qué sección son; dos ids iguales harían que la selección sea
 * ambigua y dependiente del orden de carga.
 */
export function refineProfile(profile: PersonProfile): Issue[] {
  const issues: Issue[] = [];
  const today = todayIso();

  // ── ids únicos en todo el documento ────────────────────────────────────
  const seen = new Map<string, string>();
  for (const { id, path } of collectIds(profile)) {
    const previous = seen.get(id);
    if (previous) {
      issues.push({
        path,
        rule: 'ATS-080',
        severity: 'error',
        message: `El id "${id}" ya se usó en ${previous}. Los ids deben ser únicos en todo el perfil: los overlays los referencian sin indicar la sección.`,
      });
    } else {
      seen.set(id, path);
    }
  }

  // ── fechas: calendario real, orden y futuro ────────────────────────────
  const checkDate = (value: string | undefined, path: string): boolean => {
    if (!value) return true;
    if (!isRealDate(value)) {
      issues.push({
        path,
        rule: 'ATS-081',
        severity: 'error',
        message: `"${value}" no existe en el calendario. El patrón ISO-8601 la acepta, pero la fecha es imposible.`,
      });
      return false;
    }
    if (compareFlexDates(value, today) > 0) {
      issues.push({
        path,
        rule: 'ATS-081',
        severity: 'error',
        message: `"${value}" está en el futuro.`,
      });
      return false;
    }
    return true;
  };

  const checkRange = (
    start: string | undefined,
    end: string | undefined,
    current: boolean,
    path: string,
  ) => {
    const okStart = checkDate(start, `${path}.startDate`);
    const okEnd = checkDate(end, `${path}.endDate`);
    if (current && end) {
      issues.push({
        path: `${path}.endDate`,
        rule: 'ATS-081',
        severity: 'error',
        message: 'No puede haber endDate con current: true. Elegí uno de los dos.',
      });
    }
    if (okStart && okEnd && start && end && compareFlexDates(start, end) > 0) {
      issues.push({
        path,
        rule: 'ATS-081',
        severity: 'error',
        message: `startDate (${start}) es posterior a endDate (${end}).`,
      });
    }
    if (!current && !end) {
      issues.push({
        path,
        rule: 'ATS-081',
        severity: 'warning',
        message: 'Sin endDate ni current: true no se sabe si el puesto sigue vigente.',
      });
    }
  };

  profile.work.forEach((w, i) => {
    w.positions.forEach((p, j) => {
      checkRange(p.startDate, p.endDate, p.current, `work[${i}].positions[${j}]`);
    });
    const currents = w.positions.filter((p) => p.current).length;
    if (currents > 1) {
      issues.push({
        path: `work[${i}].positions`,
        rule: 'ATS-081',
        severity: 'error',
        message: `${currents} posiciones marcadas como current en la misma empresa. Sólo una puede estar vigente.`,
      });
    }
  });

  profile.education.forEach((e, i) => {
    checkRange(e.startDate, e.endDate, e.current, `education[${i}]`);
  });
  profile.projects.forEach((p, i) => {
    if (p.startDate && p.endDate && compareFlexDates(p.startDate, p.endDate) > 0) {
      issues.push({
        path: `projects[${i}]`,
        rule: 'ATS-081',
        severity: 'error',
        message: `startDate (${p.startDate}) es posterior a endDate (${p.endDate}).`,
      });
    }
  });
  profile.certificates.forEach((c, i) => {
    checkDate(c.date, `certificates[${i}].date`);
  });

  return issues;
}
