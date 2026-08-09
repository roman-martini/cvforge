# ADR-0006 — Verificación ATS: extracción dual del PDF en Node puro

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

Un PDF no tiene "texto en orden": tiene un content stream con operaciones de dibujo. Cómo se
reconstruye el texto a partir de ahí es una decisión de cada extractor, y los extractores del mercado
se dividen en **dos familias que dan resultados opuestos para el mismo archivo**:

| Familia | Cómo ordena | Quiénes |
|---|---|---|
| Orden de content stream | El orden en que Chrome pintó los objetos | PDFBox con `setSortByPosition(false)` (su default), pypdf, PyMuPDF por default |
| Orden geométrico | y descendente, luego x | `pdftotext` sin flags, PDFBox con `sortByPosition(true)`, PyMuPDF con `sort=True` |

**No se sabe cuál usa el ATS de turno**, y no hay forma de averiguarlo. Peor: la causa raíz del
problema es CSS 2.1 Apéndice E — Chrome emite el content stream en **orden de pintado**, no de DOM —
así que propiedades absolutamente rutinarias en un template de CV (`float: right` en la fecha,
`position: relative` decorativo, `opacity: 0.7` en un texto atenuado) desprenden elementos de su
entrada y los reubican en el texto extraído. El PDF se ve impecable.

## Opciones evaluadas

**Testear contra un solo extractor.** Verde con uno, rojo con el otro, y no se sabe cuál importa.

**Apache Tika o PyMuPDF vía subprocess.** Introduce Java o Python en el camino crítico, contra la
decisión de ADR-0004 de mantener todo el pipeline en Node.

**`pdf-parse`.** Descartado: la v2 es una reescritura completa de la API y todos los snippets que
circulan son de la v1, incompatible. Elegir una librería cuya documentación efectiva está mal es
elegir mantenimiento.

**`pdfjs-dist` con extracción dual.**

## Decisión

El linter extrae con **`pdfjs-dist`** (el motor de Firefox, mantenido por Mozilla) y produce **los
dos órdenes**:

1. El orden natural del array `items` — equivalente al content stream.
2. Uno reconstruido ordenando por `(-transform[5], transform[4])` con tolerancia de línea —
   equivalente al position-sorted.

**Si el orden lógico difiere entre ambos, el build FALLA** (regla ATS-051).

## Consecuencias

- Ese único test detecta, de una sola vez: `float`, layouts de dos columnas, `position: fixed`,
  margin-boxes de `@page`, `order` de flexbox y cualquier `*-reverse`. No hace falta una regla por
  patrón: se testea el efecto, no la causa.
- Se elimina la dependencia de Python, PyMuPDF y Apache Tika del camino crítico. `pdfjs-dist` también
  aporta el conteo de páginas que necesita el fit-loop.
- `pdfjs-dist` expone `items[].transform`, que es exactamente lo que hace posible reconstruir el
  orden geométrico. No todas las librerías de extracción lo exponen.
- El test de orden **no** cubre todo: `opacity: 0.7` en las fechas desprende cada fecha de su entrada
  sin alterar el orden relativo de las secciones. Por eso existe además ATS-052, que verifica
  **proximidad**: título, empresa y fecha de una misma entrada tienen que caer dentro de una ventana
  de seis líneas.
- Costo aceptado: el linter tarda lo que tarda parsear el PDF dos veces. Son décimas de segundo
  contra la alternativa de enterarse por el silencio del reclutador.
