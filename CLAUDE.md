# CLAUDE.md — instrucciones para Claude Code en este repo

## La arquitectura en 10 líneas

1. Los datos del CV viven una sola vez, en YAML versionado bajo `people/<slug>/profile/`.
2. El formato es una **proyección**: PDF, DOCX, TXT, MD, HTML y JSON Resume son hermanos, ninguno se
   deriva de otro.
3. Adaptar a una vacante es **seleccionar y reordenar hechos por `id`**, nunca reescribirlos.
4. Pipeline: `load → validate → i18n → compose → select → ResolvedCV → viewmodel → ViewModel → renderers → lint`.
5. **`ResolvedCV`** = qué hechos entran y en qué orden, **sin formato**. Es lo que se golden-testea.
6. **`ViewModel`** = los mismos hechos ya formateados (fechas del locale, labels del mercado,
   truncados). Todo formateo derivado vive acá y **sólo** acá.
7. Los renderers mapean estructura → sintaxis de su formato. Nada más.
8. Región, industria y seniority son **ejes ortogonales que se componen**, no una matriz de plantillas.
9. El linter compara el texto extraído del PDF contra `cv.txt` en **dos órdenes de extracción**
   distintos; si difieren, falla.
10. Zod (`src/core/schema/`) es la única fuente de verdad de la forma de los datos: de ahí salen los
    tipos de TS, la validación en runtime y los JSON Schema del editor.

Detalle completo en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y [`docs/adr/`](docs/adr/).

## Reglas técnicas duras

Estas no son estilo. Romperlas hace fallar el runtime o produce fallos silenciosos.

- **Node 24 ejecuta TypeScript nativamente. No hay build step, ni bundler, ni workspaces.**
  TypeScript es sólo `tsc --noEmit`.
- **Imports locales con extensión `.ts` explícita**: `import { load } from './load.ts'`.
  Sin ella: `ERR_MODULE_NOT_FOUND`.
- **Prohibidos `enum`, parameter properties (`constructor(private x)`), namespaces con valores y
  decoradores.** Node los rechaza en runtime con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Se usa
  `as const` + union types.
- **ESM puro** (`"type": "module"`). Nada de `require()`.
- **Zod v4 con `z.strictObject` en todo objeto, nunca `z.object`.** Con `z.object`,
  `z.toJSONSchema({ io: 'input' })` no emite `additionalProperties: false`, y el YAML es el input: un
  campo mal escrito se descartaría en silencio.
- **`z.date()` prohibido**: es irrepresentable en JSON Schema. Las fechas son strings tipados
  (`YearMonth`, `IsoDate`, `FlexDate`).
- **Campos que YAML convertiría a número se tipan string estricto**, nunca
  `z.union([z.string(), z.number()])`: `phone`, `postalCode`, `score`, `credentialId`. Aceptar ambos
  tipos convierte un fallo ruidoso en uno silencioso.
- **Rutas siempre con `node:path`** (`path.join`). Nunca concatenar con `/` ni `\\`. Se desarrolla en
  Windows.
- **Comentarios y mensajes al usuario en español; identificadores de código en inglés.**
- **Se comenta el porqué**, las restricciones no obvias y las trampas verificadas. Comentar lo que
  hace la línea siguiente está prohibido.

## Dónde vive cada cosa

| Ruta | Qué |
|---|---|
| `src/core/schema/` | Zod: `primitives`, `sections`, `tailoring`, `config`, `refine`. **Contrato inmutable** |
| `src/core/types.ts` | `ResolvedCV`, `ViewModel`, `Renderer`, `LintFinding`, `LoadedPerson`. **Contrato inmutable** |
| `src/core/` | `load`, `i18n`, `compose`, `select`, `resolve`, `viewmodel`, `fit`, `match` |
| `src/renderers/` | Un archivo por formato, todos implementando `Renderer` |
| `src/themes/<tema>/` | `Template.tsx` (Preact), `tokens.css`, `print.css`, `theme.yaml` |
| `src/pdf/` | `extract` (dual), `meta` (post-proceso pdf-lib), `inspect` (catálogo) |
| `src/lint/` | `css`, `pdf`, `text`, `docx`, `data`, `ethics` |
| `src/cli.ts` | commander: `new`, `validate`, `build`, `watch`, `capture`, `match`, `tailor`, `lint`, `review`, `report`, `doctor`, `schema` |
| `config/` | `regions/`, `industries/`, `seniority/`, `rubric.yaml`, `taxonomy/skills.yaml` |
| `schemas/generated/` | Salida de `z.toJSONSchema()`. **Commiteado** |
| `schemas/vendor/` | Copias pinneadas de los schemas oficiales de JSON Resume |
| `people/<slug>/` | Datos reales. **Nunca los uses en tests ni en CI** |
| `fixtures/people/jane-doe/` | Persona ficticia que ejercita el schema completo. Los tests corren acá |
| `out/` | Gitignored. Se regenera |

## Qué NO hacer

- **No acoples datos a formato.** Si un renderer necesita formatear una fecha, elegir una variante o
  decidir un orden, algo se filtró desde el ViewModel. Arreglalo ahí, no en el renderer.
- **No uses el HTML como fuente intermedia.** Convertir HTML a DOCX produce un archivo del que todo
  parser headless extrae cero caracteres. El DOCX se genera nativamente desde el ViewModel.
- **No dupliques el CV por vacante.** Una postulación es un `overlay.yaml` con
  `include/exclude/order/overrides` por `id`. Nunca un `resume.yaml` copiado.
- **No dupliques el CV por idioma.** `profile/` lleva la estructura y la narrativa del locale
  primario; `i18n/<locale>.yaml` lleva sólo narrativa, por `id`. Y **no agregues fallback
  silencioso**: si falta una traducción, el build tiene que fallar con el id y el campo.
- **No deep-mergees arrays.** En la composición de configuración los arrays **reemplazan**. La
  selección de ítems se hace por `id`, jamás por índice ni por merge. `lodash.merge` (muta) y `defu`
  (semántica de defaults) están prohibidos; se usa `deepmerge-ts`.
- **No permitas que un overlay toque hechos.** Empleador, fechas, títulos, educación y
  certificaciones son inmutables desde un overlay. Si te piden agregar esos campos a `EntryOverride`,
  no lo hagas: es el mecanismo que sostiene `docs/ETHICS.md`.
- **No agregues fallbacks silenciosos en general.** Este repo prefiere fallar ruidosamente: un id
  ausente, una traducción faltante, un campo prohibido por el perfil regional y una fecha imposible
  rompen el build, con el path exacto y —cuando aplica— la fuente de la regla.
- **No hardcodees umbrales del linter.** Van a `config/rubric.yaml` con su fuente y su nivel de
  confianza.
- **No cites las cifras desacreditadas** (el "75 % de CVs auto-rechazados por el ATS", el "DOCX 97 %
  vs PDF 72 %", ni fechas del AI Act o de la ADA como si obligaran al candidato). Están rastreadas y
  refutadas en el README y en ADR-0011; el rigor es parte del producto.
- **No agregues dependencias** sin una razón que no se resuelva con las instaladas. Explícitamente
  fuera: `tsx`, `tsup`, `esbuild`, `turborepo`, `nx`, `pagedjs`, `puppeteer`, `html-docx-js`,
  `docxtemplater`, `lodash.merge`, `defu`, `zod-to-json-schema`, `pdf-parse`, `js-yaml`.
- **No uses fuentes variables.** Chromium no las embebe: `@fontsource/source-sans-3`, nunca
  `@fontsource-variable/...`.
- **No pongas datos de contacto en margin-boxes de `@page`** ni el nombre de la empresa objetivo en
  el `<title>`.
- **No commitees PII.** `contact.private.yaml` y `people/*/applications/*/sent/` están gitignored por
  algo. Las referencias de terceros van sólo como iniciales y rol.

## Antes de dar algo por terminado

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run schema      # regenera schemas/generated/*.json (se commitean)
npm test            # vitest, incluidos los golden
```

Si tocaste el schema, `npm run schema` es obligatorio y el diff de `schemas/generated/` va en el
mismo commit. Si tocaste el tema o el ViewModel, corré también `node src/cli.ts lint` contra la
fixture: los fallos de este pipeline son silenciosos por naturaleza y el linter es lo único que los
convierte en verde o rojo.
