import type { LintFinding, LintReport, ResolvedCV } from '../core/types.ts';
import type { Eligibility, PersonProfile } from '../core/schema/sections.ts';
import type { CoverLetter, Questions } from '../core/schema/tailoring.ts';

/**
 * Honestidad como control de proceso (ATS-090..093).
 *
 * Más del 75 % de los empleadores detecta al menos una discrepancia en el
 * screening y, entre los detectados, el 54,9 % pierde la oferta o el puesto. El
 * modo de falla más probable de un generador automático no es mentir: es el
 * drift semántico al refrasear —"colaboré en" convertido en "lideré"— y es
 * exactamente lo que se cae en la entrevista.
 *
 * Por eso estas reglas no son una nota en el README: son parte del build.
 */

const PLACEHOLDER_PATTERNS = [
  /\b(todo|tbd|tba|pendiente|completar|rellenar)\b/i,
  /\blorem ipsum\b/i,
  /\bx{3,}\b/i,
  /\[[^\]]*\]/,
  /\{\{[^}]*\}\}/,
  /<[a-z_]+>/i,
  /\bnombre de la empresa\b/i,
  /\bcompany name\b/i,
];

const AFFIRMATIVE = /^(s[ií]|si|yes|y|true|afirmativo|correcto)\b/i;
const NEGATIVE = /^(no|n|false|negativo|incorrecto)\b/i;

function answerToBoolean(answer: string): boolean | undefined {
  const value = answer.trim();
  if (AFFIRMATIVE.test(value)) return true;
  if (NEGATIVE.test(value)) return false;
  return undefined;
}

function digitsIn(text: string): number[] {
  return [...text.matchAll(/\d[\d.,]*/g)]
    .map((match) => Number.parseFloat(match[0].replace(/\.(?=\d{3}\b)/g, '').replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
}

/* ========================================================================== *
 * ATS-091 — hechos comparables entre variantes
 * ========================================================================== */

type FactMap = Map<string, string>;

/**
 * Reduce un CV resuelto a su capa de hechos: empleadores, cargos, fechas y
 * educación. Es lo que ninguna variante puede cambiar.
 */
export function factsOf(cv: ResolvedCV): FactMap {
  const facts: FactMap = new Map();
  for (const entry of cv.work) {
    facts.set(`work:${entry.id}:company`, entry.company);
    for (const position of entry.positions) {
      facts.set(
        `work:${entry.id}:${position.id}`,
        `${position.title} | ${position.startDate} → ${position.current ? 'actual' : position.endDate ?? '—'}`,
      );
    }
  }
  for (const entry of cv.education) {
    facts.set(
      `education:${entry.id}`,
      `${entry.institution} | ${entry.studyType} ${entry.area} | ${entry.startDate ?? '—'} → ${entry.current ? 'actual' : entry.endDate ?? '—'}`,
    );
  }
  for (const entry of cv.certificates) {
    facts.set(`certificate:${entry.id}`, `${entry.name} | ${entry.issuer} | ${entry.date}`);
  }
  return facts;
}

export type VariantSnapshot = { label: string; cv: ResolvedCV };

/* ========================================================================== *
 * ATS-092 — respuestas vs elegibilidad
 * ========================================================================== */

type QuestionRule = {
  id: string;
  matches: RegExp;
  /** Devuelve el valor esperado, o undefined si el bloque no alcanza para decidir. */
  expected: (eligibility: Eligibility, question: string) => boolean | undefined;
  explain: (eligibility: Eligibility) => string;
};

function countryIn(question: string): string | undefined {
  const named: Array<[RegExp, string]> = [
    [/\b(united states|u\.?s\.?a?|estados unidos)\b/i, 'US'],
    [/\b(united kingdom|u\.?k\.?|reino unido)\b/i, 'GB'],
    [/\b(canada|canadá)\b/i, 'CA'],
    [/\b(germany|deutschland|alemania)\b/i, 'DE'],
    [/\b(spain|españa|espana)\b/i, 'ES'],
    [/\b(france|francia)\b/i, 'FR'],
    [/\b(netherlands|holanda|países bajos)\b/i, 'NL'],
    [/\b(argentina)\b/i, 'AR'],
    [/\b(australia)\b/i, 'AU'],
    [/\b(poland|polonia)\b/i, 'PL'],
  ];
  for (const [pattern, code] of named) if (pattern.test(question)) return code;
  const explicit = /\b([A-Z]{2})\b/.exec(question);
  return explicit?.[1];
}

const QUESTION_RULES: QuestionRule[] = [
  {
    id: 'work-authorization',
    matches: /\b(work authoriz|authorised to work|authorized to work|legally (?:able|entitled) to work|right to work|eligible to work|autorizaci[óo]n para trabajar|permiso de trabajo)\b/i,
    expected: (eligibility, question) => {
      const code = countryIn(question);
      if (!code) return undefined;
      const entry = eligibility.workAuthorization.find((item) => item.countryCode === code);
      if (!entry) return undefined;
      return entry.status !== 'none';
    },
    explain: (eligibility) =>
      eligibility.workAuthorization.map((item) => `${item.countryCode}: ${item.status}`).join(', '),
  },
  {
    id: 'sponsorship',
    matches: /\b(sponsor|sponsorship|patrocinio|visado|visa support)\b/i,
    expected: (eligibility, question) => {
      const code = countryIn(question);
      const entry = code
        ? eligibility.workAuthorization.find((item) => item.countryCode === code)
        : undefined;
      if (!entry) return undefined;
      return entry.sponsorshipRequired;
    },
    explain: (eligibility) =>
      eligibility.workAuthorization
        .map((item) => `${item.countryCode}: sponsorshipRequired=${item.sponsorshipRequired}`)
        .join(', '),
  },
  {
    id: 'relocation',
    matches: /\b(relocat|willing to move|mudarte|traslad|reubicaci[óo]n)\b/i,
    expected: (eligibility) => eligibility.relocation?.willing,
    explain: (eligibility) => `relocation.willing = ${String(eligibility.relocation?.willing)}`,
  },
  {
    id: 'onsite',
    matches: /\b(onsite|on-site|presencial|work from the office|en la oficina)\b/i,
    expected: (eligibility) => (eligibility.workModes.length === 0 ? undefined : eligibility.workModes.includes('onsite')),
    explain: (eligibility) => `workModes = ${eligibility.workModes.join(', ') || '(vacío)'}`,
  },
  {
    id: 'remote',
    matches: /\b(remote|remoto|teletrabajo)\b/i,
    expected: (eligibility) => (eligibility.workModes.length === 0 ? undefined : eligibility.workModes.includes('remote')),
    explain: (eligibility) => `workModes = ${eligibility.workModes.join(', ') || '(vacío)'}`,
  },
];

/* ========================================================================== *
 * Entrada pública
 * ========================================================================== */

export type EthicsLintInput = {
  profile?: PersonProfile;
  resolved?: ResolvedCV;
  /** Todas las variantes vivas de la misma persona, para el diff de hechos. */
  variants?: VariantSnapshot[];
  eligibility?: Eligibility;
  questions?: Questions;
  coverLetter?: CoverLetter;
  /** Empresa objetivo: el companyContext tiene que hablar de ella. */
  companyName?: string;
};

export function lintEthics(input: EthicsLintInput): LintReport {
  const findings: LintFinding[] = [];
  const { profile, resolved, variants = [], eligibility, questions, coverLetter, companyName } = input;

  /* ── ATS-090 — ninguna variante llm_draft en el CV final ──────────────── */
  if (resolved) {
    for (const entry of resolved.work) {
      for (const bullet of entry.bullets) {
        if (bullet.provenanceSource === 'llm_draft') {
          findings.push({
            rule: 'ATS-090',
            severity: 'error',
            message: `El bullet "${bullet.id}" está seleccionado con provenance llm_draft sin aprobar: "${bullet.text.slice(0, 80)}…"`,
            where: `work:${entry.id} → ${bullet.id}`,
            fix: 'Revisalo con `cv review` (diff palabra por palabra contra el original, resaltando los cambios de verbo) y marcá provenance.source: llm_approved con approvedBy y approvedAt.',
          });
        }
      }
    }
    for (const project of resolved.projects) {
      for (const highlight of project.highlights) {
        if (highlight.provenanceSource === 'llm_draft') {
          findings.push({
            rule: 'ATS-090',
            severity: 'error',
            message: `El highlight "${highlight.id}" del proyecto "${project.id}" tiene provenance llm_draft sin aprobar.`,
            where: `projects:${project.id} → ${highlight.id}`,
            fix: 'Aprobalo explícitamente o excluilo del overlay.',
          });
        }
      }
    }
  }

  if (profile) {
    for (const entry of profile.work) {
      for (const bullet of entry.bullets) {
        const provenance = bullet.provenance;
        if (provenance.source === 'llm_approved' && (!provenance.approvedBy || !provenance.approvedAt)) {
          findings.push({
            rule: 'ATS-090',
            severity: 'error',
            message: `El bullet "${bullet.id}" dice llm_approved pero no registra quién ni cuándo lo aprobó.`,
            where: `work:${entry.id} → ${bullet.id}`,
            fix: 'Una aprobación sin firma ni fecha no es una aprobación: completá approvedBy y approvedAt.',
          });
        }
      }
    }
  }

  /* ── ATS-091 — los hechos son idénticos entre variantes ───────────────── */
  if (variants.length > 1) {
    const [reference, ...rest] = variants;
    if (reference) {
      const referenceFacts = factsOf(reference.cv);
      for (const variant of rest) {
        const variantFacts = factsOf(variant.cv);
        for (const [key, value] of variantFacts) {
          const expected = referenceFacts.get(key);
          if (expected !== undefined && expected !== value) {
            findings.push({
              rule: 'ATS-091',
              severity: 'error',
              message: `El hecho "${key}" difiere entre variantes: "${reference.label}" dice «${expected}» y "${variant.label}" dice «${value}».`,
              where: `variantes: ${reference.label} vs ${variant.label}`,
              fix: 'La capa de hechos (empleadores, fechas, títulos, educación) es inmutable: ningún overlay puede tocarla. Si el hecho cambió, cambialo en profile/ para todas las variantes.',
            });
          }
        }
      }
    }
  }

  /* ── ATS-092 — respuestas consistentes con eligibility ────────────────── */
  if (questions && eligibility) {
    for (const answer of questions.answers) {
      const rule = QUESTION_RULES.find((candidate) => candidate.matches.test(answer.question));
      if (!rule) continue;
      const expected = rule.expected(eligibility, answer.question);
      if (expected === undefined) continue;
      const given = answerToBoolean(answer.answer);
      if (given === undefined) continue;
      if (given !== expected) {
        findings.push({
          rule: 'ATS-092',
          severity: 'error',
          message: `A "${answer.question}" respondiste "${answer.answer}" y eligibility.yaml dice lo contrario (${rule.explain(eligibility)}).`,
          where: `questions:${answer.id}`,
          fix: 'Las knockout questions del formulario son el único auto-rechazo masivo y real del proceso. Y una inconsistencia entre formulario, CV y entrevista es la discrepancia más fácil de detectar de todas.',
        });
      }
    }

    if (eligibility.compensation) {
      const range = eligibility.compensation;
      for (const answer of questions.answers) {
        if (!/\b(salary|compensation|expectation|pretensi[óo]n|remuneraci[óo]n|sueldo)\b/i.test(answer.question)) continue;
        const numbers = digitsIn(answer.answer).filter((value) => value >= 1000);
        if (numbers.length === 0) continue;
        const outside = numbers.filter(
          (value) => (range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max),
        );
        if (outside.length > 0) {
          findings.push({
            rule: 'ATS-092',
            severity: 'warning',
            message: `La pretensión declarada (${outside.join(', ')}) queda fuera del rango de eligibility.yaml (${range.min ?? '—'}-${range.max ?? '—'} ${range.currency}).`,
            where: `questions:${answer.id}`,
            fix: 'Actualizá el rango en eligibility.yaml o corregí la respuesta: el número que enviaste queda registrado.',
          });
        }
      }
    }
  }

  /* ── ATS-093 — companyContext escrito a mano ──────────────────────────── */
  if (coverLetter) {
    const context = coverLetter.companyContext ?? '';
    if (context.trim().length < 20) {
      findings.push({
        rule: 'ATS-093',
        severity: 'error',
        message: 'cover-letter.companyContext está vacío o es demasiado corto.',
        where: 'cover-letter.yaml → companyContext',
        fix: 'Es obligatorio y se escribe a mano. El 68 % de las cartas que reciben los reclutadores son obviamente genéricas y el 47 % las rechaza de plano: lo que detectan no es que sea generada, es que sea genérica.',
      });
    } else {
      for (const placeholder of PLACEHOLDER_PATTERNS) {
        if (placeholder.test(context)) {
          findings.push({
            rule: 'ATS-093',
            severity: 'error',
            message: `cover-letter.companyContext todavía tiene un placeholder: "${context.slice(0, 120)}"`,
            where: 'cover-letter.yaml → companyContext',
            fix: 'Escribí una observación concreta y verificable sobre esta empresa en particular.',
          });
          break;
        }
      }
      if (companyName && !context.toLowerCase().includes(companyName.toLowerCase().split(/\s+/)[0] ?? '')) {
        findings.push({
          rule: 'ATS-093',
          severity: 'warning',
          message: `companyContext no menciona a "${companyName}". Si el párrafo sirve para cualquier empresa, no es contexto.`,
          where: 'cover-letter.yaml → companyContext',
          fix: 'Nombrá el producto, el mercado o la decisión concreta de la empresa que te llevó a postularte.',
        });
      }
    }
  }

  return { format: 'data', findings, passed: findings.every((f) => f.severity !== 'error') };
}
