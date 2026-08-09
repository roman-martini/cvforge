import { PDFDocument, PDFDict, PDFName, PDFRef } from 'pdf-lib';
import type { LintFinding, LintReport } from '../core/types.ts';
import { extractDual, readPdfMetadata, type DualExtraction } from '../pdf/extract.ts';

/**
 * Lint del PDF ya generado (ATS-030..041).
 *
 * Se leen dos capas distintas del mismo archivo: el catálogo crudo con pdf-lib
 * (MediaBox, descriptores de fuente, imágenes, metadata) y la vista de alto
 * nivel de pdf.js (árbol de estructura, /MarkInfo, capa de texto por página).
 * Ninguna de las dos alcanza sola.
 */

/** Papel esperado en puntos PostScript, con la tolerancia del redondeo de Chromium. */
const PAPER_SIZES = {
  A4: { width: 595, height: 842 },
  Letter: { width: 612, height: 792 },
} as const;

const PAPER_TOLERANCE_PT = 3;

/** Límite duro de parseo documentado por Greenhouse. */
const MAX_BYTES = Math.round(2.5 * 1024 * 1024);

/** Regiones donde la foto está prohibida: cero imágenes embebidas. */
const NO_IMAGE_REGIONS = new Set(['us', 'uk', 'ca', 'nl', 'au']);

const TITLE_LEAKS = /\b(tailored|draft|borrador|final|v\d+|rev\d+|salary|sueldo|copy|copia)\b/i;

export type PdfLintOptions = {
  paper: 'A4' | 'Letter';
  maxPages: number;
  /** Locale declarado del CV: debe coincidir con /Lang. */
  locale: string;
  /** Clave del perfil regional; decide el máximo de imágenes. */
  region?: string;
  /** Familias que el tema declara embeber (theme.yaml). */
  expectedFonts?: string[];
  /** Términos que no pueden aparecer en /Title: nombre de la empresa objetivo. */
  forbiddenTitleTerms?: string[];
  maxBytes?: number;
  maxImages?: number;
  /** Extracción ya calculada, para no parsear el PDF dos veces. */
  extraction?: DualExtraction;
};

type FontDescriptor = { name: string; embedded: boolean };

type CatalogFacts = {
  pageCount: number;
  pageSizes: Array<{ width: number; height: number }>;
  lang?: string;
  marked: boolean;
  hasStructTreeRoot: boolean;
  descriptors: FontDescriptor[];
  imageCount: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
};

function decodeString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const asString = String(value);
  // pdf-lib serializa PDFString como `(texto)` y PDFHexString como `<hex>`.
  if (asString.startsWith('(') && asString.endsWith(')')) return asString.slice(1, -1);
  if (asString.startsWith('/')) return asString.slice(1);
  return asString;
}

/** Los subsets vienen prefijados con seis mayúsculas y un `+`: `ABCDEE+SourceSans3`. */
function baseFontName(raw: string): string {
  return raw.replace(/^\/?[A-Z]{6}\+/, '').replace(/^\//, '');
}

async function readCatalog(pdf: Buffer): Promise<CatalogFacts> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = doc.getPages();
  const catalog = doc.catalog;

  const descriptors: FontDescriptor[] = [];
  const imageRefs = new Set<string>();
  const softMaskRefs = new Set<string>();

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const type = object.get(PDFName.of('Type'));
    const subtype = object.get(PDFName.of('Subtype'));

    if (type !== undefined && String(type) === '/FontDescriptor') {
      const embedded =
        object.get(PDFName.of('FontFile')) !== undefined ||
        object.get(PDFName.of('FontFile2')) !== undefined ||
        object.get(PDFName.of('FontFile3')) !== undefined;
      descriptors.push({ name: baseFontName(String(object.get(PDFName.of('FontName')) ?? '(sin nombre)')), embedded });
    }

    if (subtype !== undefined && String(subtype) === '/Image') {
      imageRefs.add(refKey(ref));
      const smask = object.get(PDFName.of('SMask'));
      if (smask instanceof PDFRef) softMaskRefs.add(refKey(smask));
    }
  }

  for (const key of softMaskRefs) imageRefs.delete(key);

  return {
    pageCount: pages.length,
    pageSizes: pages.map((page) => page.getSize()),
    lang: decodeString(catalog.get(PDFName.of('Lang'))),
    marked: readMarkedFlag(catalog),
    hasStructTreeRoot: catalog.get(PDFName.of('StructTreeRoot')) !== undefined,
    descriptors,
    imageCount: imageRefs.size,
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords(),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
  };
}

function refKey(ref: PDFRef): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

function readMarkedFlag(catalog: PDFDict): boolean {
  const markInfo = catalog.get(PDFName.of('MarkInfo'));
  if (!(markInfo instanceof PDFDict)) return false;
  return String(markInfo.get(PDFName.of('Marked')) ?? '') === 'true';
}

export async function lintPdf(pdf: Buffer, options: PdfLintOptions): Promise<LintReport> {
  const findings: LintFinding[] = [];
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxImages = options.maxImages ?? (options.region && NO_IMAGE_REGIONS.has(options.region.toLowerCase()) ? 0 : 1);

  const catalog = await readCatalog(pdf);
  const extraction = options.extraction ?? (await extractDual(pdf));
  const metadata = await readPdfMetadata(pdf);

  /* ── ATS-030 — MediaBox vs papel del perfil ───────────────────────────── */
  const expected = PAPER_SIZES[options.paper];
  catalog.pageSizes.forEach((size, index) => {
    const matches =
      Math.abs(size.width - expected.width) <= PAPER_TOLERANCE_PT &&
      Math.abs(size.height - expected.height) <= PAPER_TOLERANCE_PT;
    if (!matches) {
      findings.push({
        rule: 'ATS-030',
        severity: 'error',
        message: `La página ${index + 1} mide ${size.width.toFixed(1)}×${size.height.toFixed(1)} pt y el perfil pide ${options.paper} (${expected.width}×${expected.height} pt).`,
        where: `PDF · página ${index + 1}`,
        fix: 'Casi siempre falta `preferCSSPageSize: true` en el render: sin él el MediaBox sale Letter aunque el CSS diga A4, con el mismo contenido y el mismo número de páginas. Sólo se nota al imprimir.',
      });
    }
  });

  /* ── ATS-031 — toda fuente embebida ───────────────────────────────────── */
  const notEmbedded = catalog.descriptors.filter((descriptor) => !descriptor.embedded);
  if (notEmbedded.length > 0) {
    findings.push({
      rule: 'ATS-031',
      severity: 'error',
      message: `Hay ${notEmbedded.length} /FontDescriptor sin /FontFile*: ${notEmbedded.map((d) => d.name).join(', ')}. El PDF depende de que el reclutador tenga esa fuente instalada.`,
      where: 'PDF · descriptores de fuente',
      fix: 'Causa verificada: fuentes variables. Chromium no embebe fuentes con tabla fvar — usá instancias estáticas (@fontsource/source-sans-3, nunca @fontsource-variable/…).',
    });
  }

  /* ── ATS-032 — el conjunto embebido es el que declara el tema ─────────── */
  if (options.expectedFonts && options.expectedFonts.length > 0) {
    const normalize = (value: string) => value.replace(/[\s_-]/g, '').toLowerCase();
    const embedded = new Set(catalog.descriptors.filter((d) => d.embedded).map((d) => normalize(d.name)));
    const missing = options.expectedFonts.filter((family) => ![...embedded].some((name) => name.includes(normalize(family))));
    const unexpected = [...embedded].filter((name) => !options.expectedFonts?.some((family) => name.includes(normalize(family))));

    if (missing.length > 0) {
      findings.push({
        rule: 'ATS-032',
        severity: 'error',
        message: `El tema declara ${missing.join(', ')} y el PDF no la embebe. Esto es lo único que atrapa el modo de falla más catastrófico del pipeline: un error de sintaxis en @font-face descarta TODO el stylesheet sin emitir ningún error y el PDF sale en Times New Roman 12pt con el build en verde.`,
        where: 'PDF · descriptores de fuente',
        fix: 'Abrí el PDF y mirá la tipografía. Después revisá el @font-face: un salto de línea dentro del url() de un data URI alcanza para tirar la hoja entera.',
      });
    }
    if (unexpected.length > 0) {
      findings.push({
        rule: 'ATS-032',
        severity: 'warning',
        message: `El PDF embebe fuentes que el tema no declara: ${unexpected.join(', ')}. Con la primaria ausente Chrome embebe la siguiente del stack en silencio, con otras métricas y otra paginación.`,
        where: 'PDF · descriptores de fuente',
        fix: 'Actualizá theme.yaml si el cambio es intencional; si no, la fuente primaria no está cargando.',
      });
    }
  }

  /* ── ATS-033 — presupuesto de páginas ─────────────────────────────────── */
  if (catalog.pageCount > options.maxPages) {
    findings.push({
      rule: 'ATS-033',
      severity: 'error',
      message: `El PDF tiene ${catalog.pageCount} páginas y el presupuesto es ${options.maxPages}.`,
      where: 'PDF',
      fix: 'El fit-loop debería haberlo resuelto antes de llegar acá: revisá `fit.densitySteps` y la política de ajuste del perfil.',
    });
  }

  /* ── ATS-034 — tamaño ─────────────────────────────────────────────────── */
  if (pdf.byteLength > maxBytes) {
    findings.push({
      rule: 'ATS-034',
      severity: 'error',
      message: `El archivo pesa ${(pdf.byteLength / 1024 / 1024).toFixed(2)} MB y el límite duro de parseo es ${(maxBytes / 1024 / 1024).toFixed(2)} MB.`,
      where: 'PDF',
      fix: 'Subseteá las fuentes o sacá las imágenes. Un CV de texto no debería pasar de 300 KB.',
    });
  }

  /* ── ATS-035 — /Lang ──────────────────────────────────────────────────── */
  const declaredLanguage = options.locale.split(/[-_]/)[0]?.toLowerCase() ?? '';
  const pdfLanguage = (catalog.lang ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
  if (!catalog.lang) {
    findings.push({
      rule: 'ATS-035',
      severity: 'error',
      message: 'El catálogo no tiene /Lang. Sin <html lang> Chrome estampa el locale del sistema (verificado es-419 en un CV en inglés) y un parser con detección de locale lee 03/09/2024 como 9 de marzo.',
      where: 'PDF · catálogo',
      fix: 'Emití <html lang="{vm.locale}"> en el template.',
    });
  } else if (pdfLanguage !== declaredLanguage) {
    findings.push({
      rule: 'ATS-035',
      severity: 'error',
      message: `/Lang es "${catalog.lang}" y el CV declara locale "${options.locale}".`,
      where: 'PDF · catálogo',
      fix: 'El <html lang> del template sale del ViewModel; si no coinciden, el locale no llegó al render.',
    });
  }

  /* ── ATS-036 — documento etiquetado ───────────────────────────────────── */
  if (!catalog.marked && !metadata.marked) {
    findings.push({
      rule: 'ATS-036',
      severity: 'error',
      message: 'Falta /MarkInfo con /Marked true: el PDF no está etiquetado.',
      where: 'PDF · catálogo',
      fix: 'En Playwright `tagged` viene en false por defecto (en Puppeteer viene en true): pasalo explícito junto con `outline`.',
    });
  }
  if (!catalog.hasStructTreeRoot) {
    findings.push({
      rule: 'ATS-036',
      severity: 'error',
      message: 'Falta /StructTreeRoot: no hay árbol de estructura y el orden lógico del documento queda librado al orden de pintado.',
      where: 'PDF · catálogo',
      fix: 'El tagging ya viene por defecto en Chrome 151; lo que define su calidad es el HTML. Con <div> el árbol sale como 182 /NonStruct.',
    });
  }

  /* ── ATS-037 — histograma de tags ─────────────────────────────────────── */
  if (metadata.structTreeRoles.length > 0) {
    const histogram = new Map<string, number>();
    for (const role of metadata.structTreeRoles) histogram.set(role, (histogram.get(role) ?? 0) + 1);
    const count = (role: string) => histogram.get(role) ?? 0;
    const total = metadata.structTreeRoles.length;
    const problems: string[] = [];

    if (count('H1') < 1) problems.push('ningún /H1 (el nombre debería ser <h1>)');
    if (count('H2') < 3) problems.push(`sólo ${count('H2')} /H2 (se esperan al menos 3 secciones)`);
    if (count('L') === 0 || count('LI') === 0) problems.push('sin /L + /LI (los bullets no son una lista nativa)');
    const nonStructRatio = count('NonStruct') / total;
    if (nonStructRatio > 0.2) problems.push(`${(nonStructRatio * 100).toFixed(0)} % de /NonStruct (máximo 20 %)`);

    if (problems.length > 0) {
      findings.push({
        rule: 'ATS-037',
        severity: 'warning',
        message: `El árbol de estructura es pobre: ${problems.join('; ')}.`,
        where: 'PDF · StructTreeRoot',
        fix: 'HTML semántico: <h1> nombre, <h2> secciones, <h3> cargo, <ul><li> bullets, <p> prosa, <a href> links. Con eso salen H1/H2/H3/P/L/LI/Lbl/Link/URI.',
      });
    }
  }

  /* ── ATS-038 — /Title no filtra el tailoring ──────────────────────────── */
  const title = catalog.title ?? '';
  if (TITLE_LEAKS.test(title)) {
    findings.push({
      rule: 'ATS-038',
      severity: 'error',
      message: `/Title contiene un identificador de variante: "${title}". Chrome lo copia literal del <title> y con /ViewerPreferences /DisplayDocTitle es lo primero que ve el reclutador en el visor.`,
      where: 'PDF · /Title',
      fix: 'El <title> es neutro y determinista: "{Nombre Apellido} — Resume". Nunca la variante ni la empresa.',
    });
  }
  for (const term of options.forbiddenTitleTerms ?? []) {
    if (term.trim().length > 2 && title.toLowerCase().includes(term.toLowerCase())) {
      findings.push({
        rule: 'ATS-038',
        severity: 'error',
        message: `/Title menciona a "${term}", la empresa objetivo. Es la fuga más probable de un workspace de tailoring.`,
        where: 'PDF · /Title',
        fix: 'Sacá la empresa del <title>. El nombre de archivo puede llevarla; el metadato del documento no.',
      });
    }
  }

  /* ── ATS-039 — capa de texto en toda página ───────────────────────────── */
  extraction.pagesSorted.forEach((text, index) => {
    if (text.trim().length === 0) {
      findings.push({
        rule: 'ATS-039',
        severity: 'error',
        message: `La página ${index + 1} no tiene capa de texto: el ATS recibe una hoja en blanco.`,
        where: `PDF · página ${index + 1}`,
        fix: 'Si la página existe pero está vacía, sobra un salto de página; si tiene contenido visible, se rasterizó.',
      });
    }
  });

  /* ── ATS-040 — imágenes ───────────────────────────────────────────────── */
  if (catalog.imageCount > maxImages) {
    findings.push({
      rule: 'ATS-040',
      severity: 'error',
      message: `El PDF embebe ${catalog.imageCount} imágenes y el perfil${options.region ? ` "${options.region}"` : ''} admite ${maxImages}.`,
      where: 'PDF · XObjects',
      fix: maxImages === 0
        ? 'En us/uk/ca/nl/au la foto está prohibida (EEOC/OHRC: riesgo de discriminación). Sacala del perfil regional, no del template.'
        : 'Las imágenes no aportan texto extraíble y engordan el archivo.',
    });
  }

  /* ── ATS-041 — metadata del documento ─────────────────────────────────── */
  const missingMetadata = (
    [
      ['Author', catalog.author],
      ['Subject', catalog.subject],
      ['Keywords', catalog.keywords],
    ] as const
  )
    .filter(([, value]) => !value || String(value).trim().length === 0)
    .map(([key]) => `/${key}`);

  if (missingMetadata.length > 0) {
    findings.push({
      rule: 'ATS-041',
      severity: 'error',
      message: `Faltan metadatos del documento: ${missingMetadata.join(', ')}. Varios parsers los leen antes que el contenido.`,
      where: 'PDF · info dictionary',
      fix: 'Se completan en el post-proceso con pdf-lib, junto con la normalización de CreationDate/ModDate que habilita el golden por SHA-256.',
    });
  }

  const creator = catalog.creator ?? '';
  const producer = catalog.producer ?? '';
  if (/headlesschrome/i.test(creator) || /headlesschrome/i.test(producer)) {
    findings.push({
      rule: 'ATS-041',
      severity: 'error',
      message: `/Creator o /Producer delatan el runner ("${creator || producer}").`,
      where: 'PDF · info dictionary',
      fix: 'Normalizá ambos en el post-proceso de pdf-lib.',
    });
  }

  return { format: 'pdf', findings, passed: findings.every((f) => f.severity !== 'error') };
}
