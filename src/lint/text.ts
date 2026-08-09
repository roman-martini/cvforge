import type { LintFinding, LintReport } from '../core/types.ts';
import type { DualExtraction } from '../pdf/extract.ts';

/**
 * Lint del texto extraído (ATS-050..063). Es la batería más valiosa del linter:
 * el CSS y el catálogo del PDF dicen cómo se construyó el documento; esto dice
 * qué recibe realmente el ATS.
 *
 * Todas las reglas se apoyan en la extracción dual (ver src/pdf/extract.ts).
 * `cv.txt` es el ground truth: se genera del mismo ViewModel que el PDF, así
 * que cualquier diferencia entre los dos es un defecto del render, no del dato.
 */

/* ========================================================================== *
 * Normalización y comparación
 * ========================================================================== */

/**
 * NFC + colapso de espacios + minúsculas.
 *
 * `\s` de JavaScript incluye U+00A0 y U+FEFF, así que el colapso los convierte
 * en espacio normal: un NBSP no rompe el recall, lo reporta ATS-054 con su
 * propio mensaje. U+200B en cambio NO es `\s` — parte el token en dos y falla
 * por los dos lados, que es exactamente lo que se quiere.
 */
export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').toLowerCase().trim();
}

const EDGE_PUNCTUATION = /^[.,;:!?()[\]{}<>"'“”‘’«»…·—–\-|/\\]+|[.,;:!?()[\]{}<>"'“”‘’«»…·—–|\\]+$/g;

/** Tokens comparables: se conservan `+` y `#` finales (C++, C#) y los internos. */
export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.replace(EDGE_PUNCTUATION, ''))
    .filter((token) => token.length > 0 && /[\p{L}\p{N}]/u.test(token));
}

export type RecallResult = {
  expected: number;
  missing: string[];
  extra: string[];
  ratio: number;
};

/** Recall de tokens: cuánto de `groundTruth` sobrevivió a `extracted`. */
export function compareRecall(groundTruth: string, extracted: string): RecallResult {
  const expected = new Set(tokenize(groundTruth));
  const actual = new Set(tokenize(extracted));
  const missing = [...expected].filter((token) => !actual.has(token));
  const extra = [...actual].filter((token) => !expected.has(token));
  return {
    expected: expected.size,
    missing,
    extra,
    ratio: expected.size === 0 ? 1 : (expected.size - missing.length) / expected.size,
  };
}

function sample(items: string[], max = 25): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} … (+${items.length - max} más)` : shown;
}

function findLineIndex(lines: string[], needle: string): number {
  const target = normalizeText(needle);
  if (target.length === 0) return -1;
  const normalized = lines.map(normalizeText);
  const exact = normalized.findIndex((line) => line.includes(target));
  if (exact >= 0) return exact;

  // El wrap de línea de Chrome puede partir la frase: se busca el token más
  // distintivo (el más largo) antes de dar la entrada por perdida.
  const tokens = tokenize(needle).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    if (token.length < 4) break;
    const index = normalized.findIndex((line) => line.includes(token));
    if (index >= 0) return index;
  }
  return -1;
}

function digitsOf(value: string): string {
  return value.replace(/\D+/g, '');
}

/* ========================================================================== *
 * Codepoints
 * ========================================================================== */

const INVISIBLE_CODEPOINTS: Array<{ codepoint: number; name: string; why: string }> = [
  { codepoint: 0x00a0, name: 'U+00A0 NO-BREAK SPACE', why: 'sobrevive intacto: "March 2022" no matchea "March 2022" ni sobrevive a un split(" ")' },
  { codepoint: 0x00ad, name: 'U+00AD SOFT HYPHEN', why: 'parte la palabra clave por la mitad en el texto extraído' },
  { codepoint: 0x200b, name: 'U+200B ZERO WIDTH SPACE', why: 'parte el token en dos sin que se vea nada' },
  { codepoint: 0x200c, name: 'U+200C ZERO WIDTH NON-JOINER', why: 'idem' },
  { codepoint: 0x200d, name: 'U+200D ZERO WIDTH JOINER', why: 'idem' },
  { codepoint: 0x2060, name: 'U+2060 WORD JOINER', why: 'idem' },
  { codepoint: 0xfeff, name: 'U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM', why: 'idem, y algunos parsers cortan el documento ahí' },
];

const LIGATURES: Record<number, string> = {
  0xfb00: 'ﬀ',
  0xfb01: 'ﬁ',
  0xfb02: 'ﬂ',
  0xfb03: 'ﬃ',
  0xfb04: 'ﬄ',
  0xfb05: 'ﬅ',
  0xfb06: 'ﬆ',
};

function contextAround(text: string, index: number, radius = 24): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text
    .slice(start, end)
    .replace(/\n/g, '⏎')
    .replace(/[\u0000-\u001f]/g, '·');
}

/* ========================================================================== *
 * Patrones de fecha (ATS-061)
 * ========================================================================== */

const MONTH_NAMES =
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|' +
  'januar|februar|märz|maerz|mai|juni|juli|august|september|oktober|november|dezember|' +
  'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|' +
  'janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|' +
  'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre';

const MONTH_ABBREVIATIONS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|ene|abr|ago|dic|mrz|okt|dez|mai|avr|juin|juil|déc|dic|set|out';

type DateFamily = { id: string; label: string; pattern: RegExp; monthPrecision: boolean };

const DATE_FAMILIES: DateFamily[] = [
  { id: 'iso-date', label: 'YYYY-MM-DD', pattern: /\b\d{4}-\d{2}-\d{2}\b/g, monthPrecision: true },
  { id: 'numeric-full', label: 'DD/MM/YYYY', pattern: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, monthPrecision: true },
  { id: 'dotted-full', label: 'DD.MM.YYYY', pattern: /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, monthPrecision: true },
  { id: 'month-name', label: 'Mes YYYY', pattern: new RegExp(`\\b(?:${MONTH_NAMES})\\.?\\s+\\d{4}\\b`, 'gi'), monthPrecision: true },
  { id: 'month-abbrev', label: 'Mmm YYYY', pattern: new RegExp(`\\b(?:${MONTH_ABBREVIATIONS})\\.?\\s+\\d{4}\\b`, 'gi'), monthPrecision: true },
  { id: 'numeric-month', label: 'MM/YYYY', pattern: /\b\d{1,2}\/\d{4}\b/g, monthPrecision: true },
  { id: 'dotted-month', label: 'MM.YYYY', pattern: /\b\d{1,2}\.\d{4}\b/g, monthPrecision: true },
  { id: 'iso-month', label: 'YYYY-MM', pattern: /\b\d{4}-\d{2}\b/g, monthPrecision: true },
  { id: 'year', label: 'YYYY', pattern: /\b(?:19|20)\d{2}\b/g, monthPrecision: false },
];

type DateUsage = { family: DateFamily; count: number; example: string };

/**
 * Tramos que contienen números pero no son fechas y hay que sacar de la vista
 * antes de buscar patrones: URLs, DOIs y códigos de credencial.
 *
 * Sin esto, un DOI como `https://doi.org/10.0000/example.2024.0042` se lee como
 * una fecha "MM.YYYY" y el linter reporta que el CV mezcla dos formatos de
 * fecha cuando en realidad usa uno solo. Un linter con falsos positivos se
 * termina ignorando, y ahí deja de proteger de los verdaderos.
 */
const NON_DATE_SPANS = [
  /https?:\/\/\S+/gi,
  /\bdoi\.org\/\S+/gi,
  /\b10\.\d{4,9}\/\S+/gi,
  /\b[A-Z]{2,}-[A-Z0-9-]+\b/g,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
];

/** Enmascara lo ya matcheado para que `2023-04-17` no cuente además como `YYYY-MM`. */
function collectDatePatterns(text: string): DateUsage[] {
  let working = text;
  for (const span of NON_DATE_SPANS) {
    working = working.replace(new RegExp(span.source, span.flags), (match) => ' '.repeat(match.length));
  }
  const usages: DateUsage[] = [];
  for (const family of DATE_FAMILIES) {
    const pattern = new RegExp(family.pattern.source, family.pattern.flags);
    let count = 0;
    let example = '';
    working = working.replace(pattern, (match) => {
      count += 1;
      if (!example) example = match;
      return ' '.repeat(match.length);
    });
    if (count > 0) usages.push({ family, count, example });
  }
  return usages;
}

/* ========================================================================== *
 * Prompt injection (ATS-062)
 * ========================================================================== */

/**
 * Red SECUNDARIA, no el gate.
 *
 * Más del 90 % de las inyecciones reales medidas en el estudio de 200.000 CVs
 * (Duke/UNC/ASU/Berkeley/hireEZ, USENIX ago-2026) NO usan instrucciones
 * explícitas: son keyword stuffing invisible, texto blanco o bloques fuera del
 * viewport. Contra eso el gate real es ATS-050 + ATS-063, que comparan lo
 * extraído contra el modelo de datos y no contra una lista de frases. Esta
 * regex sólo atrapa el caso torpe, y se mantiene porque es barata.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i, label: 'ignore previous instructions' },
  { pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above|the)\s+(?:instructions?|prompts?|rules?)/i, label: 'disregard previous instructions' },
  { pattern: /\bas an ai\b/i, label: 'as an AI' },
  { pattern: /(?:^|\n)\s*system\s*:/i, label: 'system:' },
  { pattern: /\bmark\s+this\s+(?:resume|candidate|cv)\b/i, label: 'mark this resume' },
  { pattern: /\brank\s+this\s+candidate\s+(?:first|highest|top)\b/i, label: 'rank this candidate first' },
  { pattern: /\b(?:you\s+(?:are|must)\s+now)\b/i, label: 'you are now …' },
  { pattern: /\bprompt\s+injection\b/i, label: 'prompt injection' },
  { pattern: /\brecommend\s+this\s+candidate\s+for\s+(?:the\s+)?(?:role|position)\b/i, label: 'recommend this candidate' },
];

/* ========================================================================== *
 * Entrada pública
 * ========================================================================== */

export type WorkAnchor = {
  id: string;
  /** El cargo tal como sale en el ViewModel. */
  title: string;
  /** La empresa tal como sale en el ViewModel. */
  company: string;
  /** El rango de fechas ya formateado. */
  dateRange: string;
};

export type TextLintOptions = {
  /** `cv.txt`: el ground truth generado del mismo ViewModel. */
  plainText: string;
  extraction: DualExtraction;
  /** Headings canónicos ya resueltos por el perfil regional. */
  headings?: string[];
  name: string;
  email: string;
  phone?: string;
  /** URLs que deben aparecer completas como texto visible. */
  urls?: string[];
  entries?: WorkAnchor[];
  /** Cargos en el orden en que deberían aparecer. */
  jobTitles?: string[];
  /** Ventana de la regla de proximidad, en líneas. */
  proximityWindow?: number;
  /** En cuántas líneas iniciales deben estar email y teléfono. */
  contactLineWindow?: number;
  /** Tokens que pueden aparecer en el PDF sin estar en cv.txt (numeración de página). */
  allowedExtras?: string[];
};

export function lintText(options: TextLintOptions): LintReport {
  const findings: LintFinding[] = [];
  const {
    plainText,
    extraction,
    headings = [],
    name,
    email,
    phone,
    urls = [],
    entries = [],
    jobTitles = [],
    proximityWindow = 6,
    contactLineWindow = 5,
    allowedExtras = ['page', 'pages', 'página', 'páginas', 'seite', 'von'],
  } = options;

  const streamText = extraction.stream;
  const sortedText = extraction.sorted;
  const bothOrders = `${streamText}\n${sortedText}`;
  const normalizedStream = normalizeText(streamText);
  const normalizedSorted = normalizeText(sortedText);

  /* ── ATS-050 — recall = 1.0 ───────────────────────────────────────────── */
  const recall = compareRecall(plainText, bothOrders);
  if (recall.missing.length > 0) {
    findings.push({
      rule: 'ATS-050',
      severity: 'error',
      message: `Faltan ${recall.missing.length} de ${recall.expected} tokens de cv.txt en el texto extraído del PDF (recall ${(recall.ratio * 100).toFixed(1)} %). Ausentes: ${sample(recall.missing)}`,
      where: 'PDF · extracción dual',
      fix: 'Cada token ausente salió del modelo de datos y no llegó al ATS. Revisá primero las reglas de CSS que reordenan o esconden texto (ATS-001..005, 011, 013, 063).',
    });
  }

  if (/[•▪◦‣]/.test(plainText)) {
    findings.push({
      rule: 'ATS-050',
      severity: 'warning',
      message: 'cv.txt emite marcadores de lista ("•"). Chrome dibuja los marcadores de <ul><li> como paths vectoriales, no como texto: el PDF nunca los va a tener y el comparador de recall va a fallar sistemáticamente por una diferencia cosmética.',
      where: 'cv.txt',
      fix: 'El renderer TXT no debe emitir "• ". Si necesitás sangría, usá dos espacios.',
    });
  }

  /* ── ATS-051 — mismo orden de secciones en los dos modos ──────────────── */
  const headingPositions = headings
    .map((heading) => ({
      heading,
      stream: normalizedStream.indexOf(normalizeText(heading)),
      sorted: normalizedSorted.indexOf(normalizeText(heading)),
    }))
    .filter((entry) => entry.stream >= 0 && entry.sorted >= 0);

  const orderByStream = [...headingPositions].sort((a, b) => a.stream - b.stream).map((e) => e.heading);
  const orderBySorted = [...headingPositions].sort((a, b) => a.sorted - b.sorted).map((e) => e.heading);
  if (orderByStream.join('|') !== orderBySorted.join('|')) {
    findings.push({
      rule: 'ATS-051',
      severity: 'error',
      message: `El orden de las secciones cambia según la familia de extractor. En orden de content stream: ${orderByStream.join(' → ')}. En orden geométrico: ${orderBySorted.join(' → ')}. La mitad de los ATS del mercado va a leer una de las dos.`,
      where: 'PDF · extracción dual',
      fix: 'Causa habitual: float, position ≠ static, dos columnas, margin-boxes de @page, `order` o un `*-reverse` de flex.',
    });
  }

  /* ── ATS-052 — proximidad título/empresa/fecha ────────────────────────── */
  for (const entry of entries) {
    const anchors = [
      { label: 'título', value: entry.title },
      { label: 'empresa', value: entry.company },
      { label: 'fecha', value: entry.dateRange },
    ].filter((anchor) => anchor.value.trim().length > 0);

    const located = anchors.map((anchor) => ({ ...anchor, line: findLineIndex(extraction.streamLines, anchor.value) }));
    const missing = located.filter((anchor) => anchor.line < 0);

    if (missing.length > 0) {
      findings.push({
        rule: 'ATS-052',
        severity: 'error',
        message: `De la entrada "${entry.id}" no se encuentra ${missing.map((m) => `${m.label} ("${m.value}")`).join(' ni ')} en el texto extraído en orden de content stream.`,
        where: `work:${entry.id}`,
        fix: 'Si el dato está en el PDF pero no acá, algo lo desprendió de su lugar: revisá opacity, position y float sobre esa caja.',
      });
      continue;
    }

    const lines = located.map((anchor) => anchor.line);
    const span = Math.max(...lines) - Math.min(...lines);
    if (span > proximityWindow) {
      const detail = located.map((anchor) => `${anchor.label}@línea ${anchor.line + 1}`).join(', ');
      findings.push({
        rule: 'ATS-052',
        severity: 'error',
        message: `La entrada "${entry.id}" queda desarmada: ${detail} — ${span} líneas de separación, más que la ventana de ${proximityWindow}. El ATS no va a poder asociar el cargo con la empresa ni con las fechas.`,
        where: `work:${entry.id}`,
        fix: 'Éste es el fallo más común y más silencioso: un opacity:0.7 decorativo en las fechas las desprende de su entrada y las apila al final. El PDF se ve impecable. Revisá ATS-002/003 en la caja de la fecha.',
      });
    }
  }

  /* ── ATS-053 — índices monótonos crecientes ───────────────────────────── */
  const sequence: Array<{ label: string; index: number }> = [
    { label: `nombre ("${name}")`, index: normalizedStream.indexOf(normalizeText(name)) },
    { label: `email ("${email}")`, index: normalizedStream.indexOf(normalizeText(email)) },
    ...jobTitles.map((title) => ({ label: `cargo ("${title}")`, index: normalizedStream.indexOf(normalizeText(title)) })),
  ];

  let previous: { label: string; index: number } | undefined;
  for (const item of sequence) {
    if (item.index < 0) continue;
    if (previous && item.index < previous.index) {
      findings.push({
        rule: 'ATS-053',
        severity: 'error',
        message: `El ${item.label} aparece ANTES que el ${previous.label} en el texto extraído, al revés de como está en el documento. El orden de lectura del ATS no coincide con el orden visual.`,
        where: 'PDF · orden de content stream',
        fix: 'Se rompió el orden de pintado: buscá stacking contexts (position, opacity, transform, filter) en la cadena de ancestros de ese bloque.',
      });
    }
    if (!previous || item.index > previous.index) previous = item;
  }

  /* ── ATS-054/055/056 — codepoints ─────────────────────────────────────── */
  for (const invisible of INVISIBLE_CODEPOINTS) {
    const char = String.fromCodePoint(invisible.codepoint);
    const index = streamText.indexOf(char);
    if (index >= 0) {
      const total = streamText.split(char).length - 1;
      findings.push({
        rule: 'ATS-054',
        severity: 'error',
        message: `${invisible.name} aparece ${total} ${total === 1 ? 'vez' : 'veces'} en el texto extraído: ${invisible.why}. Contexto: "${contextAround(streamText, index)}"`,
        where: 'PDF · texto extraído',
        fix: 'Prohibido &nbsp; y &shy; en el template. Para evitar el corte de línea usá `.nowrap { white-space: nowrap }`.',
      });
    }
  }

  const puaMatch = /[\u{E000}-\u{F8FF}]/u.exec(streamText);
  if (puaMatch) {
    findings.push({
      rule: 'ATS-055',
      severity: 'error',
      message: `Hay codepoints del Private Use Area (U+${puaMatch[0].codePointAt(0)?.toString(16).toUpperCase()}) en el texto extraído: es una icon font. El ATS recibe caracteres sin significado donde vos ves un ícono. Contexto: "${contextAround(streamText, puaMatch.index)}"`,
      where: 'PDF · texto extraído',
      fix: 'Los íconos van como SVG inline o no van. Nunca como glifos de una fuente de íconos.',
    });
  }

  for (const [codepoint, glyph] of Object.entries(LIGATURES)) {
    if (streamText.includes(glyph)) {
      findings.push({
        rule: 'ATS-056',
        severity: 'error',
        message: `La ligadura ${glyph} (U+${Number(codepoint).toString(16).toUpperCase()}) llegó al texto extraído: "office" se convierte en "oﬃce" y no matchea ninguna búsqueda del reclutador.`,
        where: 'PDF · texto extraído',
        fix: 'Desactivá las ligaduras discrecionales: `font-variant-ligatures: none` en el cuerpo del CV.',
      });
    }
  }

  if (streamText.includes('�')) {
    findings.push({
      rule: 'ATS-056',
      severity: 'error',
      message: 'Hay U+FFFD (carácter de reemplazo) en el texto extraído: la fuente embebida no tiene un cmap válido para esos glifos y el ATS recibe basura.',
      where: 'PDF · texto extraído',
      fix: 'Revisá que la fuente sea una instancia estática con tabla cmap y que el @font-face cargue de verdad (ATS-018/032).',
    });
  }

  /* ── ATS-057 — concatenación sospechosa ───────────────────────────────── */
  const groundTruthTokens = new Set(tokenize(plainText));
  const suspicious = new Set<string>();
  const wordPattern = /[\p{L}\p{N}+#.-]+/gu;
  let word = wordPattern.exec(streamText);
  while (word) {
    // La puntuación de borde se descarta antes de comparar: el patrón captura
    // el punto final de la oración, y sin quitarlo "PostgreSQL." no coincide
    // con el token "postgresql" del texto base y todo nombre con mayúscula
    // interna al final de una frase se reporta como si estuviera pegado.
    const bare = word[0].replace(/^[.-]+|[.-]+$/g, '');
    if (/[a-z][A-Z]/.test(bare) && !groundTruthTokens.has(normalizeText(bare))) suspicious.add(bare);
    word = wordPattern.exec(streamText);
  }
  if (suspicious.size > 0) {
    findings.push({
      rule: 'ATS-057',
      severity: 'warning',
      message: `Palabras pegadas sin separador en el texto extraído: ${sample([...suspicious], 10)}. Son cajas de flex o grid contiguas sin un separador textual real entre ellas.`,
      where: 'PDF · texto extraído',
      fix: 'Entre cajas hermanas siempre un separador de texto real (" · ", " — ") en el DOM: un `gap` de CSS no crea ningún carácter.',
    });
  }

  /* ── ATS-058 — headings contiguos ─────────────────────────────────────── */
  for (const heading of headings) {
    const needle = normalizeText(heading);
    const inStream = normalizedStream.includes(needle);
    const inSorted = normalizedSorted.includes(needle);
    if (!inStream || !inSorted) {
      findings.push({
        rule: 'ATS-058',
        severity: 'error',
        message: `El heading "${heading}" no aparece como string contiguo${!inStream && !inSorted ? ' en ninguno de los dos órdenes' : !inStream ? ' en orden de content stream' : ' en orden geométrico'}. Los parsers segmentan el CV buscando exactamente estos labels.`,
        where: 'PDF · texto extraído',
        fix: 'Casi siempre es letter-spacing (ATS-011): "E X P E R I E N C E" no matchea nada. Usá `font-variant: all-small-caps`, que conserva la capitalización original en el texto extraído.',
      });
    }
  }

  /* ── ATS-059 — contacto arriba de todo ────────────────────────────────── */
  const firstLine = normalizeText(extraction.streamLines[0] ?? '');
  const nameTokens = tokenize(name);
  if (nameTokens.length > 0 && !nameTokens.every((token) => firstLine.includes(token))) {
    findings.push({
      rule: 'ATS-059',
      severity: 'error',
      message: `La primera línea del texto extraído no contiene el nombre completo. Es "${extraction.streamLines[0] ?? '(vacía)'}".`,
      where: 'PDF · línea 1',
      fix: 'El nombre va en <h1> y primero en el DOM. Si algo lo desplaza, es un stacking context o un margin-box de @page.',
    });
  }

  const headLines = extraction.streamLines.slice(0, contactLineWindow);
  const headText = normalizeText(headLines.join(' '));
  if (!headText.includes(normalizeText(email))) {
    findings.push({
      rule: 'ATS-059',
      severity: 'error',
      message: `El email no aparece en las primeras ${contactLineWindow} líneas del texto extraído.`,
      where: 'PDF · encabezado',
      fix: 'Greenhouse documenta el contacto fuera del flujo (header/footer o @page) como causa de parseo fallido: falló en 6 de 8 ATS y el candidato aplica literalmente sin email.',
    });
  }
  if (phone) {
    const wanted = digitsOf(phone);
    if (wanted.length >= 6 && !digitsOf(headLines.join(' ')).includes(wanted)) {
      findings.push({
        rule: 'ATS-059',
        severity: 'error',
        message: `El teléfono no aparece completo en las primeras ${contactLineWindow} líneas del texto extraído.`,
        where: 'PDF · encabezado',
        fix: 'Emití el teléfono como texto en el flujo del documento, con `.nowrap` en vez de &nbsp;.',
      });
    }
  }

  /* ── ATS-060 — URLs completas y visibles ──────────────────────────────── */
  for (const url of urls) {
    const visible = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (!normalizedStream.includes(normalizeText(visible))) {
      findings.push({
        rule: 'ATS-060',
        severity: 'error',
        message: `La URL "${url}" no aparece completa como texto visible en el PDF. Un <a> cuyo texto es "LinkedIn" deja al reclutador sin la dirección cuando el ATS descarta las anotaciones.`,
        where: 'PDF · texto extraído',
        fix: 'Emití la URL completa como texto del enlace: linkedin.com/in/usuario, no "LinkedIn".',
      });
    }
  }

  /* ── ATS-061 — un único patrón de fecha ───────────────────────────────── */
  const usages = collectDatePatterns(streamText);
  const monthPrecision = usages.filter((usage) => usage.family.monthPrecision);
  if (monthPrecision.length > 1) {
    findings.push({
      rule: 'ATS-061',
      severity: 'error',
      message: `Conviven ${monthPrecision.length} patrones de fecha distintos: ${monthPrecision.map((u) => `${u.family.label} (${u.count}×, ej. "${u.example}")`).join(', ')}. Un parser con detección de formato va a interpretar mal al menos uno.`,
      where: 'PDF · texto extraído',
      fix: 'El patrón lo fija el perfil regional (`datePattern`) y lo aplica el ViewModel una sola vez. Ninguna fecha debe formatearse en un renderer.',
    });
  } else if (monthPrecision.length === 1 && usages.some((usage) => !usage.family.monthPrecision)) {
    findings.push({
      rule: 'ATS-061',
      severity: 'warning',
      message: `Además del patrón ${monthPrecision[0]?.family.label} hay años sueltos en el documento. Si son fechas de entradas, unificalos con el patrón principal.`,
      where: 'PDF · texto extraído',
      fix: 'Los años dentro de prosa son legítimos; los rangos de una entrada deben usar siempre el mismo formato.',
    });
  }

  /* ── ATS-062 — prompt injection ───────────────────────────────────────── */
  for (const injection of INJECTION_PATTERNS) {
    const match = injection.pattern.exec(streamText);
    if (match) {
      findings.push({
        rule: 'ATS-062',
        severity: 'error',
        message: `Patrón de prompt injection en el texto extraído: "${injection.label}". Contexto: "${contextAround(streamText, match.index, 60)}"`,
        where: 'PDF · texto extraído',
        fix: 'Sacalo del modelo de datos. Esta regla es una red secundaria: el gate real es ATS-050 + ATS-063, porque más del 90 % de las inyecciones reales no usan instrucciones explícitas.',
      });
    }
  }

  /* ── ATS-063 — texto invisible (mitad texto: el diff contra cv.txt) ───── */
  const allowed = new Set(allowedExtras.map(normalizeText));
  const unexplained = recall.extra.filter((token) => token.length >= 4 && /^[\p{L}]+$/u.test(token) && !allowed.has(token));
  if (unexplained.length > 0) {
    findings.push({
      rule: 'ATS-063',
      severity: 'error',
      message: `El PDF contiene ${unexplained.length} palabras que no existen en el modelo de datos: ${sample(unexplained)}. O las inyectó un \`content:\` de CSS (ATS-013) o es texto oculto.`,
      where: 'PDF · diff contra cv.txt',
      fix: 'El texto blanco, con opacidad 0 o de 1px técnicamente funciona —sí se extrae— y es exactamente por eso que es fraude, es detectable y puede dejar un indicador persistente en el registro del candidato.',
    });
  }

  return { format: 'pdf', findings, passed: findings.every((f) => f.severity !== 'error') };
}
