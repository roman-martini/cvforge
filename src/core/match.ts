import type { PersonProfile, Eligibility } from './schema/sections.ts';
import type { Job, Requirement, SectionName } from './schema/tailoring.ts';
import type { SkillTaxonomy } from './schema/config.ts';

/**
 * Puntuación del perfil contra una vacante.
 *
 * Qué es y qué no es: esto NO calcula "la probabilidad de pasar el ATS". Los
 * ATS mayoritarios no puntúan ni descartan CVs por contenido; el único
 * auto-rechazo masivo y real son las preguntas eliminatorias del formulario,
 * que acá se verifican aparte contra `eligibility`.
 *
 * Lo que sí hace, y es lo útil: medir COBERTURA DE REQUISITOS y
 * ENCONTRABILIDAD en la búsqueda booleana que el reclutador escribe a mano.
 * De ahí que la salida sea un reporte de brechas accionable y no un número.
 *
 * El scorer es léxico (BM25 sobre términos normalizados, con resolución de
 * alias por taxonomía) por una decisión deliberada: es determinista, corre sin
 * red, sin descargas y sin GPU, y produce el mismo resultado en dos máquinas
 * distintas — condición para que sirva en tests y en CI.
 */

export type MatchEvidence = { id: string; score: number; where: 'bullet' | 'skill' | 'summary' | 'project' };

export type MatchRequirementResult = {
  id: string;
  text: string;
  kind: 'must' | 'nice';
  weight: number;
  evidence: MatchEvidence[];
  hint?: string;
};

export type MatchResult = {
  score: number;
  covered: MatchRequirementResult[];
  missing: MatchRequirementResult[];
  /**
   * Lo más valioso del reporte: tenés esto en el perfil, la vacante lo pide, y
   * tu selección actual lo deja afuera. Ninguna herramienta comercial lo dice
   * porque ninguna conoce el pool completo del que se seleccionó.
   */
  excludedButRelevant: Array<{ id: string; reason: string; requirements: string[]; score: number }>;
  knockouts: Array<{ id: string; question: string; expects: string; answer?: string; ok: boolean; note?: string }>;
  ranked: Array<{ id: string; score: number; section: SectionName }>;
  scores: Record<string, number>;
};

export type MatchInput = {
  profile: PersonProfile;
  job: Job;
  taxonomy?: SkillTaxonomy;
  locale?: string;
  eligibility?: Eligibility;
  /** Ids que la selección actual incluye; habilita "excluidos pero relevantes". */
  includedIds?: string[];
};

/* ========================================================================== *
 * Normalización
 * ========================================================================== */

/** Palabras sin valor discriminante; se descartan antes de puntuar. */
const STOPWORDS = new Set([
  'de','la','el','en','y','a','los','las','del','con','por','para','un','una','que','se','su','al','lo','como','más','o','este','esta','sobre','entre','ser','tener',
  'the','of','and','to','in','a','for','with','on','at','by','an','is','are','as','be','or','from','that','this','it','we','you','your','our','will','have','has',
]);

/**
 * Normaliza para comparar. Descompone los acentos y los borra (NFD + rango
 * combinante) para que "gestión" y "gestion" sean el mismo término, y conserva
 * `+`, `#` y `.` porque distinguen tecnologías reales: C++, C#, .NET, Node.js.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[\s/,-]+/)
    .map((t) => t.replace(/^[.]+|[.]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/* ========================================================================== *
 * Taxonomía: una habilidad, muchas formas de nombrarla
 * ========================================================================== */

type AliasIndex = Map<string, string>;

/**
 * Índice alias → canónico. Resuelve el caso que muchos ATS no resuelven solos:
 * "PMP" y "Project Management Professional", o "K8s" y "Kubernetes", son el
 * mismo requisito y tienen que puntuar igual.
 */
export function buildAliasIndex(taxonomy: SkillTaxonomy | undefined): AliasIndex {
  const index: AliasIndex = new Map();
  for (const skill of taxonomy?.skills ?? []) {
    const canonical = normalize(skill.canonical);
    index.set(canonical, canonical);
    for (const alias of skill.aliases) index.set(normalize(alias), canonical);
    if (skill.expanded) index.set(normalize(skill.expanded), canonical);
  }
  return index;
}

/** Aplica el índice sobre una lista de términos, colapsando sinónimos. */
function canonicalizeAll(terms: string[], index: AliasIndex): string[] {
  return terms.map((term) => index.get(term) ?? term);
}

/* ========================================================================== *
 * BM25
 * ========================================================================== */

type Doc = { id: string; section: SectionName; terms: string[]; raw: string; where: MatchEvidence['where'] };

const K1 = 1.5;
const B = 0.75;

function buildDocs(profile: PersonProfile, index: AliasIndex): Doc[] {
  const docs: Doc[] = [];
  const add = (id: string, section: SectionName, raw: string, where: MatchEvidence['where'], extra: string[] = []) => {
    const terms = canonicalizeAll([...tokenize(raw), ...extra.flatMap((e) => tokenize(e))], index);
    if (terms.length > 0) docs.push({ id, section, terms, raw, where });
  };

  add('basics.summary', 'summary', profile.basics.summary, 'summary', [profile.basics.label]);

  for (const entry of profile.work) {
    const context = [entry.company.name, entry.company.industry ?? '', ...entry.tags];
    for (const bullet of entry.bullets) {
      add(bullet.id, 'work', `${bullet.outcome} ${bullet.method ?? ''}`, 'bullet', [...bullet.tags, ...context]);
    }
    if (entry.summary) add(entry.id, 'work', entry.summary, 'bullet', context);
  }

  for (const skill of profile.skills) {
    add(skill.id, 'skills', skill.canonical, 'skill', [...skill.aliases, ...skill.keywords, skill.category]);
  }

  for (const project of profile.projects) {
    add(project.id, 'projects', `${project.name} ${project.description ?? ''}`, 'project', [
      ...project.keywords,
      ...project.tags,
    ]);
    for (const highlight of project.highlights) {
      add(highlight.id, 'projects', `${highlight.outcome} ${highlight.method ?? ''}`, 'project', highlight.tags);
    }
  }

  for (const cert of profile.certificates) {
    add(cert.id, 'certificates', `${cert.name} ${cert.issuer}`, 'skill', cert.tags);
  }

  // Los idiomas entran como documentos propios porque las vacantes los piden
  // como requisito explícito ("professional written English") y sin esto un
  // perfil que declara inglés C1 aparecía como si no lo tuviera.
  for (const language of profile.languages) {
    add(language.id, 'languages', language.language, 'skill', [
      language.fluency,
      language.certification ?? '',
    ]);
  }

  return docs;
}

/**
 * Peso por ubicación del término. Una tecnología demostrada dentro de un logro
 * vale más que la misma palabra listada en un bloque de skills, que es lo que
 * cualquiera puede escribir sin haberla usado nunca.
 */
const WHERE_WEIGHT: Record<MatchEvidence['where'], number> = {
  bullet: 1.0,
  project: 0.9,
  skill: 0.7,
  summary: 0.6,
};

/**
 * Vocabulario de aviso de empleo: palabras que aparecen en cualquier vacante y
 * en cualquier CV del rubro, así que compartirlas no es evidencia de nada.
 *
 * Se filtran por lista y NO por frecuencia en el perfil, que fue el primer
 * intento y estaba mal: en el perfil de un especialista su tecnología central
 * aparece en casi todos los bullets, y una regla por frecuencia la habría
 * declarado "poco distintiva" justo cuando es la palabra que más importa.
 * Genérico es una propiedad del término, no de cuántas veces lo escribiste.
 */
const GENERIC_TERMS = new Set([
  'services', 'service', 'experience', 'experiencia', 'production', 'produccion',
  'engineering', 'engineer', 'ingenieria', 'team', 'teams', 'equipo', 'equipos',
  'work', 'working', 'trabajo', 'role', 'rol', 'strong', 'solid', 'solida',
  'years', 'anos', 'ability', 'capacidad', 'knowledge', 'conocimiento',
  'skills', 'habilidades', 'using', 'usando', 'building', 'construyendo',
  'designing', 'disenando', 'operating', 'operando', 'track', 'record',
  'background', 'professional', 'profesional', 'excellent', 'good', 'plus',
  'environment', 'entorno', 'systems', 'sistemas', 'software', 'platform',
  'plataforma', 'development', 'desarrollo', 'management', 'gestion',
]);

function scoreRequirement(requirement: Requirement, docs: Doc[], index: AliasIndex): MatchEvidence[] {
  const queryTerms = canonicalizeAll(tokenize(requirement.text), index);
  if (queryTerms.length === 0) return [];

  const totalDocs = docs.length || 1;
  const avgLength = docs.reduce((sum, d) => sum + d.terms.length, 0) / totalDocs || 1;

  const df = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    df.set(term, docs.filter((d) => d.terms.includes(term)).length);
  }

  // Sin esto, "Designing and operating gRPC services" cuenta como cubierto por
  // "Amazon Web Services" porque comparten la palabra "services", y el reporte
  // deja de ser creíble justo donde más importa.
  const specific = new Set([...new Set(queryTerms)].filter((term) => !GENERIC_TERMS.has(term)));

  const evidence: MatchEvidence[] = [];
  for (const doc of docs) {
    let score = 0;
    let hasSpecific = false;
    for (const term of new Set(queryTerms)) {
      const frequency = doc.terms.filter((t) => t === term).length;
      if (frequency === 0) continue;
      if (specific.has(term)) hasSpecific = true;
      const docFrequency = df.get(term) ?? 0;
      const idf = Math.log(1 + (totalDocs - docFrequency + 0.5) / (docFrequency + 0.5));
      const norm = frequency * (K1 + 1);
      const denom = frequency + K1 * (1 - B + (B * doc.terms.length) / avgLength);
      score += idf * (norm / denom);
    }
    // Si el requisito tiene algún término específico, la evidencia debe incluir
    // al menos uno. Cuando el requisito está escrito todo en genérico no se
    // puede exigir nada y se acepta la coincidencia léxica a secas.
    const qualifies = specific.size === 0 || hasSpecific;
    if (score > 0 && qualifies) {
      evidence.push({ id: doc.id, score: score * WHERE_WEIGHT[doc.where], where: doc.where });
    }
  }

  return evidence.sort((a, b) => b.score - a.score).slice(0, 5);
}

/* ========================================================================== *
 * Preguntas eliminatorias
 * ========================================================================== */

/**
 * Contrasta los knockouts declarados en la vacante contra `eligibility`. Este
 * es el único punto del proceso donde de verdad hay un rechazo automático, así
 * que conviene verlo ANTES de invertir una tarde en adaptar el CV.
 */
function checkKnockouts(
  job: Job,
  eligibility: Eligibility | undefined,
  profile?: PersonProfile,
): MatchResult['knockouts'] {
  const today = new Date().toISOString().slice(0, 10);

  return job.knockouts.map((knockout) => {
    const question = normalize(knockout.question);
    const expects = normalize(knockout.expects);
    const base = { id: knockout.id, question: knockout.question, expects: knockout.expects };
    const wantsYes = expects.includes('yes') || expects.includes('si');

    // ── Autorización para trabajar ────────────────────────────────────────
    if (/(authorization|authorisation|work permit|legally authorized|autoriza|permiso de trabajo|sponsorship)/.test(question)) {
      // Cuando la pregunta dice "en tu país de residencia", el país es el de
      // residencia declarada, no el de la oficina que publica la vacante.
      const asksResidence = /(country of residence|país de residencia|your country)/.test(question);
      const country = asksResidence
        ? eligibility?.residence?.countryCode
        : (job.location?.countryCode ?? eligibility?.residence?.countryCode);
      const auth = country
        ? eligibility?.workAuthorization.find((a) => a.countryCode === country)
        : undefined;

      if (!auth) {
        return { ...base, ok: true, note: `No hay autorización declarada para ${country ?? 'ese país'} en eligibility.yaml: respondela a mano.` };
      }
      const needsSponsorship = auth.status === 'none' || auth.sponsorshipRequired;
      const answer = needsSponsorship ? 'no' : 'yes';
      const ok = wantsYes ? answer === 'yes' : true;
      return {
        ...base,
        answer,
        ok,
        note: ok
          ? undefined
          : `Requiere patrocinio en ${country}. Confirmá que la empresa lo ofrezca antes de invertir tiempo en esta postulación.`,
      };
    }

    // ── Certificación vigente ─────────────────────────────────────────────
    if (/(certification|certificate|certificaci)/.test(question)) {
      const match = profile?.certificates.find((cert) => {
        const haystack = normalize(`${cert.name} ${cert.issuer} ${cert.tags.join(' ')}`);
        return tokenize(knockout.question).some((term) => term.length > 3 && haystack.includes(term));
      });
      if (!match) {
        return { ...base, answer: 'no', ok: !wantsYes, note: 'No hay una certificación que coincida en certificates.yaml.' };
      }
      const expired = match.expiresAt !== undefined && match.expiresAt < today.slice(0, match.expiresAt.length);
      const answer = expired ? 'no' : 'yes';
      return {
        ...base,
        answer,
        ok: wantsYes ? !expired : true,
        note: expired
          ? `"${match.name}" venció en ${match.expiresAt}: renovala o respondé que no.`
          : `Respaldada por "${match.name}"${match.expiresAt ? ` (vigente hasta ${match.expiresAt})` : ''}.`,
      };
    }

    // ── Disponibilidad / preaviso ─────────────────────────────────────────
    const startWindow = question.match(/within (\d+) days/);
    if (startWindow && eligibility?.noticePeriod) {
      const days =
        eligibility.noticePeriod.unit === 'days'
          ? eligibility.noticePeriod.value
          : eligibility.noticePeriod.unit === 'weeks'
            ? eligibility.noticePeriod.value * 7
            : eligibility.noticePeriod.value * 30;
      const limit = Number(startWindow[1]);
      const fits = days <= limit;
      return {
        ...base,
        answer: fits ? 'yes' : 'no',
        ok: wantsYes ? fits : true,
        note: `Tu preaviso declarado es de ${days} días y la ventana es de ${limit}.`,
      };
    }

    // ── Pretensión salarial ───────────────────────────────────────────────
    if (/(compensation|salary|expected.*(gross|annual)|pretensi|remuneraci)/.test(question) && eligibility?.compensation) {
      const { currency, min, max } = eligibility.compensation;
      const range = [min, max].filter((n): n is number => typeof n === 'number');
      if (range.length > 0) {
        return {
          ...base,
          answer: range.length === 2 ? `${currency} ${range[0]}–${range[1]}` : `${currency} ${range[0]}`,
          ok: true,
          note: 'Sale de eligibility.compensation, que es visibility: private y nunca se imprime en el CV.',
        };
      }
    }

    // ── Solapamiento horario ──────────────────────────────────────────────
    if (/(overlap|time ?zone|husos?|horario)/.test(question) && eligibility?.residence?.timezone) {
      return {
        ...base,
        ok: true,
        note: `Tu zona declarada es ${eligibility.residence.timezone}: verificá el solapamiento con la de la vacante y respondé a mano.`,
      };
    }

    return {
      ...base,
      ok: true,
      note: 'Sin dato en eligibility.yaml para resolverla automáticamente: respondela a mano.',
    };
  });
}

/* ========================================================================== *
 * API
 * ========================================================================== */

export function matchProfile(input: MatchInput): MatchResult {
  const { profile, job, taxonomy, eligibility, includedIds } = input;

  const index = buildAliasIndex(taxonomy);
  const docs = buildDocs(profile, index);

  const covered: MatchRequirementResult[] = [];
  const missing: MatchRequirementResult[] = [];
  const scores: Record<string, number> = {};
  /** Requisitos que cada ítem del perfil ayuda a cubrir. */
  const supports = new Map<string, string[]>();

  // Un requisito se considera cubierto cuando hay evidencia por encima de este
  // piso. Debajo, el término aparece de casualidad (una palabra genérica
  // compartida) y llamarlo cobertura daría una falsa sensación de completitud.
  const EVIDENCE_FLOOR = 0.35;

  for (const requirement of job.requirements) {
    const evidence = scoreRequirement(requirement, docs, index).filter((e) => e.score >= EVIDENCE_FLOOR);
    const result: MatchRequirementResult = {
      id: requirement.id,
      text: requirement.text,
      kind: requirement.kind,
      weight: requirement.weight,
      evidence,
    };

    if (evidence.length > 0) {
      covered.push(result);
      for (const item of evidence) {
        scores[item.id] = (scores[item.id] ?? 0) + item.score * requirement.weight;
        supports.set(item.id, [...(supports.get(item.id) ?? []), requirement.id]);
      }
    } else {
      result.hint = hintFor(requirement, profile);
      missing.push(result);
    }
  }

  // Score de cobertura ponderada. Los `must` pesan el doble que los `nice`:
  // cubrir un deseable no compensa que falte un excluyente.
  const weightOf = (r: Requirement | MatchRequirementResult) => r.weight * (r.kind === 'must' ? 2 : 1);
  const totalWeight = job.requirements.reduce((sum, r) => sum + weightOf(r), 0) || 1;
  const coveredWeight = covered.reduce((sum, r) => sum + weightOf(r), 0);
  const score = (coveredWeight / totalWeight) * 100;

  const included = includedIds ? new Set(includedIds) : undefined;
  const excludedButRelevant = included
    ? [...supports.entries()]
        .filter(([id]) => !included.has(id))
        .map(([id, requirements]) => ({
          id,
          reason: 'Está en el perfil y la vacante lo pide, pero la selección actual lo deja afuera.',
          requirements,
          score: scores[id] ?? 0,
        }))
        .sort((a, b) => b.score - a.score)
    : [];

  const sectionOf = new Map(docs.map((d) => [d.id, d.section]));
  const ranked = Object.entries(scores)
    .map(([id, value]) => ({ id, score: value, section: sectionOf.get(id) ?? ('work' as SectionName) }))
    .sort((a, b) => b.score - a.score);

  return {
    score,
    covered,
    missing,
    excludedButRelevant,
    knockouts: checkKnockouts(job, eligibility ?? profile.eligibility, profile),
    ranked,
    scores,
  };
}

/**
 * Pista para un requisito sin cubrir. La más útil es la del caso en que el dato
 * SÍ está en el perfil pero en un campo que no se imprime: ahí no falta
 * experiencia, falta mostrarla.
 */
function hintFor(requirement: Requirement, profile: PersonProfile): string {
  const terms = tokenize(requirement.text);

  const industries = profile.work.map((w) => normalize(w.company.industry ?? '')).filter(Boolean);
  if (terms.some((t) => industries.some((i) => i.includes(t)))) {
    return 'El dato está en company.industry de alguna experiencia, pero ese campo no se imprime: mencionalo en el summary o en un bullet.';
  }

  if (requirement.category === 'experience') {
    const years = totalYears(profile);
    if (years > 0) {
      return `Tenés unos ${years} años de experiencia acumulada: si el requisito es de antigüedad, explicitalo en basics.summary.`;
    }
  }

  if (requirement.category === 'cert') {
    return 'Si tenés la certificación, cargala en certificates.yaml; si no, es una brecha real.';
  }

  return 'No hay evidencia en el perfil. Si lo hiciste y no está cargado, agregá el bullet; si no, es una brecha real.';
}

function totalYears(profile: PersonProfile): number {
  const years = profile.work.flatMap((w) =>
    w.positions.map((p) => {
      const start = Number(p.startDate.slice(0, 4));
      const end = p.current ? new Date().getFullYear() : Number((p.endDate ?? p.startDate).slice(0, 4));
      return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    }),
  );
  return years.reduce((sum, y) => sum + y, 0);
}

export { matchProfile as match, matchProfile as matchAgainstJob };
