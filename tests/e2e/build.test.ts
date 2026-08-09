import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { extractDual } from '../../src/pdf/extract.ts';

/**
 * Verificación de punta a punta: se genera el CV con el CLI real y se comprueba
 * el artefacto, no una simulación.
 *
 * La comprobación central es la que ningún test de unidad puede hacer: que el
 * texto que un ATS extrae del PDF sea el mismo que el sistema dice haber
 * escrito. Todo lo demás del pipeline puede estar bien y aun así el PDF llegar
 * ilegible al otro lado.
 */

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'out', '.test-e2e');

async function build(): Promise<{ pdf: Buffer; txt: string }> {
  await rm(outDir, { recursive: true, force: true });
  await run(
    process.execPath,
    [
      path.join(root, 'src', 'cli.ts'),
      'build',
      'jane-doe',
      '--target',
      'backend-senior-en',
      '--out-dir',
      outDir,
      '--no-color',
    ],
    { cwd: root, timeout: 240_000 },
  );
  const base = 'Jane-Doe-Senior-Backend-Engineer-Resume';
  return {
    pdf: await readFile(path.join(outDir, `${base}.pdf`)),
    txt: await readFile(path.join(outDir, `${base}.txt`), 'utf8'),
  };
}

describe('build end-to-end', () => {
  it('genera un PDF cuyo texto extraído coincide con el TXT', { timeout: 300_000 }, async () => {
    const { pdf, txt } = await build();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const extraction = await extractDual(pdf);

    // ATS-050: todo token del ground truth textual sobrevive en el PDF.
    const normalize = (s: string) =>
      s
        .normalize('NFC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .split(' ')
        .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter((t) => t.length > 1);

    const expected = new Set(normalize(txt));
    const got = new Set(normalize(extraction.stream));
    const missing = [...expected].filter((t) => !got.has(t));

    expect(missing, `tokens que no llegaron al PDF: ${missing.slice(0, 15).join(', ')}`).toEqual([]);
  });

  it('el nombre encabeza el texto extraído y el contacto está arriba', { timeout: 300_000 }, async () => {
    const { pdf } = await build();
    const { stream } = await extractDual(pdf);
    const lines = stream.split('\n').filter((l) => l.trim() !== '');

    // Si algo desplaza al nombre (un margin-box de @page, un stacking context),
    // un ATS que toma la primera línea como nombre registra otra cosa.
    expect(lines[0]).toContain('Jane Doe');
    expect(lines.slice(0, 5).join(' ')).toMatch(/@/);
  });

  it('el orden de lectura no depende del extractor', { timeout: 300_000 }, async () => {
    const { pdf } = await build();
    const { stream, sorted } = await extractDual(pdf);

    // Los extractores reales se dividen en dos familias que dan resultados
    // opuestos ante floats y columnas. El CV tiene que leerse igual en ambas.
    const headings = ['SUMMARY', 'SKILLS', 'EXPERIENCE', 'EDUCATION'];
    const orderIn = (text: string) =>
      headings.map((h) => text.toUpperCase().indexOf(h)).filter((i) => i >= 0);

    const a = orderIn(stream);
    const b = orderIn(sorted);
    expect(a.length).toBeGreaterThan(2);
    expect([...a].sort((x, y) => x - y)).toEqual(a);
    expect([...b].sort((x, y) => x - y)).toEqual(b);
  });
});
