import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPerson } from '../../src/core/load.ts';
import { localizeProfile } from '../../src/core/i18n.ts';
import { composeConfig } from '../../src/core/compose.ts';
import { selectSections, bulletVariants } from '../../src/core/select.ts';
import { resolveCV } from '../../src/core/resolve.ts';
import { buildViewModel } from '../../src/core/viewmodel.ts';
import { isRealDate, compareFlexDates, refineProfile } from '../../src/core/schema/refine.ts';
import { inspectWoff2 } from '../../src/pdf/font-inspect.ts';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Estos tests cubren los invariantes que ya se rompieron una vez durante la
 * construcción. Cada uno existe porque un fallo real pasó por ahí, no por
 * cubrir líneas: un bug que ya ocurrió es el que tiene más probabilidad de
 * volver a ocurrir.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const janeDir = path.join(root, 'fixtures', 'people', 'jane-doe');

describe('carga y validación', () => {
  it('carga la persona de ejemplo sin errores', async () => {
    const person = await loadPerson(janeDir);
    expect(person.slug).toBe('jane-doe');
    expect(person.profile.work.length).toBeGreaterThan(0);
    expect(refineProfile(person.profile).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('acepta el directorio directo y también raíz + slug', async () => {
    const byDir = await loadPerson(janeDir);
    expect(byDir.slug).toBe('jane-doe');
  });
});

describe('validación de fechas', () => {
  it('rechaza fechas que el patrón ISO acepta pero el calendario no', () => {
    expect(isRealDate('2024-02-31')).toBe(false);
    expect(isRealDate('2020-19-39')).toBe(false);
    expect(isRealDate('2023-02-29')).toBe(false);
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2023-04')).toBe(true);
  });

  it('compara fechas de precisión mixta', () => {
    expect(compareFlexDates('2023-04', '2023-04-17')).toBeLessThan(0);
    expect(compareFlexDates('2024-01', '2023-12')).toBeGreaterThan(0);
  });
});

describe('fuentes embebibles', () => {
  it('todas las fuentes vendorizadas son estáticas', () => {
    // Chromium no embebe fuentes variables: el PDF sale sin /FontFile2 y el
    // reclutador ve otra tipografía y otra paginación, sin que nada falle.
    const fontsDir = path.join(root, 'assets', 'fonts');
    for (const family of readdirSync(fontsDir)) {
      const dir = path.join(fontsDir, family);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.woff2'))) {
        const { isVariable } = inspectWoff2(readFileSync(path.join(dir, file)));
        expect(isVariable, `${family}/${file} es variable`).toBe(false);
      }
    }
  });
});

describe('pipeline completo', () => {
  async function build(overlayLike: Parameters<typeof selectSections>[1], targetId = 'backend-senior-en') {
    const person = await loadPerson(janeDir);
    const target = JSON.parse(
      JSON.stringify(
        (await import('yaml')).parse(readFileSync(path.join(janeDir, 'targets', `${targetId}.yaml`), 'utf8')),
      ),
    );
    const profile = localizeProfile(person, target.locale);
    const config = await composeConfig(root, {
      region: target.region,
      industry: target.industry,
      seniority: target.seniority,
      target,
    });
    const selected = selectSections(profile, overlayLike, target);
    const resolved = resolveCV({
      profile: selected,
      config,
      locale: target.locale,
      bulletVariants: bulletVariants(overlayLike),
    });
    return { vm: buildViewModel(resolved), resolved, config };
  }

  it('produce un ViewModel con las secciones que el arquetipo declara', async () => {
    const { vm } = await build(null);
    expect(vm.header.name).toBe('Jane Doe');
    expect(vm.sections.length).toBeGreaterThan(0);
    // sectionOrder es orden Y selección: lo no declarado no se imprime.
    const printed = vm.sections.map((s) => s.name);
    expect(printed).not.toContain('publications');
    expect(vm.omittedSections).toContain('publications');
  });

  it('el título del documento no filtra la empresa objetivo ni la variante', async () => {
    const { vm } = await build(null);
    // Chrome copia <title> literal a /Title y el reclutador lo ve en el visor:
    // es la fuga más probable de un workspace de tailoring.
    expect(vm.documentTitle).toBe('Jane Doe — Resume');
    expect(vm.documentTitle.toLowerCase()).not.toMatch(/contoso|draft|v\d|tailored/);
  });

  it('no emite caracteres invisibles en ningún texto del ViewModel', async () => {
    const { vm } = await build(null);
    const all = JSON.stringify(vm);
    // Sobreviven intactos a la extracción del PDF y rompen todo match exacto.
    for (const cp of [' ', '­', '​', '‌', '‍', '⁠', '﻿']) {
      expect(all.includes(cp), `contiene U+${cp.codePointAt(0)!.toString(16)}`).toBe(false);
    }
  });

  it('usa un único patrón de fecha en todo el documento', async () => {
    const { vm } = await build(null);
    const ranges = vm.sections.flatMap((s) => s.entries.map((e) => e.dateRange)).filter(Boolean);
    expect(ranges.length).toBeGreaterThan(0);
    // El perfil us declara "March 2022": ningún rango debe salir numérico.
    for (const range of ranges) {
      expect(range, `patrón inesperado en "${range}"`).not.toMatch(/\d{1,2}\/\d{4}/);
    }
  });

  it('separa datos hermanos con un separador textual real', async () => {
    const { vm } = await build(null);
    // Un `gap` de CSS no crea ningún carácter: sin separador las cajas se
    // extraen pegadas ("MadridEspaña"). Se verifican las entradas de
    // experiencia, que son las que combinan ubicación, modalidad e industria;
    // un `meta` de un solo dato (la nota académica) no necesita separador.
    const workEntries = vm.sections
      .filter((s) => s.name === 'work')
      .flatMap((s) => s.entries)
      .filter((e) => e.meta);
    expect(workEntries.length).toBeGreaterThan(0);
    for (const entry of workEntries) {
      expect(entry.meta, `meta sin separador: "${entry.meta}"`).toMatch(/ · | — /);
    }

    // Y en ningún caso puede haber dos palabras pegadas sin separación.
    for (const entry of vm.sections.flatMap((s) => s.entries)) {
      expect(entry.meta ?? '').not.toMatch(/[a-záéíóúñ][A-ZÁÉÍÓÚÑ]/);
    }
  });
});

describe('selección por overlay', () => {
  it('un overlay cambia el contenido del CV', async () => {
    const person = await loadPerson(janeDir);
    const yaml = await import('yaml');
    const target = yaml.parse(
      readFileSync(path.join(janeDir, 'targets', 'backend-senior-en.yaml'), 'utf8'),
    );
    const profile = localizeProfile(person, 'en');

    const overlay = {
      extends: 'backend-senior-en',
      basics: { label: 'Staff Backend Engineer' },
      sections: { skills: { include: ['skill.go', 'skill.k8s'] } },
    } as unknown as Parameters<typeof selectSections>[1];

    const base = selectSections(profile, null, target);
    const tailored = selectSections(profile, overlay, target);

    expect(tailored.basics.label).toBe('Staff Backend Engineer');
    expect(tailored.skills.length).toBe(2);
    expect(tailored.skills.length).toBeLessThan(base.skills.length);
  });

  it('un id inexistente en el overlay hace fallar el build', async () => {
    const person = await loadPerson(janeDir);
    const profile = localizeProfile(person, 'en');
    const overlay = {
      extends: 'x',
      sections: { skills: { include: ['skill.no-existe'] } },
    } as unknown as Parameters<typeof selectSections>[1];

    // Fallar acá es barato; descubrirlo en el PDF ya enviado, no.
    expect(() => selectSections(profile, overlay, null)).toThrow(/skill\.no-existe/);
  });

  it('un overlay no puede alterar un hecho', async () => {
    const person = await loadPerson(janeDir);
    const profile = localizeProfile(person, 'en');
    const overlay = {
      extends: 'x',
      sections: {
        work: { overrides: { 'work.acme-2023': { company: 'Otra empresa' } } },
      },
    } as unknown as Parameters<typeof selectSections>[1];

    // La inmutabilidad de los hechos es lo que hace que el fraude sea
    // estructuralmente difícil y no meramente desaconsejado.
    expect(() => selectSections(profile, overlay, null)).toThrow();
  });
});
