# ADR-0009 — Renderers como plugins sobre un ViewModel único

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

La arquitectura que uno dibuja primero es una plantilla HTML y, de ahí, conversión a PDF, a DOCX y a
texto. Es intuitiva y está mal.

**El HTML no puede ser la fuente intermedia universal.** Convertir HTML a DOCX con `html-docx-js` o
cualquier librería basada en `altChunk` produce un archivo del que **todo parser headless extrae cero
caracteres**: cero runs `<w:t>`, con el contenido entero dentro de `word/afchunk.mht` en
quoted-printable, formato que sólo Microsoft Word sabe resolver.

Es el peor fallo posible de todo el sistema: el autor abre el archivo en Word, lo ve impecable, lo
envía, y del otro lado se recibe un documento vacío. Nada se pone rojo en ningún lado.

El TXT tiene un problema simétrico y menos evidente: **tampoco puede derivarse del PDF**. Chrome
dibuja los marcadores de `<ul><li>` como paths vectoriales, no como texto, así que un TXT extraído
del PDF perdería todos los bullets.

## Opciones evaluadas

**HTML como pivote, con conversores por formato.** El modo de falla descrito arriba. Descartada.

**Un renderer independiente por formato, cada uno leyendo el modelo de datos crudo.** Elimina el
pivote pero duplica todo el formateo derivado: cada renderer formatearía las fechas por su cuenta,
con diferencias sutiles, y la regla de "un único patrón de fecha en todo el documento" se volvería
imposible de sostener.

**Renderers hermanos sobre un ViewModel común.**

## Decisión

Interfaz común: `render(vm: ViewModel, opts): Promise<RenderResult>` (tipo `Renderer` en
`src/core/types.ts`).

**Todo formateo derivado** —rangos de fecha localizados, orden de secciones, labels del mercado,
truncados, elección de variante, transliteración— vive en la etapa **ViewModel**. Los renderers sólo
mapean estructura a la sintaxis de su formato.

Cada unidad de texto viaja con su `SemanticRole` (`name`, `section`, `role`, `company`, `date`,
`bullet`, `paragraph`, `meta`, `link`), que cada renderer traduce a lo suyo: `<h2>` en HTML,
`Heading 2` en DOCX, mayúsculas subrayadas en TXT.

**Renderers de fase 1:** `pdf` (Chromium), `html` (autocontenido, con JSON-LD `Person`/`ProfilePage`
y el modelo embebido en un `<script type="application/json">`), `docx` (**nativo**, con la librería
`docx`), `txt`, `md`, `jsonresume`.

**Fase 2, opt-in:** `typst` (si aparece un requisito duro de PDF/UA-1 certificado), `linkedin`
(headline + About + descripciones), `email` (pitch de 120-150 palabras), `europass`.

## Consecuencias

- **PDF y DOCX se construyen en paralelo desde el paso 3 del plan de implementación.** Si el DOCX se
  posterga al final, el ViewModel se contamina con supuestos de HTML —anidamiento, atributos,
  unidades CSS— y rehacerlo cuesta mucho más que hacerlo bien la primera vez.
- Se declara **por contrato en el README** que el DOCX **no busca paridad visual con el PDF**. La
  documentación de Reactive Resume lo llama "expected behavior difference rather than a bug". Es un
  artefacto de una columna, con estilos nombrados estándar, semántico y editable.
- El TXT nace del ViewModel y **no emite `• `**. Si lo emitiera, el comparador de recall entre
  `cv.txt` y el texto extraído del PDF fallaría sistemáticamente por una diferencia puramente
  cosmética, y la regla se volvería ruido que se aprende a ignorar.
- Un renderer nuevo es un archivo que implementa una interfaz. No toca el pipeline ni los otros
  renderers.
- El fit-loop itera sobre densidades produciendo ViewModels distintos desde el mismo `ResolvedCV`:
  ajustar la tipografía nunca reabre la selección de hechos.
