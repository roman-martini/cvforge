# cv — workspace de CVs profesionales

Los datos del CV viven una sola vez, en YAML versionado. El PDF, el DOCX, el TXT, el HTML y el
JSON Resume son **proyecciones hermanas** de esos datos: ninguno se deriva de otro. Adaptar el CV
a una vacante consiste en **seleccionar y reordenar hechos que ya existen**, nunca en reescribirlos.

Un cambio de trabajo se edita en un archivo y aparece en todos los formatos, en todos los idiomas
y en todas las variantes. Una postulación nueva cuesta un overlay de veinte líneas, no una copia
del CV entero.

---

## Requisitos

| | |
|---|---|
| Node | **≥ 24.12.0** — ejecuta TypeScript nativamente; el repo **no tiene build step** |
| Chromium | lo instala Playwright (`npx playwright install chromium`) |
| Git | recomendado con el repo en **privado** si vas a poner datos reales |

No hace falta LaTeX, ni Pandoc, ni Python, ni Typst.

---

## Inicio rápido

```bash
git clone <url-del-repo> cv
cd cv
npm install
npx playwright install chromium      # el Chromium pinneado, no el Chrome del sistema

npm run doctor                       # verifica versión de Node, browser y fuentes

# 1. Creá tu persona (esqueleto de YAML + contact.private.yaml gitignored)
node src/cli.ts new jane-doe --locale es --country AR

# 2. Editá los datos. El editor te autocompleta contra los schemas generados.
#    people/jane-doe/profile/{basics,work,education,skills,...}.yaml

# 3. Validá antes de renderizar: errores con el path exacto del archivo y la clave
node src/cli.ts validate jane-doe

# 4. Creá un arquetipo en people/jane-doe/targets/backend-senior-es.yaml
#    (a qué puesto apuntás, en qué mercado y en qué idioma). Copiá el de la
#    persona de ejemplo como punto de partida:
#    fixtures/people/jane-doe/targets/backend-senior-en.yaml

# 5. Generá
node src/cli.ts build jane-doe --target backend-senior-es --format pdf,docx,txt

# 6. Verificá que un parser vea lo mismo que vos
#    (`build` ya lintea; esto vuelve a correrlo sobre lo último generado)
node src/cli.ts lint jane-doe
```

El PDF queda en `out/jane-doe/`. `out/` está gitignored: se regenera siempre desde los datos.

Para probar el workspace sin cargar datos propios, la persona de ejemplo funciona de fábrica:

```bash
node src/cli.ts build jane-doe --target backend-senior-en
```

Si el lint da verde, el texto que extrae un parser headless del PDF coincide con `cv.txt`, las
fuentes están embebidas, el papel es el del mercado y ninguna fecha se desprendió de su entrada.

---

## El modelo mental

```
  people/<slug>/profile/*.yaml          config/regions|industries|seniority/*.yaml
  people/<slug>/i18n/<locale>.yaml      people/<slug>/targets/<arquetipo>.yaml
  people/<slug>/applications/…/overlay.yaml
            │                                        │
            ▼                                        ▼
      [1] load  ──►  [2] validate  ──►  [3] i18n  ──►  [4] compose
                     Zod estricto      por id,        deep merge de
                     + calendario      sin fallback   OBJETOS; los
                     real              silencioso     arrays reemplazan
                                                          │
                                                          ▼
                                                    [5] select
                                             include / exclude / order
                                              / overrides, todo por id
                                                          │
                                                          ▼
                                                    ┌───────────┐
                                                    │ ResolvedCV│  hechos elegidos, SIN formato
                                                    └─────┬─────┘
                                                          ▼
                                                    [6] viewmodel
                                          fechas del locale, labels del mercado,
                                          orden de secciones, truncados
                                                          │
                                                    ┌─────┴─────┐
                                                    │ ViewModel │  formateado, agnóstico al medio
                                                    └─────┬─────┘
                    ┌──────────────┬──────────────┬───────┴───────┬─────────────┐
                    ▼              ▼              ▼               ▼             ▼
                 [7] pdf         docx            txt             md        jsonresume
              (fit-loop de     (nativo,      (ground truth    (revisión)   (intercambio)
               densidad)       no del HTML)   del linter)
                    │              │              │
                    └──────────────┴──────┬───────┘
                                          ▼
                                     [8] lint ATS
                              CSS · PDF · texto extraído · DOCX · datos
```

Dos ideas sostienen todo el diseño:

**`ResolvedCV` y `ViewModel` son etapas distintas a propósito.** La primera contesta *qué hechos
entran y en qué orden*; la segunda, *cómo se ven*. Todo el formateo derivado vive en la segunda, así
que un formato nuevo no reimplementa —con diferencias sutiles— el formateo de fechas.

**El HTML no es la fuente intermedia universal.** Convertir HTML a DOCX produce un archivo del que
todo parser headless extrae cero caracteres: se ve impecable en Word y llega vacío al otro lado.
PDF, DOCX y TXT nacen del mismo ViewModel, como hermanos. Ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Cómo agregar una persona

```bash
node src/cli.ts new jane-doe --locale es --country AR
```

Crea:

```
people/jane-doe/
├─ meta.yaml               # primaryLocale, locales disponibles, modelVersion, consentimiento
├─ profile/                # estructura + narrativa en el locale PRIMARIO
│  ├─ basics.yaml          # nombre, título, resumen, contacto público, perfiles
│  ├─ work.yaml            # el corazón: empresas, posiciones, bullets XYZ
│  ├─ education.yaml  skills.yaml  projects.yaml  certificates.yaml
│  ├─ awards.yaml  languages.yaml  publications.yaml  references.yaml
│  └─ eligibility.yaml     # autorización de trabajo, disponibilidad, modalidad
├─ contact.private.yaml    # GITIGNORED: teléfono, dirección postal, documento
├─ contact.example.yaml    # commiteado, con placeholders
├─ targets/                # arquetipos reutilizables
└─ applications/           # una carpeta por postulación
```

Cada `profile/*.yaml` empieza con una línea `# yaml-language-server: $schema=…` que le da
autocompletado y validación en vivo a tu editor. Después: `node src/cli.ts validate jane-doe`.

Convenciones de escritura de los YAML (cuándo van comillas y por qué, cómo se nombran los ids, cómo
se escribe un buen bullet): [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).

---

## Cómo agregar una postulación

El 80 % del trabajo se hace **una vez por arquetipo**, no una vez por vacante.

```bash
# 1. Creá la carpeta de la postulación con sus cinco archivos
node src/cli.ts new-application jane-doe "Acme Corporation Inc." "Staff Backend Engineer" \
  --target backend-senior-en
#    → people/jane-doe/applications/2026-08-08--acme-corporation-inc--staff-backend-engineer/

# 2. Pegá el aviso COMPLETO en job.raw.md (los avisos se borran a las semanas)
#    y atomizá los requisitos a mano en job.yaml: cada uno con id, kind
#    (must|nice) y weight. Ese trabajo es el que hace que el match sirva.

# 3. Mirá la brecha contra tus datos reales
node src/cli.ts match jane-doe \
  --job people/jane-doe/applications/2026-08-08--acme…/job.yaml --locale en
#    → match-report.md
```

`match-report.md` no es un puntaje: es un reporte de brechas accionable. La sección más útil es
**Excluidos pero relevantes** — "tenés Kubernetes en tu perfil, esta vacante lo pide, y tu arquetipo
no lo está incluyendo". También resuelve las **preguntas eliminatorias** contra `eligibility.yaml`,
que es el único auto-rechazo masivo y real del proceso: conviene verlas antes de invertir la tarde.

```bash
# 4. Generá el borrador de overlay y editalo
node src/cli.ts tailor jane-doe 2026-08-08--acme…
#    → overlay.yaml (borrador ordenado por score y recortado al presupuesto)

# 5. Construí (el build ya lintea)
node src/cli.ts build jane-doe --application 2026-08-08--acme…
```

El `overlay.yaml` sólo selecciona, reordena y overridea campos narrativos:

```yaml
extends: backend-senior-en
job: ./job.yaml
locale: en
basics:
  label: "Staff Backend Engineer"
sections:
  work:
    include: [work.acme-2023, work.globex-2019]
    order:   [work.acme-2023, work.globex-2019]
    overrides:
      work.acme-2023:
        bullets: { include: [work.acme-2023.b1, work.acme-2023.b3], variant: long }
budget: { maxPages: 2 }
```

Los hechos —empleador, fechas, títulos, educación— **no se pueden tocar desde un overlay**. No es
una recomendación: el schema no tiene dónde escribirlos. Ver [`docs/ETHICS.md`](docs/ETHICS.md).

---

## Cómo generar en otro idioma

El CV **no se duplica** por idioma. `profile/` guarda toda la estructura (ids, empresas, fechas,
URLs, keywords técnicas) y la narrativa en el locale primario. `i18n/<locale>.yaml` guarda
únicamente los campos narrativos de los demás locales, indexados por el mismo `id`.

```bash
node src/cli.ts new-locale jane-doe en
#    → people/jane-doe/i18n/en.yaml con los ids que falta traducir,
#      cada uno con el texto original comentado al lado
```

```yaml
# people/jane-doe/i18n/en.yaml — SOLO narrativa, indexada por id
basics:
  label: "Senior Backend Engineer"
  summary: "Backend engineer with 8 years…"
work.acme-2023:
  summary: "B2B payments platform, 40M tx/month."
  positions:
    work.acme-2023.senior: { title: "Senior Backend Engineer" }
  bullets:
    work.acme-2023.b1:
      outcome: "Cut auth API p99 latency by 40%"
      method: "by migrating the service from REST to gRPC"
```

Después basta con un target o un overlay con `locale: en`. **No hay fallback silencioso**: si un
`id` incluido en la selección no tiene traducción, el build falla diciendo qué `id` y qué campo.
Un CV en inglés con un bullet en español es peor que un error de build.

Nunca se traducen: nombres de empresa, URLs, fechas, keywords técnicas e `id`.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `cv new <slug>` | Crea `people/<slug>/` con todos los YAML comentados |
| `cv new-target <slug> <id>` | Crea un arquetipo: a qué puesto, mercado e idioma apuntás |
| `cv new-locale <slug> <locale>` | Crea `i18n/<locale>.yaml` con los ids que falta traducir, y lo declara en `meta.yaml` |
| `cv new-application <slug> <empresa> <puesto>` | Crea la carpeta de una postulación con sus cinco archivos |
| `cv validate [persona]` | Valida los YAML con Zod: tipos, ids únicos, calendario real, coherencia temporal |
| `cv build <persona>` | Compone, resuelve, renderiza y verifica; escribe en `out/` |
| `cv match <persona> --job <path>` | Reporte de brechas contra los requisitos de la vacante |
| `cv tailor <persona> <postulación>` | Borrador de `overlay.yaml` a partir del match |
| `cv lint <persona>` | Las cinco baterías de verificación: CSS, PDF, texto extraído, DOCX, datos |
| `cv review <persona> <postulación>` | Diff palabra por palabra de los overrides contra el texto base, resaltando cambios de verbo |
| `cv report [persona]` | Funnel de postulaciones: respuesta por arquetipo, canal y locale |
| `cv doctor` | Verifica entorno: Node, Chromium, fuentes, schemas |
| `cv schema` | Regenera `schemas/generated/*.json` desde el modelo Zod |

Cada uno tiene `--help` con ejemplos reales.

Se invocan como `node src/cli.ts <comando>` o vía los scripts de npm
(`npm run validate`, `npm run build`, `npm run lint:ats`, `npm run doctor`, `npm run schema`).

---

## Formatos de salida

| Formato | Para qué | Nota |
|---|---|---|
| `pdf` | El entregable principal. Chromium, con fit-loop de densidad hasta entrar en el budget de páginas | Fuentes estáticas embebidas, PDF etiquetado, metadata normalizada |
| `docx` | Cuando el portal lo pide, o cuando la industria lo espera (consultoría, banca) | Generado **nativamente** desde el ViewModel |
| `txt` | Ground truth del linter y para pegar en formularios | Es contra este archivo que se compara la extracción del PDF |
| `md` | Revisión y diffs legibles | |
| `html` | Versión publicable, con la proyección *public-safe* (sin teléfono ni dirección) | |
| `jsonresume` | Intercambio: validado contra el schema oficial `@jsonresume/schema@1.3.1` | |

**El DOCX no busca paridad visual con el PDF, y eso es por contrato.** Es un artefacto de una
columna, con estilos nombrados estándar (`Heading 1/2`, `List Bullet`, `Normal`), semántico y
editable por quien lo reciba. Si se pareciera al PDF sería porque se generó convirtiéndolo, que es
exactamente el modo de falla que este repo evita.

---

## Privacidad: qué se versiona y qué no

Git no olvida. Un dato personal commiteado sigue en el historial aunque después lo borres, y en un
repo con datos de varias personas eso incluye datos **de terceros** que nunca consintieron nada.
Por eso la separación no es por campo sino por archivo, y está aplicada desde el commit inicial.

**Se versiona:**

- `people/<slug>/profile/*.yaml` — es tu CV; querés su historial. No contiene teléfono, dirección
  postal ni documento.
- `people/<slug>/targets/`, `applications/*/overlay.yaml`, `job.yaml`, `meta.yaml` — la trazabilidad
  de tus postulaciones vale más que el binario.
- `contact.example.yaml` con placeholders, para que un tercero pueda correr el pipeline completo sin
  que nadie quede expuesto.
- Los `schemas/generated/*.json`, para que el editor valide sin ejecutar nada.

**No se versiona (`.gitignore`):**

| Ruta | Por qué |
|---|---|
| `contact.private.yaml`, `*.private.yaml` | Teléfono, dirección postal y documento de identidad. Aislados en un archivo justamente para que un `git add .` distraído no los arrastre |
| `people/*/jds/` | Avisos crudos capturados: pueden contener información no pública de procesos en curso |
| `people/*/applications/*/sent/` | Los binarios efectivamente enviados. En `meta.yaml` queda su **SHA-256**, que es lo que hace falta para trazabilidad; el blob no |
| `attachments/`, `*.scan.pdf` | Títulos, certificados y documentos escaneados: se referencian por ruta local fuera del repo |
| `out/`, `*.pdf`, `*.docx` | Se regeneran desde los datos |

**Reglas que no dependen del `.gitignore`:**

- Las **referencias de terceros** se guardan sólo como iniciales y rol. Nunca su teléfono ni su
  email: sus datos tienen una base legal distinta de los tuyos, y esa persona no aceptó vivir en tu
  repositorio. El schema directamente no tiene campo de contacto en `references`.
- Este repositorio debe ser **privado** si contiene datos reales. Hay un check de CI que falla si el
  remote es público y existen datos fuera de `fixtures/`.
- El **CI corre contra `fixtures/`**, nunca contra `people/`, y nunca sube PDFs como artifacts:
  cualquiera con permiso de lectura los puede descargar.
- `visibility: private` por ítem excluye ese dato de la proyección publicable (HTML, portfolio).
  Es control de superficie de exposición, no cifrado.

Detalle completo en [`docs/adr/0010-privacidad-pii-fuera-de-git.md`](docs/adr/0010-privacidad-pii-fuera-de-git.md).

---

## Qué este repo no afirma

Buena parte de lo que circula sobre CVs y ATS es marketing de empresas que venden la solución al
problema que describen. Este workspace se construyó descartando esas cifras, y el rigor es parte del
producto: si el sistema te dice que algo está mal, tiene que ser porque lo está.

- **"El 75 % de los CVs son rechazados automáticamente por el ATS."** Se rastrea a Preptel, empresa
  cerrada en 2013, sin dataset ni metodología publicada. No la vas a encontrar acá.
- **"El DOCX se parsea con 97 % de precisión y el PDF con 72 %."** Blog de vendor, sin metodología.
  Generamos ambos por razones de compatibilidad de portal, no por esa cifra.
- **Lifts de callback del 50-200 %** por usar tal herramienta: investigación del propio vendor,
  cuando existe.
- **El AI Act y las leyes estatales de EE. UU. sobre decisiones automatizadas** obligan al
  **empleador y al proveedor del ATS**, no al candidato que manda un CV. No cambian ninguna regla de
  formato de este repo.
- **El Título II de la ADA** cubre gobiernos estatales y locales de EE. UU., no a empleadores
  privados ni a vos. Generamos PDF etiquetado porque **mejora la extracción de texto** y sirve a
  quien use un lector de pantalla, no para cumplir una fecha regulatoria.

Lo que sí sostiene el diseño del linter: el único auto-rechazo masivo y real del proceso son las
**knockout questions del formulario** —por eso `eligibility.yaml` es un bloque del schema y no un
extra—, y el objetivo declarado del matcher es **cobertura de requisitos MUST + encontrabilidad en
la búsqueda booleana del reclutador**, no "pasar el ATS".

Todos los umbrales heredados de fuentes de calidad desigual viven en `config/rubric.yaml`, cada uno
anotado con su fuente y su nivel de confianza. Hardcodearlos los convertiría en dogma.

---

## Documentación

| Archivo | Contenido |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | El pipeline etapa por etapa: entrada, salida y archivo de cada una |
| [`docs/ETHICS.md`](docs/ETHICS.md) | La línea entre adaptar y mentir, y cómo el sistema la hace estructural |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Convenciones de los YAML: comillas, ids, cómo se escribe un bullet |
| [`docs/adr/`](docs/adr/) | Los once ADR con las decisiones y la evidencia que las sostiene |
| [`CLAUDE.md`](CLAUDE.md) | Instrucciones para Claude Code en este repo |

---

## Licencia

Código: MIT. Los datos personales de `people/` son de cada persona y no se distribuyen.
Las fuentes vendorizadas en `assets/fonts/` conservan su licencia original (OFL) junto al archivo.
