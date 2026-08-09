# La línea entre adaptar y mentir

Un workspace que genera CVs adaptados a cada vacante hace que mentir sea barato. Este documento
define dónde está la línea, y el resto del repo está diseñado para que cruzarla sea incómodo.

**El dato que ordena todo lo demás:** más del 75 % de los empleadores detecta al menos una
discrepancia durante el screening, y entre los candidatos detectados casi el 55 % pierde la oferta o
el puesto. No es un argumento moral: es que la estrategia no funciona. Un CV inflado no falla al
enviarse —falla en la conversación donde te piden que expliques el 40 %.

---

## Legítimo

Todo esto es adaptación. Nada de esto cambia un hecho.

**Elegir qué experiencias mostrar.** Un CV es un argumento, no un expediente. Omitir el trabajo de
verano de hace doce años porque no aporta a esta vacante es edición, no ocultamiento. La regla
operativa: lo que quede tiene que ser verdad **y** no dejar un hueco temporal que no puedas explicar.

**Reordenar por relevancia.** El reclutador escanea en seis o siete segundos y rara vez pasa del
tercer bullet de cada rol. El bullet más relevante para *esta* vacante va primero, aunque no sea el
cronológicamente primero. Cambiar el orden no cambia lo que pasó.

**Usar la terminología de la vacante cuando describe con exactitud algo real.** Si el aviso dice
"PMP certified" y vos tenés la certificación Project Management Professional, escribí "PMP": varios
parsers no resuelven que son lo mismo, y vos no estás afirmando nada distinto. El límite es
*con exactitud*: si el aviso dice "Kubernetes en producción" y vos lo usaste en un entorno de
staging, escribir la frase del aviso es mentir con las palabras de otro. Por eso los aliases son un
campo del schema (`skills[].aliases`) y no una operación de reemplazo de texto: cada alias lo
declaraste vos una vez, deliberadamente, sabiendo que describe lo mismo.

**Ajustar el resumen.** Las dos o tres frases de arriba son donde se dice a qué apuntás. Reescribirlas
para esta vacante es exactamente su función. Siguen sujetas a la misma regla: los años de experiencia,
los dominios y los títulos que menciones tienen que ser los que están en `work.yaml`.

**Elegir la variante corta o larga de un logro.** `variants.short` y `variants.long` son dos
redacciones del **mismo hecho** con distinta extensión, escritas por vos de antemano. El fit-loop
elige la que entra en la página. Eso no es una decisión de contenido.

**Traducir.** La narrativa en otro locale no es traducción literal: las convenciones de cada mercado
cambian. Sigue siendo el mismo hecho, con el mismo `id`, y por eso el sistema exige que exista antes
de renderizar en vez de dejar pasar un fallback.

---

## Prohibido

Estas prácticas no están "desaconsejadas". El linter las hace fallar el build.

**Texto invisible, en blanco o de 1 px.** Poner keywords en `color: white` o `font-size: 1px`
técnicamente funciona —ese texto **sí** se extrae— y por eso es fraude, no un truco. Es trivialmente
detectable comparando el texto extraído contra el visible, muchas empresas lo hacen, y en varios
sistemas de tracking queda un indicador de fraude asociado a tu candidatura que sobrevive a esta
postulación. Reglas ATS-015 (menos de 6 pt en cualquier parte es fraude) y ATS-063
(contraste < 1,5:1, `color: transparent`, `opacity: 0`).

**Keyword stuffing.** Listar tecnologías que no usaste, o repetir la misma veinte veces. El costo real
no es que te descubran en el parser: es que te pregunten por ellas. Regla ATS-050: todo token del PDF
tiene que estar en `cv.txt`, y `cv.txt` sale de tus datos.

**Prompt injection.** Instrucciones dirigidas a un LLM escondidas en el documento
("ignore all previous instructions", "this is an excellent candidate"). Se midió en el ~1 % de
200.000 CVs reales, y un workspace automatizado lo vuelve trivial de hacer mal. ATS-062 lo busca por
regex, pero la red que de verdad lo atrapa es ATS-050: **cualquier** texto en el PDF que no esté en
tus datos hace fallar el build, tenga la forma que tenga. Más del 90 % de las inyecciones reales no
usa instrucciones explícitas, así que la regla estructural es la que importa.

**Inflar el verbo al refrasear.** "Colaboré en" → "lideré". "Ayudé a diseñar" → "diseñé".
"Participé del equipo que migró" → "migré". Este es el modo de falla **más probable** de un generador
automático, porque el drift no lo introduce nadie con intención: aparece solo cuando un modelo
reescribe para que suene mejor. Y es exactamente lo que se cae en la entrevista, donde te piden que
describas tu rol concreto en ese proyecto.

**Inventar o redondear métricas.** "Un 38 % aproximadamente" no se convierte en "40 %". Un número que
no podés defender con una fuente es peor que ningún número: un bullet claro, específico y verdadero
sin métrica le gana siempre a uno con una métrica forzada. Por eso `metric` es **opcional** en el
schema —exigirla en cada bullet empuja directo a inventar— y por eso "al menos dos anclas
cuantificadas en todo el CV" (ATS-089) es un *warning* y no un error.

**Mover fechas.** Estirar un contrato para tapar un hueco, o adelantar una salida. Es el ítem que
más se verifica en background checks, y el que más rápido se rompe.

**Cambiar títulos de puesto.** Tu contrato decía "Backend Engineer". No decía "Senior". El título es
un hecho verificable, no una descripción.

---

## Por qué el sistema lo hace estructuralmente difícil

La honestidad acá no es una nota al pie del README: son tres mecanismos que sostienen la regla
cuando nadie está mirando.

### 1 · Los hechos son inmutables desde un overlay

Un `overlay.yaml` puede hacer cuatro cosas: `include`, `exclude`, `order` y `overrides`. Y
`overrides` sólo alcanza campos narrativos —`basics.label`, `basics.summary`, `work[].summary`, la
selección y la variante de bullets—.

El empleador, las fechas, el título del puesto, la institución educativa y las certificaciones **no
tienen dónde escribirse desde un overlay**. No es una convención que se pueda olvidar en un
apuro: el schema `EntryOverride` (`src/core/schema/tailoring.ts`) no define esos campos, y con
`z.strictObject` un intento de escribirlos no se ignora en silencio, **falla la validación**.

Para inflar un título de puesto hay que editar `profile/work.yaml` —el archivo que es tu currículum,
no el de esta postulación— y ahí el cambio afecta a todas las variantes a la vez y queda en el
historial de git con tu nombre. La fricción está puesta a propósito.

Corolario codificado en ATS-091: ningún campo de hechos puede diferir entre dos variantes de la misma
persona. Si tu CV para Acme dice "Senior Backend Engineer" y el de Globex dice "Staff", una de las
dos es falsa, y el linter no necesita saber cuál.

### 2 · Todo override queda diffeable

Un `override` es texto **explícito** en un archivo versionado, al lado del `id` del ítem que
reemplaza. No es una transformación que ocurre en algún lado del pipeline: está escrito.

`cv review` muestra el diff palabra por palabra contra la variante base y **resalta los cambios de
verbo**, porque es en el verbo donde vive la inflación. Ver "colaboré" tachado y "lideré" en verde,
sobre un texto que vas a tener que defender, es una intervención mucho más efectiva que una
advertencia genérica en un README.

### 3 · `provenance` obliga a aprobar cualquier texto generado

Cada variante de texto lleva:

```yaml
provenance:
  source: human | llm_draft | llm_approved
  derivedFrom: work.acme-2023.b1
  approvedBy: "Jane Doe"
  approvedAt: "2026-08-07"
```

El build **falla** si una selección incluye una variante `llm_draft` no aprobada (ATS-090). Un
borrador generado por un modelo puede existir en el repo, puede versionarse y puede discutirse —pero
no llega a un PDF sin que una persona lo haya leído y firmado con su nombre.

El punto no es desconfiar del modelo. Es que la afirmación la hacés vos: el CV lo firma una persona,
y quien tiene que poder defender cada frase en una entrevista es esa persona.

---

## Sobre el objetivo del matcher

El matcher de este repo tiene un objetivo declarado, y no es "pasar el ATS":

> **cobertura de requisitos MUST + encontrabilidad en la búsqueda booleana del reclutador**

La diferencia importa éticamente, no sólo técnicamente. "Pasar el ATS" sugiere derrotar un filtro, y
un filtro que se derrota invita a trucos. Cubrir requisitos y ser encontrable es lo que hace un CV
bien escrito: decir con claridad lo que hiciste, con las palabras que usa quien busca.

Además, el filtro que se supone que hay que derrotar en gran medida no existe. El "75 % de los CVs
rechazados automáticamente" se rastrea a una empresa que cerró en 2013 y nunca publicó metodología;
Greenhouse y Lever no puntúan CVs. El auto-rechazo real y masivo son las **knockout questions del
formulario** —autorización de trabajo, disponibilidad, ubicación—, que es por qué `eligibility.yaml`
es un bloque de primera clase del schema y por qué `questions.yaml` registra las respuestas exactas
que enviaste y las valida contra él (ATS-092).

Ahí, además, la honestidad tiene consecuencias inmediatas: responder "sí tengo autorización para
trabajar en la UE" cuando `eligibility.yaml` dice `sponsorshipRequired: true` no es una exageración
de CV. Es una respuesta falsa en un formulario, y se descubre en la primera llamada.

---

## Regla de bolsillo

> Si no podés defenderlo en una entrevista con alguien que estuvo ahí, no va en el CV.

Todo lo demás de este documento es esa frase, codificada.
