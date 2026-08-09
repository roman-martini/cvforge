# Arquitectura

El pipeline, etapa por etapa. Cada sección declara **qué entra**, **qué sale**, **en qué archivo
vive** y **qué invariante garantiza**. Al final, las dos decisiones estructurales que explican por
qué el pipeline tiene esta forma y no otra.

Principio rector: **el modelo de datos es la única fuente de verdad**. HTML, PDF, DOCX, TXT y JSON
Resume son proyecciones hermanas del modelo, nunca derivaciones unas de otras. El tailoring
selecciona y reordena hechos; jamás los inventa.

---

## Vista general

```
   ┌─ people/<slug>/profile/*.yaml       (estructura + narrativa en locale primario)
   ├─ people/<slug>/i18n/<locale>.yaml   (narrativa de los demás locales, por id)
   ├─ config/regions|industries|seniority/*.yaml
   ├─ people/<slug>/targets/<id>.yaml    (arquetipo reutilizable)
   └─ people/<slug>/applications/…/overlay.yaml + job.yaml
                    │
      ┌─────────────┴──────────────────────────────────────────────────┐
      │  1 load      src/core/load.ts        YAML  → objeto            │
      │  2 validate  src/core/schema/*.ts    objeto → PersonProfile    │
      │  3 i18n      src/core/i18n.ts        + narrativa del locale    │
      │  4 compose   src/core/compose.ts     → ResolvedProfileConfig   │
      │  5 match     src/core/match.ts       → match-report.md         │  (opcional, humano)
      │  6 select    src/core/select.ts      → ResolvedCV              │
      │  7 viewmodel src/core/viewmodel.ts   → ViewModel               │
      └─────────────┬──────────────────────────────────────────────────┘
                    │
   ┌────────────┬───┴────────┬────────────┬────────────┬───────────────┐
   ▼            ▼            ▼            ▼            ▼               ▼
 pdf.ts      docx.ts      txt.ts       md.ts       html.ts     jsonresume.ts
   │            │            │
   │  (fit-loop: src/core/fit.ts)
   └────────────┴────────────┴──────────────┐
                                            ▼
                             src/lint/{css,pdf,text,docx,data,ethics}.ts
                                            │
                                            ▼
                            post-proceso (src/pdf/meta.ts) → sent/ + meta.yaml
```

---

## 1 · load — YAML a objeto

**Entrada** los `.yaml` de `people/<slug>/profile/`, `i18n/`, `targets/`, `applications/` y `config/`.
**Salida** objetos JavaScript planos, sin validar.
**Archivo** `src/core/load.ts`.

Se usa el parser `yaml` (eemeli) con su default **YAML 1.2 core**. Nunca se le pasa
`{ version: '1.1' }`: en 1.1 aparece el *Norway problem* (`NO` → `false`), `2023-04-01` se convierte
en un objeto `Date` y `01234` se lee como octal `668`.

En 1.2 quedan trampas reales que **no** se mitigan en el parser sino tipando estricto en la etapa 2:
`phone: +5491155555555` se parsea como número y pierde el `+`; `postalCode: 01234` se vuelve `1234`;
`score: 4.0` se vuelve `4` y se imprime `"4"`.

Los errores citan archivo, línea y clave. Un error de carga que sólo diga "invalid YAML" obliga al
autor a bisecar a mano y es, en la práctica, un error inservible.

## 2 · validate — objeto a `PersonProfile`

**Entrada** los objetos de la etapa 1.
**Salida** `PersonProfile` (`src/core/schema/sections.ts`), o una lista de errores con el path exacto.
**Archivos** `src/core/schema/{primitives,sections,tailoring,config}.ts` + `refine.ts`.

Zod es la **única** fuente de verdad de la forma de los datos: de él salen los tipos de TypeScript,
la validación en runtime y —vía `z.toJSONSchema()`— los JSON Schema que consume el editor.

Todo objeto se declara con **`z.strictObject`**. Con `z.object`, `z.toJSONSchema({ io: 'input' })` no
emite `additionalProperties: false`, y como el YAML **es** el input, un `sumary:` mal escrito se
descartaría en silencio: el CV saldría sin resumen y nada fallaría.

`refineProfile()` cubre lo que Zod no puede expresar campo a campo:

| Verificación | Por qué no alcanza el schema |
|---|---|
| `id` único en **todo** el perfil, no por sección | Los overlays referencian ids sin decir la sección; dos ids iguales hacen la selección ambigua y dependiente del orden de carga |
| Calendario real | El pattern ISO-8601 oficial acepta `2024-02-31` y `2020-19-39`. Se renderizan sin quejarse y el reclutador los lee como un descuido |
| `startDate <= endDate`, sin fechas futuras | Cruza dos campos |
| `current: true` ⇒ sin `endDate`; una sola posición vigente por empresa | Cruza ítems del mismo array |

`current: true` hace que el compilador **omita** la clave `endDate`, no que la emita vacía:
`endDate: ''` y `endDate: null` fallan la validación oficial de JSON Resume, y en YAML un `endDate:`
pelado produce `null`. Es el caso del 100 % de las personas empleadas.

## 3 · i18n — resolución narrativa por id

**Entrada** `PersonProfile` + `people/<slug>/i18n/<locale>.yaml` + el locale objetivo.
**Salida** `PersonProfile` con los campos narrativos en el locale pedido.
**Archivo** `src/core/i18n.ts`.

`profile/` guarda **toda** la estructura y la narrativa en `meta.primaryLocale`. `i18n/<locale>.yaml`
guarda **sólo** narrativa, indexada por el mismo `id`. La resolución es un lookup por id, no un
merge: no hay ambigüedad sobre qué gana.

**Sin fallback silencioso.** Si un `id` incluido en la selección no tiene traducción para el locale
objetivo, el build falla indicando id y campo. Un CV en inglés con un bullet en español que nadie
notó es peor que un error de build.

Traducibles: `basics.label`, `basics.summary`, `work[].summary`, `positions[].title`,
`bullets[].outcome|method|variants`, `skills[].level`, `languages[].fluency`, `education.area`,
`education.studyType`. **Nunca** traducibles: nombres de empresa, URLs, fechas, keywords técnicas e `id`.

## 4 · compose — configuración por ejes ortogonales

**Entrada** `config/regions/<r>.yaml` → `config/industries/<i>.yaml` → `config/seniority/<s>.yaml` → `targets/<slug>.yaml`.
**Salida** `ResolvedProfileConfig` (`src/core/schema/config.ts`).
**Archivo** `src/core/compose.ts`.

Región, industria y seniority son ejes **ortogonales que se componen**, nunca una matriz de
plantillas: 10 regiones × 7 industrias × 5 seniorities serían 350 plantillas; como ejes son 22
archivos.

El merge es de **objetos**, con `deepmerge-ts` (no muta, tipado). **Los arrays reemplazan, jamás
concatenan.** Un `sectionOrder` de industria que se concatenara al de región produciría un orden con
secciones repetidas y sin sentido. `lodash.merge` está prohibido porque muta su primer argumento;
`defu` también, porque sólo rellena faltantes —semántica de *defaults*, opuesta a la de un overlay.

El resultado decide papel, presupuesto de páginas, labels de sección en el idioma del mercado,
patrón único de fecha, política de referencias, política de color, campos prohibidos y la política
de ajuste (`FitPolicy`).

Un **campo prohibido rompe el build citando la fuente** (EEOC, OHRC, AEPD, gov.uk, SEEK). Nunca se
suprime en silencio: el punto es que el autor aprenda la convención del mercado, no que el sistema
la esconda.

## 5 · match — reporte de gap (opcional, decide un humano)

**Entrada** `PersonProfile` + `applications/<…>/job.yaml` + `config/taxonomy/skills.yaml`.
**Salida** `match-report.md`.
**Archivos** `src/core/match.ts` (léxico, default) y `src/core/match-semantic.ts` (opt-in).

Scorer nivel 1: normalización, resolución canónica por aliases y BM25 de
`(bullet.outcome + method + tags)` contra `requirement.text`, ponderado por `weight` y `kind`.
Determinista, sin descargas, apto para CI. Ponderación por ubicación:
**keyword-en-bullet > keyword-en-skills > keyword-en-summary**.

Nivel 2 (`all-MiniLM-L6-v2` local vía ONNX) comparte interfaz y es opt-in; nunca corre en CI.

La salida es un **reporte de gap accionable, no un puntaje**. La sección de mayor valor es
`EXCLUDED BUT RELEVANT`: qué tenés en el perfil que la vacante pide y tu variante no está incluyendo.
El humano lee el reporte y decide; el sistema no reescribe nada.

## 6 · select — `ResolvedCV`

**Entrada** `PersonProfile` (ya en locale) + `Target` + `Overlay`.
**Salida** `ResolvedCV` (`src/core/types.ts`).
**Archivo** `src/core/select.ts`.

Aplica `include` / `exclude` / `order` / `overrides` **por id** sobre el pool de hechos. El resultado
son los hechos elegidos y ordenados, **sin una sola decisión de formato**.

Invariantes:

- Un `id` referenciado y ausente **falla el build**. Nunca se ignora: un overlay que apunta a un
  bullet borrado tiene que enterarse en la consola, no en el PDF impreso.
- Los `overrides` sólo alcanzan campos narrativos (`summary`, selección y variante de bullets). Los
  hechos —empleador, fechas, títulos, educación— no tienen dónde escribirse desde un overlay.
- Ninguna variante seleccionada puede tener `provenance.source === 'llm_draft'`.

`ResolvedCV` es **el artefacto que se golden-testea**: es la última etapa donde una diferencia
significa "cambió qué se dice", y no "cambió cómo se ve".

## 7 · viewmodel — `ViewModel`

**Entrada** `ResolvedCV` + `ResolvedProfileConfig` + escalón de densidad.
**Salida** `ViewModel` (`src/core/types.ts`).
**Archivo** `src/core/viewmodel.ts`.

Acá vive **todo** el formateo derivado:

- Rangos de fecha en el patrón único del locale (`March 2022`, `03/2022`, `marzo 2022`). Un solo
  patrón en todo el documento, porque dos patrones distintos hacen que un parser con detección de
  locale interprete mal la mitad de las fechas.
- Labels de sección resueltos por el perfil regional (`Work Experience`, `Berufserfahrung`).
- Orden de secciones ya aplicado.
- Truncados y elección de variante `short`/`long` según el budget.
- Transliteración y desarmado de estructuras para el TXT.
- `documentTitle` neutro y determinista: `"Jane Doe — Resume"`. **Nunca** la empresa objetivo ni el
  identificador de la variante; Chrome copia el `<title>` literal a `/Title` y el reclutador lo ve en
  la barra del visor.
- El mapeo semántico compartido (`name`, `section`, `role`, `company`, `date`, `bullet`, `meta`,
  `link`) que cada renderer traduce a su medio.

`VMEntry` ya trae `title`, `dateRange`, `subtitle`, `meta` y `bullets` como strings listos. Un
renderer que necesite formatear una fecha es una señal de que algo se filtró a la capa equivocada.

## 8 · renderers

**Entrada** `ViewModel` + `RenderOptions`.
**Salida** `RenderResult` (`Buffer` para binarios, `string` para texto).
**Archivos** `src/renderers/{pdf,docx,txt,md,html,jsonresume}.ts`.

Interfaz única (`Renderer` en `src/core/types.ts`): `render(vm, opts) → Promise<RenderResult>`. Los
renderers **sólo mapean estructura a la sintaxis de su formato**.

| Renderer | Cómo |
|---|---|
| `pdf` | Template Preact → HTML → Chromium vía Playwright. `preferCSSPageSize: true`, `printBackground: true`, `tagged: true`, `outline: true`, **sin pasar `margin`** (es no-op frente a `@page`; los márgenes se controlan sólo en CSS) |
| `docx` | OOXML **nativo** con `docx` (dolanmiu), desde el ViewModel. Una columna, estilos nombrados estándar, sin tablas ni text boxes |
| `txt` | Ground truth del linter. **No emite `• `**: Chrome dibuja los marcadores de `<li>` como paths vectoriales, así que el PDF no los contiene y el comparador fallaría por una diferencia cosmética |
| `md` | Para revisión y diffs legibles |
| `html` | Autocontenido, con JSON-LD `Person`/`ProfilePage` y el modelo embebido. Emite la proyección *public-safe* |
| `jsonresume` | Proyección conforme al schema oficial draft-07: `id` → `x-id`, `tags` → `x-tags`, strip de `null` y string vacío |

El **fit-loop** (`src/core/fit.ts`) aplica sólo al PDF: recorre `densitySteps`
(`comfortable → normal → dense → ultra`), cuenta páginas y devuelve el primero que entra en el
budget. Si ninguno entra, aplica la política declarada en orden de sacrificio —`maxBulletsPerRole`,
`experienceCutoffYears`, `dropSections`— y si aún así no entra, **falla con un mensaje accionable**
("recortá educación: sobran 6 líneas"). Un presupuesto de páginas sin política de ajuste es un assert
que empuja al usuario a tocar el `font-size` a mano, reintroduciendo justo el acoplamiento
datos/presentación que este repo existe para evitar.

Los demás formatos se renderizan **en paralelo** desde el mismo ViewModel, no en cascada.

## 9 · lint

**Entrada** el CSS del tema, el PDF, el DOCX, `cv.txt` y el `PersonProfile`.
**Salida** `LintReport` por formato (`src/core/types.ts`).
**Archivos** `src/lint/{css,pdf,text,docx,data,ethics}.ts`, `src/pdf/{extract,inspect}.ts`.

Cinco baterías, con severidad `error` (falla el build) o `warning`:

| Batería | Qué detecta |
|---|---|
| `css.ts` | Propiedades que crean *stacking context* y desordenan el content stream: `float`, `position` ≠ `static` (incluido `relative`), `opacity` < 1, `transform`, `columns`, `order`, `justify`, `letter-spacing` > 0.12em, contacto en margin-boxes de `@page`, `@font-face` fuera de la allowlist |
| `pdf.ts` | `MediaBox` == papel del perfil, todo `/FontDescriptor` con su `/FontFile*`, fuentes == las del tema, páginas ≤ budget, `/Lang`, `/MarkInfo`, `/StructTreeRoot`, `/Title` sin nombre de empresa |
| `text.ts` | **Extracción dual**: el orden de content-stream y el reconstruido geométricamente deben coincidir. Recall 1.0 contra `cv.txt`. Proximidad título/empresa/fecha. Codepoints invisibles. Un solo patrón de fecha |
| `docx.ts` | Ausencia de `<w:altChunk>`, conteo de `<w:t>` > 0, sin tablas ni headers, estilos nombrados, mismo recall que el PDF |
| `data.ts` / `ethics.ts` | Ids únicos, fechas coherentes, campos prohibidos por región, provenance aprobada, respuestas consistentes con `eligibility` |

La **extracción dual** merece su párrafo. Los extractores del mercado se dividen en dos familias con
resultados **opuestos** para el mismo PDF: orden de content-stream y orden geométrico y-luego-x. No
se sabe cuál usa el ATS de turno. El linter produce los dos con `pdfjs-dist` y **falla si difieren**.
Ese único test detecta de una sola vez floats, dos columnas, `position: fixed`, margin-boxes, `order`
y `*-reverse`. Ver [ADR-006](adr/0006-verificacion-ats-extraccion-dual-pdf.md).

## 10 · post-proceso y registro

**Archivos** `src/pdf/meta.ts`, `applications/<…>/meta.yaml`.

Si el lint pasa: `pdf-lib` escribe `/Author`, `/Subject` y `/Keywords`, normaliza `/Creator` (que
por default dice `HeadlessChrome`) y fija `/CreationDate` y `/ModDate` a un valor determinista. El
PDF de Chromium es byte-idéntico entre corridas salvo esos timestamps, así que normalizarlos habilita
**golden testing por SHA-256**.

Después: nombre de archivo desde `fileNameTemplate`, copia a `sent/` (gitignored) y registro en
`meta.yaml` del SHA-256, el tamaño, las páginas, el `gitSha`, el tema y **la versión exacta del
browser**. Sin ese último dato no hay reproducibilidad: la paginación cambia entre versiones de
Chrome.

---

## Por qué `ResolvedCV` y `ViewModel` son dos etapas

Podrían ser una. No lo son porque contestan preguntas distintas y cambian por razones distintas.

`ResolvedCV` contesta **qué hechos entran y en qué orden**. Es el resultado del tailoring y depende
del overlay, del target y del perfil de configuración. Cuando cambia, cambió lo que el CV *dice*.

`ViewModel` contesta **cómo se presentan esos hechos**. Depende del locale, del mercado, del budget
de páginas y del escalón de densidad que eligió el fit-loop. Cuando cambia, cambió cómo se *ve*.

Tres consecuencias prácticas:

1. **El golden test tiene un lugar obvio.** Se testea `ResolvedCV`: un diff ahí siempre significa
   algo. Testear el ViewModel mezclaría cambios de contenido con cambios de tipografía.
2. **El fit-loop no reabre la selección.** Itera sobre densidades produciendo ViewModels distintos a
   partir del mismo `ResolvedCV`. Los hechos elegidos no dependen de cuántas páginas salieron.
3. **Un formato nuevo no reimplementa el formateo.** Si el formateo viviera en los renderers, cada
   uno formatearía las fechas por su cuenta y las diferencias serían sutiles: el PDF diría
   `March 2022` y el TXT `Mar 2022`. Entonces la regla ATS-061 —un único patrón de fecha en todo el
   documento— sería imposible de sostener, y la comparación de recall entre `cv.txt` y el PDF
   fallaría por una diferencia que nadie eligió.

`ViewModel` es además **agnóstico al medio**: `SemanticRole` viaja con cada unidad de texto y cada
renderer la traduce a lo suyo (`<h2>` en HTML, `Heading 2` en DOCX, mayúsculas subrayadas en TXT).
El rol nunca se pierde por el camino, que es exactamente lo que hace que el DOCX salga con estilos
nombrados de verdad y no con negritas sueltas.

---

## Por qué el HTML no es la fuente intermedia universal

Es la arquitectura que uno dibujaría primero: un template HTML, y de ahí a PDF, a DOCX y a texto.
Está mal, y el modo de falla es el peor posible.

Convertir HTML a DOCX con `html-docx-js` o cualquier librería basada en `altChunk` produce un
archivo del que **todo parser headless extrae cero caracteres**: cero runs `<w:t>`, con el contenido
entero metido en `word/afchunk.mht` en quoted-printable, que sólo Microsoft Word sabe resolver. El
autor abre el archivo en Word, lo ve impecable, lo manda, y del otro lado se recibe un documento
vacío. Nada en el pipeline se pone rojo.

El TXT tiene un problema simétrico y menos obvio: **no puede derivarse de la extracción del PDF**.
Chrome dibuja los marcadores de `<ul><li>` como paths vectoriales, no como texto, así que un TXT
derivado del PDF perdería todos los bullets. Por eso el TXT nace del ViewModel y no emite `• `; si
lo emitiera, el comparador de recall fallaría sistemáticamente por una diferencia cosmética.

De ahí la forma de [ADR-009](adr/0009-renderers-como-plugins-sobre-viewmodel.md): **renderers
hermanos sobre un ViewModel único**, con interfaz común, ninguno derivado de otro. Y el corolario de
planificación: PDF y DOCX se construyen **en paralelo desde el principio**. Si el DOCX se posterga al
final, el ViewModel se contamina con supuestos de HTML —anidamiento, atributos, unidades CSS— y
rehacerlo cuesta mucho más que hacerlo bien la primera vez.

El precio aceptado, y declarado por contrato en el README: **el DOCX no busca paridad visual con el
PDF**. Es un artefacto de una columna, semántico y editable. Si se pareciera, sería porque se generó
convirtiendo.

---

## Runtime

Node 24 ejecuta TypeScript nativamente (type stripping estable desde 24.12). **No hay build step, no
hay bundler, no hay workspaces.** TypeScript es exclusivamente `tsc --noEmit` en pre-commit y CI.

Consecuencias que el código respeta en todos lados:

- Los imports locales llevan **extensión `.ts` explícita**. Sin ella: `ERR_MODULE_NOT_FOUND`.
- Prohibidos `enum`, parameter properties, namespaces con valores y decoradores: Node los rechaza en
  runtime con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Se usa `as const` + union types.
- ESM puro. Nada de `require()`.
- `erasableSyntaxOnly: true` en el tsconfig hace que falle `tsc` en desarrollo en vez de Node en
  producción.
- Rutas siempre con `node:path`. El repo se desarrolla en Windows.

Ver [ADR-004](adr/0004-runtime-node-24-sin-build-step.md).
