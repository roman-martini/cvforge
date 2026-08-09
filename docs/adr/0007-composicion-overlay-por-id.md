# ADR-0007 — Composición de datos: overlay declarativo por ID, jamás merge de arrays

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

Un CV es, estructuralmente, casi todo arrays: `work`, `projects`, `skills`, `bullets`, `highlights`.
Y adaptar un CV a una vacante es una operación sobre esos arrays: mostrar estos tres roles, no
aquellos dos; poner este bullet primero.

Las herramientas estándar de composición fallan exactamente ahí:

- **RFC 7386 (JSON Merge Patch)** reemplaza arrays enteros y usa `null` como marca de borrado. Para
  cambiar el orden de un bullet hay que reescribir el array completo.
- El deep merge genérico concatena o pisa por índice, y ambas cosas son incorrectas: concatenar
  duplica entradas, pisar por índice hace que insertar un trabajo nuevo al principio corrompa todos
  los overlays existentes.

Eleventy **removió `setDataDeepMerge()` en la v4.0** precisamente por esta clase de problema.

## Opciones evaluadas

**RFC 7386.** Semántica de reemplazo total de arrays. Descartada.

**RFC 6902 (JSON Patch).** Control fino y correcto, pero ilegible para escribir a mano:
`{"op":"move","from":"/work/2/bullets/4","path":"/work/2/bullets/0"}` no es un formato de autoría.

**Deep merge con librería.** Ninguna semántica de merge de arrays es correcta para este caso.

**Selección declarativa por ID.**

## Decisión

**Cuatro capas de composición, con reglas distintas por capa:**

1. **Configuración** (`region` → `industry` → `seniority`): deep merge de **objetos** con
   `deepmerge-ts` (no muta, tipado, permite mergers custom). Los **arrays reemplazan**, nunca
   concatenan.
2. **i18n**: resolución por `id`, sin merge.
3. **Target / arquetipo** (`targets/<slug>.yaml`): capa intermedia reutilizable. Fija locale, región,
   industria, título objetivo, keywords canónicas, orden de secciones, budget, tema y template de
   nombre de archivo.
4. **Overlay por vacante** (`applications/<…>/overlay.yaml`): `extends: <target>` más
   `include[] / exclude[] / order[] / overrides{id:{}}`.

## Consecuencias

- El overlay es **selectivo y reordenador por diseño**. Los `overrides` sólo alcanzan campos
  narrativos y quedan diffeables contra el base, así que el fraude es **estructuralmente difícil**,
  no meramente desaconsejado (ver ADR-0011 y `docs/ETHICS.md`).
- El **80 % del trabajo de tailoring se hace una vez por arquetipo**. El diff por aplicación queda
  mínimo y auditable. Sin la capa de target, cada aplicación rehace el matching desde cero y el
  sistema deja de escalar justo cuando empieza a servir.
- **`lodash.merge` está prohibido**: muta su primer argumento. **`defu` también**: sólo rellena
  faltantes, que es semántica de *defaults*, exactamente la opuesta a la de un overlay. `deepmerge`
  a secas trata `Date`, `Map` y `Set` como objetos planos.
- Un `id` referenciado y ausente **falla el build**, no el PDF impreso. Un overlay que apunta a un
  bullet borrado tiene que enterarse en la consola.
- Costo aceptado: hay que mantener ids estables y no reciclarlos (ver `docs/CONTRIBUTING.md`). Es el
  precio de que reordenar sea una lista de ids y no un diff estructural.
