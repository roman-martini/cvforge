import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { parse as parseYaml } from 'yaml';
import { PDFDocument } from 'pdf-lib';
import type { Renderer, RenderOptions, RenderResult, ViewModel } from '../core/types.ts';

/**
 * Renderer de PDF: ViewModel → HTML del tema → Chromium → PDF etiquetado.
 *
 * El PDF es el entregable principal y el único formato del que se guarda hash
 * en la trazabilidad de la postulación, así que tiene dos requisitos duros que
 * el resto de los renderers no tienen: que el texto se extraiga en el mismo
 * orden en que se lee, y que dos corridas con la misma entrada produzcan el
 * mismo archivo byte a byte.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_THEME_DIR = path.join(HERE, '..', 'themes', 'ats-classic');

/**
 * Configuración de `page.pdf()`. Cada clave está acá por una razón verificada
 * y ninguna es un default seguro:
 *
 * - `preferCSSPageSize`: sin él el MediaBox sale Letter aunque el CSS declare
 *   A4, con el mismo contenido y el mismo número de páginas. Es un fallo
 *   silencioso que sólo aparece cuando alguien imprime el archivo.
 * - `printBackground`: el default de Playwright es false pero el de
 *   `--print-to-pdf` es true; fijarlo hace el pipeline agnóstico al runner.
 * - `tagged` y `outline`: en Playwright `tagged` viene en false (en Puppeteer
 *   en true), así que hay que pasarlos siempre explícitos.
 * - `displayHeaderFooter`: los templates de header/footer se renderizan en un
 *   documento aislado, sin este CSS ni estas @font-face.
 *
 * `margin` NO está y no debe agregarse: es no-op frente al `@page` del CSS
 * (verificado byte a byte con margin 0 y con el default) y tener dos lugares
 * donde se definen los márgenes garantiza que alguien toque el equivocado.
 */
const PDF_OPTIONS = {
  preferCSSPageSize: true,
  printBackground: true,
  tagged: true,
  outline: true,
  displayHeaderFooter: false,
} as const;

/**
 * Numerar "1 / 1" es ruido. La única manera de condicionar un margin-box de
 * `@page` a la cantidad de páginas es medirla primero, así que el tema declara
 * la numeración y el renderer la anula cuando sobra. `content: none` no genera
 * la caja: no queda ni un espacio en el pie.
 */
const SUPPRESS_PAGE_NUMBER_CSS = '@page { @bottom-center { content: none; } }';

/**
 * Fecha constante para /CreationDate y /ModDate. El PDF de Chromium ya es
 * determinista salvo el timestamp (dos renders difieren en 2 bytes): fijarla
 * es lo que habilita el golden testing por SHA-256 y el hash de trazabilidad
 * de `meta.yaml`.
 */
const FIXED_PDF_DATE = new Date(Date.UTC(2001, 0, 1, 0, 0, 0));

const DEFAULT_CREATOR = 'cv-workspace';
const DEFAULT_PRODUCER = 'cv-workspace / Chromium';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

type ThemeDescriptor = {
  id: string;
  version: string;
  template: string;
  stylesheets: { print: string[]; screen: string[] };
};

type TemplateModule = {
  renderDocument(
    vm: ViewModel,
    opts: { styles: string[]; density?: ViewModel['density']; accent?: 'color' | 'none' },
  ): string;
};

export type PdfMetadata = {
  title: string;
  author: string;
  subject: string;
  keywords: string[];
  /** Refuerza el /Lang que Chrome ya derivó de `<html lang>`. */
  language?: string;
  creator?: string;
  producer?: string;
};

const assetCache = new Map<string, string>();
const themeCache = new Map<string, ThemeDescriptor>();
const templateCache = new Map<string, TemplateModule>();

/* ========================================================================== *
 * Tema: descriptor, CSS y plantilla
 * ========================================================================== */

async function loadTheme(themeDir: string): Promise<ThemeDescriptor> {
  const cached = themeCache.get(themeDir);
  if (cached) return cached;

  const file = path.join(themeDir, 'theme.yaml');
  const raw: unknown = parseYaml(await readFile(file, 'utf8'));

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`El tema ${file} no contiene un mapa YAML.`);
  }
  const candidate = raw as Partial<ThemeDescriptor>;
  const printSheets = candidate.stylesheets?.print;
  if (typeof candidate.template !== 'string' || !Array.isArray(printSheets)) {
    throw new Error(
      `El tema ${file} tiene que declarar "template" y "stylesheets.print" para poder renderizar.`,
    );
  }

  const theme: ThemeDescriptor = {
    id: candidate.id ?? path.basename(themeDir),
    version: candidate.version ?? '0.0.0',
    template: candidate.template,
    stylesheets: { print: printSheets, screen: candidate.stylesheets?.screen ?? printSheets },
  };
  themeCache.set(themeDir, theme);
  return theme;
}

async function loadTemplate(themeDir: string, templateFile: string): Promise<TemplateModule> {
  const file = path.join(themeDir, templateFile);
  const cached = templateCache.get(file);
  if (cached) return cached;

  // pathToFileURL y no la ruta cruda: en Windows `import('C:\\...')` se
  // interpreta como un especificador de paquete con protocolo desconocido.
  const mod = (await import(pathToFileURL(file).href)) as Partial<TemplateModule>;
  if (typeof mod.renderDocument !== 'function') {
    throw new Error(`La plantilla ${file} no exporta renderDocument(vm, opts).`);
  }
  const template = mod as TemplateModule;
  templateCache.set(file, template);
  return template;
}

async function toDataUri(absolutePath: string): Promise<string> {
  const cached = assetCache.get(absolutePath);
  if (cached) return cached;

  const extension = path.extname(absolutePath).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
  const bytes = await readFile(absolutePath);
  const uri = `data:${mime};base64,${bytes.toString('base64')}`;
  assetCache.set(absolutePath, uri);
  return uri;
}

/**
 * Convierte cada `url()` relativa del CSS del tema en un `data:` URI.
 *
 * El CSS estático conserva rutas relativas a `assets/fonts/` para que el
 * linter pueda resolverlas y verificar que la familia esté en la allowlist y
 * que el woff2 no tenga tabla `fvar`; el documento que ve Chromium ya las
 * lleva embebidas, lo que elimina de un plumazo toda la casuística de acceso
 * a `file://` desde un documento sin origen.
 *
 * El data URI se emite en UNA sola línea a propósito: un salto de línea dentro
 * del `url()` descarta el stylesheet ENTERO sin ningún error y el PDF sale en
 * Times New Roman 12pt.
 */
export async function inlineCssAssets(css: string, baseDir: string): Promise<string> {
  const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const replacements = new Map<string, string>();

  for (const match of css.matchAll(pattern)) {
    const reference = (match[2] ?? '').trim();
    if (reference === '' || /^(data:|https?:|file:)/i.test(reference)) continue;
    if (replacements.has(match[0])) continue;
    const resolved = path.resolve(baseDir, reference.split('/').join(path.sep));
    replacements.set(match[0], `url(${await toDataUri(resolved)})`);
  }

  let out = css;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out;
}

async function loadPrintStyles(themeDir: string, theme: ThemeDescriptor): Promise<string[]> {
  const styles: string[] = [];
  for (const sheet of theme.stylesheets.print) {
    const file = path.join(themeDir, sheet);
    styles.push(await inlineCssAssets(await readFile(file, 'utf8'), path.dirname(file)));
  }
  return styles;
}

/* ========================================================================== *
 * Browser
 * ========================================================================== */

type Channel = NonNullable<RenderOptions['channel']>;

const CHANNEL_LABEL: Record<Channel, string> = {
  preview: 'Chrome del sistema',
  release: 'Chromium pinneado de Playwright',
};

/**
 * `release` usa siempre el Chromium bundleado: Chrome se autoactualiza solo y
 * con cada versión cambia la paginación, así que los golden y el conteo de
 * páginas tienen que correr contra un binario fijo. `preview` usa el Chrome
 * del sistema, que es lo que el autor ya tiene abierto.
 *
 * Si el canal pedido no arranca se cae al otro con un aviso visible: quedarse
 * sin PDF por no tener Chrome instalado sería peor que renderizar con una
 * paginación potencialmente distinta, siempre que se diga en voz alta.
 */
async function launchBrowser(channel: Channel): Promise<Browser> {
  const order: Channel[] = channel === 'preview' ? ['preview', 'release'] : ['release', 'preview'];
  const failures: string[] = [];

  for (const candidate of order) {
    try {
      const browser = await chromium.launch(
        candidate === 'preview' ? { channel: 'chrome' } : {},
      );
      if (candidate !== channel) {
        console.warn(
          `[pdf] No se pudo usar ${CHANNEL_LABEL[channel]}; se renderiza con ` +
            `${CHANNEL_LABEL[candidate]}. La paginación puede diferir de la validada.`,
        );
      }
      return browser;
    } catch (error) {
      failures.push(`${CHANNEL_LABEL[candidate]}: ${(error as Error).message}`);
    }
  }

  throw new Error(`No se pudo abrir ningún navegador para renderizar el PDF.\n${failures.join('\n')}`);
}

/* ========================================================================== *
 * API pública
 * ========================================================================== */

/** El HTML exacto que se manda a Chromium. Lo consumen el linter y los golden. */
export async function renderDocumentHtml(
  vm: ViewModel,
  opts: RenderOptions = {},
  extraStyles: string[] = [],
): Promise<string> {
  const themeDir = opts.themeDir ?? DEFAULT_THEME_DIR;
  const theme = await loadTheme(themeDir);
  const template = await loadTemplate(themeDir, theme.template);
  const styles = [...(await loadPrintStyles(themeDir, theme)), ...extraStyles];

  return template.renderDocument(vm, { styles, density: opts.density ?? vm.density });
}

async function render(vm: ViewModel, opts: RenderOptions = {}): Promise<RenderResult> {
  const browser = await launchBrowser(opts.channel ?? 'release');

  try {
    const page = await browser.newPage();

    const paint = async (extraStyles: string[]): Promise<Buffer> => {
      await page.setContent(await renderDocumentHtml(vm, opts, extraStyles), {
        waitUntil: 'load',
      });
      // Sin esperar a las fuentes, Chromium pagina con las métricas de la
      // fuente de sistema y después reemplaza los glifos: mismo texto, otro
      // corte de página.
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      return Buffer.from(await page.pdf(PDF_OPTIONS));
    };

    let pdf = await paint([]);
    let pages = await countPages(pdf);

    if (pages === 1) {
      pdf = await paint([SUPPRESS_PAGE_NUMBER_CSS]);
      pages = await countPages(pdf);
    }

    const content = await applyPdfMetadata(pdf, {
      title: vm.documentTitle,
      author: vm.meta.author,
      subject: vm.meta.subject,
      keywords: vm.meta.keywords,
      language: vm.locale,
    });

    return { format: 'pdf', content, extension: 'pdf', pages };
  } finally {
    await browser.close();
  }
}

export const pdfRenderer: Renderer = { format: 'pdf', extension: 'pdf', render };

/**
 * Cuenta páginas con pdfjs-dist.
 *
 * El build por defecto de pdfjs asume APIs de browser (`DOMMatrix`) y explota
 * en Node; el build `legacy` es el que corresponde. Se importa en diferido
 * para no pagar su costo de carga en cada arranque del CLI.
 */
export async function countPages(pdf: Buffer): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Copia defensiva: pdfjs se queda con el ArrayBuffer y lo deja inutilizable
  // para el resto del pipeline, que todavía tiene que firmar y escribir estos
  // mismos bytes.
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: false,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });

  try {
    const document = await task.promise;
    return document.numPages;
  } finally {
    await task.destroy();
  }
}

/** HeadlessChrome en /Creator delata la herramienta y no dice nada útil. */
function scrubToolName(value: string | undefined, fallback: string): string {
  if (!value || /headless\s*chrome/i.test(value)) return fallback;
  return value;
}

/**
 * Post-proceso del PDF: metadatos del documento y fechas fijas.
 *
 * Toda la superficie de pdf-lib del proyecto pasa por esta función. La
 * librería está congelada desde 2021, así que reemplazarla tiene que costar
 * una sola reescritura y no un rastreo por todo el pipeline.
 */
export async function applyPdfMetadata(pdf: Buffer, meta: PdfMetadata): Promise<Buffer> {
  // updateMetadata:false es obligatorio: por defecto pdf-lib pisa /Producer y
  // /ModDate con la hora actual, que es exactamente lo que rompe el hash.
  const document = await PDFDocument.load(new Uint8Array(pdf), { updateMetadata: false });

  // showInWindowTitleBar activa /ViewerPreferences /DisplayDocTitle: el visor
  // muestra el título del documento y no el nombre del archivo.
  document.setTitle(meta.title, { showInWindowTitleBar: true });
  document.setAuthor(meta.author);
  document.setSubject(meta.subject);
  document.setKeywords(meta.keywords);
  document.setCreator(scrubToolName(meta.creator, DEFAULT_CREATOR));
  document.setProducer(scrubToolName(meta.producer, DEFAULT_PRODUCER));
  if (meta.language) document.setLanguage(meta.language);
  document.setCreationDate(FIXED_PDF_DATE);
  document.setModificationDate(FIXED_PDF_DATE);

  return Buffer.from(await document.save({ useObjectStreams: false }));
}

export default pdfRenderer;
