import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { LintReport, LintFinding, ResolvedCV, ViewModel } from '../core/types.ts';
import type { ResolvedProfileConfig } from '../core/schema/config.ts';
import type { PersonProfile, Eligibility } from '../core/schema/sections.ts';
import type { Questions, CoverLetter } from '../core/schema/tailoring.ts';
import { extractDual } from '../pdf/extract.ts';
import type { DualExtraction } from '../pdf/extract.ts';
import { lintTheme } from './css.ts';
import { lintPdf } from './pdf.ts';
import { lintText } from './text.ts';
import { lintDocx } from './docx.ts';
import { lintData } from './data.ts';
import { lintEthics } from './ethics.ts';

/**
 * Punto de entrada único del linter.
 *
 * Cada batería tiene la forma de entrada que le conviene: la de CSS quiere las
 * hojas de estilo, la de PDF quiere el binario y el papel esperado, la de datos
 * quiere el modelo. Este módulo traduce el contexto común de una corrida a esas
 * formas, para que quien lo invoque no tenga que conocer seis contratos.
 *
 * También decide qué baterías tienen sentido: sin PDF generado no se corren las
 * reglas del PDF, y saltearlas se REPORTA — una batería omitida en silencio se
 * lee igual que una batería en verde, que es justo lo que no queremos.
 */

export type LintContext = {
  root: string;
  themeDir: string;
  locale: string;
  paper: 'A4' | 'Letter';
  maxPages: number;
  documentTitle: string;
  /** El ground truth textual: todo token de acá tiene que sobrevivir en PDF y DOCX. */
  txt: string;
  pdf?: Buffer;
  docx?: Buffer;
  profile?: PersonProfile;
  resolved?: ResolvedCV;
  viewModel?: ViewModel;
  config?: ResolvedProfileConfig;
  eligibility?: Eligibility;
  questions?: Questions;
  coverLetter?: CoverLetter;
  companyName?: string;
  region?: string;
  referencedIds?: string[];
  i18n?: Record<string, Record<string, unknown>>;
  expectedFonts?: string[];
};

export type BatteryName = 'css' | 'data' | 'ethics' | 'pdf' | 'text' | 'docx';

export const BATTERIES: readonly BatteryName[] = ['css', 'data', 'ethics', 'pdf', 'text', 'docx'];

const skipped = (format: LintReport['format'], why: string): LintReport => ({
  format,
  findings: [
    {
      rule: 'LINT-SKIP',
      severity: 'warning',
      message: `Batería omitida: ${why}.`,
      fix: 'Generá el artefacto correspondiente con `cv build` para que esta batería corra.',
    },
  ],
  passed: true,
});

/** Lee las hojas de estilo del tema en orden de cascada. */
async function readThemeCss(themeDir: string): Promise<Array<{ name: string; css: string }>> {
  const order = ['tokens.css', 'print.css', 'screen.css'];
  let names: string[];
  try {
    names = (await readdir(themeDir)).filter((f) => f.endsWith('.css'));
  } catch {
    return [];
  }
  names.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
  const out: Array<{ name: string; css: string }> = [];
  for (const name of names) {
    out.push({ name, css: await readFile(path.join(themeDir, name), 'utf8') });
  }
  return out;
}

/**
 * Anclas de experiencia para la regla de proximidad.
 *
 * Salen del ViewModel y no del ResolvedCV porque la comprobación se hace contra
 * el texto extraído del PDF: hay que comparar contra el rango de fecha tal como
 * quedó impreso ("March 2022 – Present"), no contra la fecha cruda del modelo.
 */
function workAnchors(vm: ViewModel | undefined) {
  if (!vm) return [];
  return vm.sections
    .filter((section) => section.name === 'work')
    .flatMap((section) =>
      section.entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        company: entry.subtitle,
        dateRange: entry.dateRange,
      })),
    );
}

export async function runLint(
  context: LintContext,
  only?: readonly BatteryName[],
): Promise<LintReport[]> {
  const wanted = only ?? BATTERIES;
  const reports: LintReport[] = [];

  // La extracción del PDF se hace UNA vez y se comparte entre las baterías de
  // PDF y de texto: parsear el documento dos veces cuesta y puede divergir.
  let extraction: DualExtraction | undefined;
  if (context.pdf) {
    extraction = await extractDual(context.pdf);
  }

  for (const battery of wanted) {
    switch (battery) {
      case 'css': {
        const sources = await readThemeCss(context.themeDir);
        if (sources.length === 0) {
          reports.push(skipped('css', `no se encontraron hojas de estilo en ${context.themeDir}`));
          break;
        }
        reports.push(
          await lintTheme({
            sources: sources.map((s) => ({ name: s.name, css: s.css })),
            options: { fontsDir: path.join(context.root, 'assets', 'fonts') },
          }),
        );
        break;
      }

      case 'data': {
        if (!context.profile) {
          reports.push(skipped('data', 'no se cargó el perfil'));
          break;
        }
        reports.push(
          lintData({
            profile: context.profile,
            resolved: context.resolved,
            vm: context.viewModel,
            config: context.config,
            locale: context.locale,
            i18n: context.i18n ?? {},
            referencedIds: context.referencedIds ?? [],
          }),
        );
        break;
      }

      case 'ethics': {
        reports.push(
          lintEthics({
            profile: context.profile,
            resolved: context.resolved,
            eligibility: context.eligibility ?? context.profile?.eligibility,
            questions: context.questions,
            coverLetter: context.coverLetter,
            companyName: context.companyName,
          }),
        );
        break;
      }

      case 'pdf': {
        if (!context.pdf) {
          reports.push(skipped('pdf', 'no hay PDF generado en esta corrida'));
          break;
        }
        reports.push(
          await lintPdf(context.pdf, {
            paper: context.paper,
            maxPages: context.maxPages,
            locale: context.locale,
            region: context.region,
            expectedFonts: context.expectedFonts,
            forbiddenTitleTerms: context.companyName ? [context.companyName] : [],
            extraction,
          }),
        );
        break;
      }

      case 'text': {
        if (!extraction) {
          reports.push(skipped('txt', 'no hay PDF del cual extraer texto'));
          break;
        }
        const vm = context.viewModel;
        reports.push(
          lintText({
            plainText: context.txt,
            extraction,
            headings: vm?.sections.map((s) => s.heading),
            name: vm?.header.name ?? context.resolved?.contact.name ?? '',
            email: context.resolved?.contact.email ?? '',
            phone: context.resolved?.contact.phone,
            urls: context.resolved?.contact.profiles.map((p) => p.display),
            entries: workAnchors(vm),
            // Un título por entrada de experiencia, no uno por posición: dentro
            // de una misma empresa las promociones se listan del cargo actual
            // hacia atrás, así que exigir orden entre ellas marcaría como error
            // de lectura lo que es la convención correcta para una promoción.
            jobTitles: vm?.sections
              .filter((s) => s.name === 'work')
              .flatMap((s) => s.entries.map((e) => e.title)),
          }),
        );
        break;
      }

      case 'docx': {
        if (!context.docx) {
          reports.push(skipped('docx', 'no hay DOCX generado en esta corrida'));
          break;
        }
        reports.push(
          lintDocx(context.docx, {
            plainText: context.txt,
            email: context.resolved?.contact.email,
            phone: context.resolved?.contact.phone,
          }),
        );
        break;
      }
    }
  }

  return reports;
}

/** Alias con el nombre que espera el despacho por batería del CLI. */
export const lintCss = lintTheme;

export function summarize(reports: readonly LintReport[]): {
  errors: number;
  warnings: number;
  passed: boolean;
  findings: LintFinding[];
} {
  const findings = reports.flatMap((r) => r.findings);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { errors, warnings, passed: errors === 0, findings };
}

export { lintTheme, lintPdf, lintText, lintDocx, lintData, lintEthics };
