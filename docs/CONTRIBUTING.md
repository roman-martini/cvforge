# Convenciones

Cómo se escriben los datos de este repo. Casi todo lo que sigue existe porque algo falla en silencio
si no se respeta.

---

## 1 · Comillas en YAML

El parser es `yaml` (eemeli) con **YAML 1.2 core**, que ya elimina las trampas peores de 1.1 (`NO`
no se convierte en `false`, `2023-04-01` no se convierte en un objeto `Date`, `01234` no se lee como
octal). Pero YAML sigue infiriendo tipos, y algunos campos de un CV son strings que *parecen* números.

### Comillas obligatorias

| Campo | Sin comillas | Con comillas | Qué pasa |
|---|---|---|---|
| `phone` | `+54 9 11 5555 5555` | `"+54 9 11 5555 5555"` | Se parsea como número y **pierde el `+`**. El reclutador marca un número sin prefijo internacional |
| `location.postalCode` | `01234` | `"01234"` | Se vuelve `1234`. El código postal deja de existir |
| `location.countryCode` | `NO` | `"NO"` | En YAML 1.1 es `false`. En 1.2 sobrevive, pero un editor, un linter o un conversor con parser 1.1 lo rompe. **La regla es sin excepciones**: los códigos de país siempre van entre comillas |
| `education.score` | `4.0` | `"4.0"` | Se vuelve el número `4` y se imprime `"4"` en el CV. Un GPA de 4.0 impreso como 4 se lee como un error tipográfico |
| Fechas: `startDate`, `endDate`, `date`, `expiresAt` | `2023-04` | `"2023-04"` | `2023-04` puede resolverse como resta. `2023-04-17` es un `Date` bajo YAML 1.1. Los tipos `YearMonth` e `IsoDate` del schema son **strings**, y el sistema falla ruidosamente si recibe otra cosa |
| `credentialId`, `nationalId`, cualquier identificador | `007123` | `"007123"` | Ceros a la izquierda perdidos |
| `metric.value` | `40%` | `"40%"` | Funciona sin comillas, pero mezclar `"40%"` y `40` en el mismo archivo produce dos tipos distintos para el mismo concepto |

**Por qué el schema no acepta ambos tipos.** Sería fácil declarar
`phone: z.union([z.string(), z.number()])` y "arreglarlo". Está prohibido: eso convierte un fallo
ruidoso —que corregís en diez segundos— en uno silencioso que llega al reclutador con tu teléfono
mal. El schema tipa string estricto **a propósito**.

### Cuándo no hace falta

Texto narrativo normal (`outcome`, `summary`, `method`, `label`) no necesita comillas, salvo que
empiece con un carácter especial de YAML (`- ? : , [ ] { } # & * ! | > % @ \``) o contenga `: `.

```yaml
outcome: Redujo la latencia p99 de la API de auth un 40%          # bien
summary: "Plataforma B2B: 40M de transacciones por mes."          # comillas: contiene ": "
method: "> 200 endpoints migrados"                                 # comillas: empieza con ">"
```

### Bloques multilínea

Para texto largo, `>-` (pliega los saltos en espacios, sin salto final):

```yaml
summary: >-
  Ingeniero backend con 8 años de experiencia en plataformas de pagos.
  Especializado en sistemas distribuidos de alto volumen y en reducción
  de costos de infraestructura.
```

Usá `|-` sólo si los saltos de línea son significativos. En un CV casi nunca lo son, y un salto que
sobrevive al render aparece como una línea partida en el PDF.

### Comentarios

Son una de las razones por las que la autoría es YAML y no JSON. Usalos para lo que el dato no dice:

```yaml
- id: work.acme-2023.b3
  outcome: Recortó el gasto de infraestructura en USD 84k anuales
  # La cifra sale del informe de FinOps de 2024-Q3, no de una estimación propia.
  metric: { value: "USD 84k/año", type: absolute, confidence: measured }

# - id: work.acme-2023.b5     ← apagado, no borrado: sirve para vacantes de plataforma
#   outcome: Migró 40 servicios a Terraform
```

Apagar un bullet comentándolo es aceptable para algo que estás por descartar. Para algo que querés
conservar y no mostrar en esta vacante, lo correcto es dejarlo en `profile/` y no incluirlo en el
overlay: así sigue apareciendo en `cv match` bajo **EXCLUDED BUT RELEVANT**.

### Encabezado de archivo

Todo `profile/*.yaml` empieza con la línea de schema, que le da autocompletado y validación en vivo
al editor:

```yaml
# yaml-language-server: $schema=../../../schemas/generated/work.schema.json
```

Esta línea, más el `yaml.schemas` de `.vscode/settings.json`, es lo que **overridea el auto-binding
de SchemaStore**, que mapea cualquier `resume.yaml` al JSON Resume v1.0.0 archivado y te llenaría el
editor de errores falsos.

---

## 2 · Ids

El `id` es el requisito habilitante de todo el resto: overlays, i18n, matching, trazabilidad. Un id
que cambia rompe silenciosamente overlays y traducciones.

### Formato

```
^[a-z0-9]+(?:[-.][a-z0-9]+)*$
```

Minúsculas, dígitos, punto y guion. Nada más: ni mayúsculas, ni guion bajo, ni acentos, ni espacios.

### Convención de nombres

**`<sección>.<slug-de-la-entidad>-<año-de-inicio>`**, y las subentidades cuelgan del padre con punto:

```yaml
work.acme-2023                 # la empresa, desde 2023
work.acme-2023.senior          # una posición dentro de ella
work.acme-2023.b1              # un bullet de esa entrada
education.utn-2014
skill.kubernetes
project.cv-workspace
cert.aws-saa-2024
lang.en
```

Reglas:

| Regla | Por qué |
|---|---|
| El `id` es **único en todo el perfil**, no por sección | Los overlays referencian ids sin decir de qué sección son. Dos ids iguales hacen la selección ambigua y dependiente del orden de carga |
| El año es el de **inicio**, y no se toca nunca más | Si el id llevara el año de fin, ascender o irse de la empresa cambiaría el id y rompería todos los overlays existentes |
| El slug de empresa es **corto y estable**: `acme`, no `acme-corporation-inc` | El nombre legal completo va en `company.name`, donde puede cambiar sin arrastrar nada |
| Los bullets se numeran `b1`, `b2`, `b3`… y **los números no se reciclan** | Si borrás `b4`, el siguiente bullet es `b8`, no `b4`. Reciclar un número hace que un overlay viejo apunte a otro hecho sin que nada falle |
| Un `id` **no se renombra**. Se agrega el nuevo y se borra el viejo, en el mismo commit, actualizando los overlays que lo usan | Renombrar es indistinguible de borrar-y-crear para el sistema, y el build te va a avisar: un id referenciado y ausente falla |

### Nombres de directorio de postulación

```
YYYY-MM-DD--<empresa>--<rol>
2026-08-07--acme--staff-backend-engineer
```

Fecha de captura del aviso, doble guion como separador, todo en minúsculas con guiones simples
dentro de cada parte. Ordena cronológicamente solo, y el doble guion permite separar los campos sin
ambigüedad aunque el nombre de la empresa o el rol tengan guiones.

---

## 3 · Cómo se escribe un bullet

La fórmula es **XYZ**: *"Accomplished [X] as measured by [Y] by doing [Z]"*. Traducido a los campos
del schema:

```yaml
- id: work.acme-2023.b1
  outcome: Redujo la latencia p99 de la API de auth un 40%   # X — el resultado, primero
  metric:                                                     # Y — la medida (OPCIONAL)
    value: "40%"
    type: delta_pct
    confidence: measured
  method: migrando el servicio de REST a gRPC                 # Z — el método
  tags: [go, grpc, performance]
  priority: 95
  variants:
    short: Latencia p99 de auth −40% migrando REST→gRPC.
    long: >-
      Redujo la latencia p99 de la API de autenticación un 40% migrando el
      servicio de REST a gRPC y agregando connection pooling.
  provenance: { source: human }
  verified: true
```

**El resultado va primero.** El reclutador escanea en seis o siete segundos y rara vez pasa del
tercer bullet de cada rol. Si el bullet arranca con el método, el resultado se lee tarde o no se lee.

**`metric` es opcional a propósito.** Exigir un número en cada bullet empuja a inventarlos, que es
justo lo que se cae en la entrevista. Un bullet claro, específico y verdadero sin número le gana a
uno con un número forzado; dos a cuatro anclas cuantificadas bien elegidas en todo el CV alcanzan.
Cuando no hay métrica, el renderer degrada a `outcome + method`.

**Longitud objetivo: 15 a 30 palabras** (una o dos líneas impresas). Tres a seis bullets en el rol
actual, tres a cinco en el anterior, uno a tres en los antiguos.

### Antes / después

| Antes | Después |
|---|---|
| *Responsable de gestionar el equipo de soporte al cliente.* | **Bajó el tiempo medio de resolución de tickets de 14 h a 3 h** liderando un equipo de 9 personas en la implementación de triage por niveles en Zendesk. |
| *Trabajé en la API de autenticación.* | **Redujo la latencia p99 de la API de auth un 40%** migrando el servicio de REST a gRPC. |
| *Colaboré con un comité estudiantil para aumentar la participación.* | **Lideró un equipo de 5 personas y duplicó la participación estudiantil, de 50 a 100 miembros**, creando una presencia sostenida en redes sociales. |
| *Contribuí a un sistema para agilizar el envío de solicitudes.* | Desarrolló junto al equipo de IT un sistema de envío y seguimiento de solicitudes en línea, **reduciendo el costo un 10%**. |
| *Seleccionado para una beca.* | **Seleccionado entre 230 participantes a nivel nacional**, por posición en el ranking de la carrera y trabajo en la comunidad. |

Qué cambió en cada caso: el "antes" describe una **responsabilidad** ("responsable de", "trabajé
en", "contribuí a"); el "después" describe un **resultado** con su método. La última fila muestra
que una métrica no tiene por qué ser un porcentaje: la selectividad (`type: selectivity`) es una
medida perfectamente válida.

Cuidado con el cuarto ejemplo: dice "desarrolló junto al equipo de IT", no "desarrolló". Esa
precisión es deliberada — convertirla en "lideró el desarrollo" es exactamente el drift que
[`ETHICS.md`](ETHICS.md) prohíbe y que `cv review` resalta.

### Tipos de métrica

| `type` | Ejemplo |
|---|---|
| `delta_pct` | −40 % de latencia |
| `absolute` | USD 84k/año |
| `scope` | 9 personas, 12 países |
| `frequency` | 40 tickets/semana |
| `scale` | 40M tx/mes, 300k líneas |
| `selectivity` | 1 de 230 |
| `duration` | de 14 h a 3 h |
| `proxy_qualitative` | NPS, tasa de participación |

`confidence` es `measured` (tenés la fuente), `estimated` (lo calculaste vos con un método que podés
explicar) o `self_reported` (es tu percepción). Sólo `measured` cuenta como ancla cuantificada para
ATS-089, y es el único valor que deberías poder defender sin matizar.

### Estilo

- **Verbo de acción al inicio**, voz activa, sin pronombres personales, sin artículo inicial.
- Verbos por tipo de impacto: construcción (*construyó, diseñó, lanzó*), mejora (*redujo, aceleró,
  aumentó*), liderazgo (*lideró, coordinó, formó*), análisis (*analizó, diagnosticó, midió*).
- **No inflar el verbo al refrasear.** "Colaboré en" no se convierte en "lideré".
- **Acrónimos**: cada término técnico aparece al menos una vez expandido **y** como acrónimo —
  *"Integración Continua (CI)"*, *"Kubernetes (K8s)"*. Muchos parsers no resuelven que son lo mismo.
- **Sin abreviaturas en títulos de puesto**: `Senior Backend Engineer`, nunca `Sr. SW Eng` (ATS-085).
- **Con sufijo legal en nombres de empresa**: `Acme Corporation Inc.`, `Globex S.A.` (ATS-086).

---

## 4 · Skills

```yaml
- id: skill.kubernetes
  canonical: Kubernetes
  aliases: [K8s, kubernetes, EKS, GKE]
  category: Infraestructura
  level: advanced
  keywords: [helm, operators, hpa]
  tags: [infra, cloud]
  priority: 90
```

`canonical` es lo que se imprime por defecto. Los `aliases` existen para que el matcher resuelva y
para que **el renderer emita la forma que usa la vacante** cuando describe lo mismo. Declarar un
alias es una afirmación: estás diciendo que ambos términos nombran tu misma experiencia real. No
metas ahí una tecnología parecida que no usaste.

`yearsOfExperience` se **deriva** de `work` cuando no lo declarás. Declararlo a mano y que contradiga
las fechas es una discrepancia que se detecta en el screening.

---

## 5 · i18n

`profile/` lleva la narrativa en `meta.primaryLocale`. `i18n/<locale>.yaml` lleva **sólo** la
narrativa de los demás locales, indexada por el mismo `id`:

```yaml
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
      variants: { short: "…", long: "…" }
```

**Nunca** van al archivo de i18n: nombres de empresa, URLs, fechas, keywords técnicas ni ids. Si te
encontrás traduciendo una fecha, el patrón de fecha del mercado se resuelve en la etapa ViewModel a
partir del perfil regional, no acá.

**No hay fallback silencioso.** Falta una traducción de un `id` incluido en la selección, falla el
build con el id y el campo. Es intencional.

---

## 6 · Convenciones de código

Sólo lo que no es evidente leyendo el repo. El detalle está en [`CLAUDE.md`](../CLAUDE.md).

- **Node 24 ejecuta TypeScript nativamente. No hay build step.**
- Los imports locales llevan **extensión `.ts` explícita**: `from './load.ts'`. Sin ella,
  `ERR_MODULE_NOT_FOUND`.
- Prohibidos `enum`, parameter properties (`constructor(private x)`), namespaces con valores y
  decoradores: Node los rechaza en runtime con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Se usa
  `as const` + union types.
- ESM puro. Nada de `require()`.
- **Zod v4 con `z.strictObject`**, nunca `z.object`.
- Rutas siempre con `node:path`. El repo se desarrolla en Windows.
- **Comentarios y mensajes al usuario en español**; identificadores de código en inglés.
- Se comenta el *porqué* y las restricciones no obvias. Comentar lo que hace la línea siguiente está
  prohibido.

### Antes de commitear

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run schema        # regenera schemas/generated/*.json — se commitean
npm test              # vitest, incluidos los golden
```

Los `schemas/generated/*.json` **se versionan**: son lo que el editor consume para autocompletar, y
regenerarlos tiene que ser un paso deliberado y visible en el diff, no un efecto secundario de
instalar dependencias.

### Golden tests

Los golden viven en `tests/golden/` y comparan `ResolvedCV` y el SHA-256 del PDF. Si un golden
cambia, el diff tiene que ser explicable en una frase. Dos advertencias:

- `.gitattributes` fija `* text=auto eol=lf`. Sin eso, con `core.autocrlf=true` en Windows los golden
  fallan con un diff del 100 % de las líneas.
- El PDF es byte-idéntico entre corridas **una vez normalizados** `/CreationDate` y `/ModDate`. Si un
  golden de PDF falla por dos bytes, el post-proceso de metadata no corrió.

### Datos de prueba

El CI corre **contra `fixtures/people/jane-doe/`**, nunca contra `people/`. Esa persona es ficticia y
ejercita el schema completo. Todo caso de borde nuevo se agrega ahí, no a un perfil real.
