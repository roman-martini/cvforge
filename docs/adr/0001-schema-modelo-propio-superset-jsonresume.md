# ADR-0001 — Schema de datos: modelo propio superset, JSON Resume como formato de intercambio

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

El workspace necesita un modelo de datos con IDs estables por ítem (sin ellos no hay overlays ni
i18n ni trazabilidad), internacionalización, variantes de texto, tipos estrictos y un bloque de
elegibilidad.

JSON Resume v1.3.1 (MIT, JSON Schema draft-07) es el estándar de facto: tiene ecosistema real —más
de 52 themes, `resume-cli`, conversores— y adoptarlo da interoperabilidad gratis. Pero como modelo
interno es inservible:

- **Cero campos `required`** en todo el schema.
- `additionalProperties: true` en todos los niveles: un campo mal escrito no falla nunca.
- **Sin IDs**: no hay forma de referenciar un bullet o una experiencia de manera estable.
- Sin i18n y sin variantes.
- Un pattern de fecha ISO-8601 que acepta `2024-02-31`.

Sin IDs estables, el tailoring determinista es imposible: un overlay tendría que referenciar por
índice de array o por coincidencia de texto, y ambas cosas se rompen al primer reordenamiento.

## Opciones evaluadas

**(A) JSON Resume puro como modelo interno.** Hereda todas las limitaciones anteriores. Descartada.

**(B) Schema desde cero, ignorando JSON Resume.** Se pierde interoperabilidad que no cuesta nada
conservar. Descartada.

**(C) MAC (getmanfred).** Modelo moderno y bien pensado, pero está bajo **CC-BY-SA-4.0**: es
copyleft, y derivar de él obliga a compartir en los mismos términos. Descartada **por licencia**, no
por diseño.

**(D) HR Open Standards 4.5 / Europass ELM v3.3.** Más de 500 propiedades, orientados a intercambio
B2B entre sistemas, sin ecosistema de autoría por humanos. Descartadas por peso.

**(E) Modelo propio superset + proyección a JSON Resume.**

## Decisión

**(E).** El modelo interno se define en **Zod v4** (`src/core/schema/`) como superset semántico de
JSON Resume, con:

- `id` estable y obligatorio en todo ítem de array.
- Fechas tipadas (`YearMonth`, `IsoDate`, `FlexDate`) con validación de **calendario real**.
- Union types para `level` y `fluency` (nunca `enum` de TypeScript, ver ADR-0004).
- `current: true` para empleo vigente.
- Bloques nuevos: `eligibility`, `bullets` con estructura XYZ, `visibility`, `provenance`, `variants`.

El compilador emite `resume.json` **100 % conforme al schema oficial draft-07**, proyectando las
extensiones: `id` → `x-id`, `tags` → `x-tags`.

## Consecuencias

- Se copian y **pinean ambos schemas oficiales** (`schema.json` y `job-schema.json` de
  `@jsonresume/schema@1.3.1`) en `schemas/vendor/`. Evidencia de que mutan en versiones menores:
  1.2.1 → 1.3.1 eliminó 20 `additionalItems: false`, y el job-schema pasó de draft-04 a draft-07.
- El CI valida la proyección contra la copia pinneada **y** contra la última publicada, para detectar
  drift sin que el drift rompa el build.
- Extensiones `x-` **sólo a nivel de ítem y dentro de `meta`**. Prohibido un bloque raíz `x-cv:`:
  falla contra el schema v1.0.0 draft-04 que SchemaStore bindea automáticamente en el editor.
- El compilador hace **strip obligatorio de claves `null` y string vacío** antes de serializar.
  `endDate: ''` y `endDate: null` fallan la validación oficial, y en YAML un `endDate:` pelado
  produce `null`: es el caso del 100 % de las personas empleadas.
- Se registra `meta.x-modelVersion` con SemVer y se mantiene `migrations/` versionado.
- Costo aceptado: hay que mantener la proyección y su test de conformidad. A cambio, "exportamos a
  JSON Resume" deja de ser una afirmación y pasa a ser una garantía verificada por el validador
  oficial.
