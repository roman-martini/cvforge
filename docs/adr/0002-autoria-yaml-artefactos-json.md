# ADR-0002 — Autoría en YAML, un archivo por sección, artefactos en JSON

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

Los datos los edita **un humano** y viven en git. Eso impone tres requisitos que no son negociables:

1. **Diffs legibles**, para que un cambio de un bullet se vea como un cambio de un bullet.
2. **Comentarios**, para justificar por qué un bullet está redactado así, de dónde salió una métrica,
   o para "apagar" un ítem sin borrarlo.
3. **Strings multilínea** cómodos, porque los resúmenes y los bullets largos son texto de verdad.

## Opciones evaluadas

**JSON.** Sin comentarios; una coma colgante rompe el archivo entero; los strings multilínea son
`\n` concatenados. Inaceptable para autoría manual.

**TOML.** Los arrays de tablas anidadas son hostiles justo donde el modelo los necesita:
`work[].positions[]` y `work[].bullets[]` quedan ilegibles.

**Markdown + frontmatter.** Agrega una capa de parsing sin ningún beneficio: los bullets son datos
estructurados, no prosa.

**YAML.** Cumple los tres requisitos. Trae sus propias trampas, que se documentan abajo.

## Decisión

**YAML 1.2 core** para autoría, con el parser **`yaml` (eemeli) v2.9**, un archivo por sección dentro
de `people/<slug>/profile/`. JSON queda **sólo como artefacto compilado** en `out/`, gitignored.

## Consecuencias

- **Nunca** pasarle `{ version: '1.1' }` al parser. Verificado: con 1.1 aparece el *Norway problem*
  (`NO` → `false`), `2023-04-01` se convierte en un objeto `Date` y `01234` se lee como octal `668`.
  Con el default 1.2 core, nada de eso ocurre.
- Peligros que **sí** existen en 1.2 y se mitigan tipando estricto en Zod: `phone: +5491155555555`
  se parsea como número y pierde el `+`; `postalCode: 01234` se vuelve `1234`; `score: 4.0` se
  vuelve `4`. **Prohibido** tipar esos campos como `z.union([z.string(), z.number()])`: eso convierte
  un fallo ruidoso en uno silencioso.
- Todos los objetos del schema se declaran con **`z.strictObject()`**, no `z.object()`. Verificado:
  `z.toJSONSchema()` en modo `io: 'input'` **no** emite `additionalProperties: false` para
  `z.object`, y el YAML **es** el input — con `z.object`, un `sumary:` mal escrito se descarta en
  silencio y el CV sale sin resumen sin que nada falle.
- Se commitea `.gitattributes` con `* text=auto eol=lf` en el **commit inicial**. En esta máquina
  `core.autocrlf=true` está activo, y sin eso los golden tests fallan con un diff del 100 % de las
  líneas el primer día.
- Se commitea `.vscode/settings.json` con `yaml.schemas` por glob apuntando a
  `schemas/generated/*.json`, **para overridear el auto-binding de SchemaStore**, que mapea
  `**/resume.yaml` y `**/resume.json` al JSON Resume v1.0.0 draft-04 archivado (que además tiene
  `additionalProperties: false` en la raíz) y llenaría el editor de errores falsos.
- Un archivo por sección mantiene los diffs acotados y permite abrir sólo lo que se está editando.
