import type { OutputFormat } from '../core/schema/tailoring.ts';
import type { RenderOptions, RenderResult, Renderer, ResolvedCV, ViewModel } from '../core/types.ts';
import { docxRenderer } from './docx.ts';
import { htmlRenderer } from './html.ts';
import { createJsonResumeRenderer } from './jsonresume.ts';
import { mdRenderer } from './md.ts';
import { txtRenderer } from './txt.ts';

/**
 * Registro de renderers.
 *
 * Todos parten del MISMO ViewModel y ninguno se deriva de otro: PDF, DOCX, TXT,
 * MD y HTML son hermanos. La única excepción de origen es `jsonresume`, que se
 * proyecta desde el `ResolvedCV` porque necesita las fechas en ISO y los ids
 * estables, dos cosas que el ViewModel ya no tiene (las formateó y las
 * consumió). Por eso `getRenderer` acepta el `ResolvedCV`.
 */

export { docxRenderer } from './docx.ts';
export { htmlRenderer } from './html.ts';
export { mdRenderer } from './md.ts';
export { txtRenderer } from './txt.ts';
export { createJsonResumeRenderer, toJsonResume } from './jsonresume.ts';

/**
 * El PDF es el único renderer con dependencia pesada (Playwright + Chromium).
 * Se carga con un import dinámico para que el CLI no pague ese arranque cuando
 * sólo se piden TXT, MD o JSON: sin build step, cada import del árbol es tiempo
 * de arranque real.
 */
const lazyPdfRenderer: Renderer = {
  format: 'pdf',
  extension: 'pdf',
  async render(vm: ViewModel, opts?: RenderOptions): Promise<RenderResult> {
    const { pdfRenderer } = await import('./pdf.ts');
    return pdfRenderer.render(vm, opts);
  },
};

/** Los renderers que se construyen enteros a partir del ViewModel. */
export const renderers: Record<Exclude<OutputFormat, 'jsonresume'>, Renderer> = {
  pdf: lazyPdfRenderer,
  docx: docxRenderer,
  txt: txtRenderer,
  md: mdRenderer,
  html: htmlRenderer,
};

export function getRenderer(format: OutputFormat, cv?: ResolvedCV): Renderer {
  if (format === 'jsonresume') {
    if (!cv) {
      throw new Error(
        'El renderer de JSON Resume necesita el ResolvedCV: el ViewModel ya no tiene las fechas ISO ni los ids que exige el schema oficial. Llamalo como getRenderer("jsonresume", cv).',
      );
    }
    return createJsonResumeRenderer(cv);
  }
  return renderers[format];
}

/** Resuelve varios formatos de una, en el orden pedido. */
export function getRenderers(formats: readonly OutputFormat[], cv?: ResolvedCV): Renderer[] {
  return formats.map((format) => getRenderer(format, cv));
}
