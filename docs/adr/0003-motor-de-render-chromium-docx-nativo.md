# ADR-0003 — Motor de render: HTML/CSS → Chromium para PDF; DOCX nativo hermano

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

Hay que producir PDF, DOCX, TXT, HTML y JSON Resume. El entorno de desarrollo tiene Chrome 151 y
Node 24; no hay LaTeX ni Pandoc instalados, y el onboarding de un colaborador no debería requerir
instalarlos.

## Opciones evaluadas

**(A) Typst 0.15.** PDF/UA-1 etiquetado por default, con templates `basic-resume` y `modern-cv` ya
existentes. **Pero** su export a HTML sigue siendo experimental en 0.15, así que obligaría a
mantener **dos plantillas** —una Typst para el PDF y una HTML para la web— que se desincronizan.

**(B) WeasyPrint.** Requiere GTK3, Pango y cairo fuera de pip en Windows 11; falla con
`OSError: cannot load library gobject-2.0-0`. Rompe el onboarding.

**(C) wkhtmltopdf** (deprecado), **Prince** (USD 3.800 de licencia), **Paged.js** (estancado en
0.4.3; su razón de ser desapareció cuando Chrome 131 implementó lo que emulaba).

**(D) HTML/CSS + Chromium vía Playwright.**

## Decisión

**(D)** para PDF y HTML. **El DOCX se genera con `docx` (dolanmiu) directamente desde el ViewModel**,
nunca convirtiendo el HTML (ver ADR-0009). Typst queda como renderer opcional de fase 2, aislado
detrás de la misma interfaz `Renderer`.

### Configuración obligatoria, verificada empíricamente

| Parámetro | Valor | Razón |
|---|---|---|
| `preferCSSPageSize` | `true` | Sin él, el `MediaBox` sale `612×792` (Letter) aunque el CSS diga A4. Fallo silencioso: mismo contenido, mismo número de páginas, papel equivocado |
| `printBackground` | `true` | El default de Puppeteer/Playwright es `false`, pero el CLI `--print-to-pdf` sí imprime fondos. Pasarlo explícito hace el pipeline agnóstico al runner |
| `margin` | **no pasar** | Es no-op frente a `@page { margin }` del CSS. Verificado byte a byte: el mismo archivo con `margin: 0` y con el default. Los márgenes se controlan **sólo** en el CSS |
| `tagged` / `outline` | `true` | En Playwright `tagged` es **`false`** por default (en Puppeteer es `true` y está marcado Experimental). Pasarlos explícitos siempre |
| `displayHeaderFooter` | `false` | Los templates de header/footer se renderizan en un documento aislado, sin tu CSS ni tus `@font-face` |
| Canal del browser | `--preview` → `channel: 'chrome'` · `--release` → **Chromium bundleado por Playwright** | Chrome se autoactualiza (150 → 151 en semanas) y con él cambia la paginación. Los golden y el conteo de páginas corren **siempre** contra el bundleado, pinneado por el lockfile |

## Consecuencias

- **Fuentes variables prohibidas.** Verificado: Chromium **no embebe** fuentes con tabla `fvar`.
  Renderizando Bahnschrift en tres pesos, los tres `FontDescriptor` salieron **sin `/FontFile2`**. Se
  usan instancias **estáticas** (`@fontsource/source-sans-3`, nunca los paquetes `-variable`).
- **Recursos dentro de `@page`, sólo como `data:` URI.** Verificado en Chrome 151: un `file:///`
  absoluto en un `content: url()` de margin-box produce un PDF **byte-idéntico** al que produce un
  archivo inexistente. En el flujo normal del documento, `file://` relativo sí carga.
- El argumento de Reactive Resume ("tiramos Puppeteer en la v5") **no aplica**: era un servicio web
  con Browserless para 970 000 usuarios, un problema operacional de escala, no de calidad del PDF. En
  un CLI local no existe.
- El PDF de Chromium es **determinista salvo el timestamp** (dos bytes de diferencia entre renders).
  Normalizando `/CreationDate` y `/ModDate` con `pdf-lib` se obtienen PDFs byte-idénticos, lo que
  habilita **golden testing por SHA-256**.
- Un error de sintaxis en `@font-face` —por ejemplo un salto de línea dentro de la `url()` de un data
  URI— descarta **todo el stylesheet** sin emitir ningún error, y el PDF sale en Times New Roman
  12 pt con el build en verde. La regla ATS-032 (el conjunto de fuentes embebidas debe coincidir con
  el declarado por el tema) es lo único que atrapa ese caso.
