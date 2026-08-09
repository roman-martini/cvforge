# ADR-0011 — Honestidad como control de proceso, no como nota en el README

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

Un generador automatizado de CVs adaptados hace que exagerar sea barato, y hace que exagerar
**sin querer** sea el resultado por default: el drift semántico al refrasear —"colaboré en" →
"lideré", "ayudé a diseñar" → "diseñé"— es el modo de falla más probable de cualquier pipeline que
pase texto por un modelo para que "suene mejor". Nadie lo decide; aparece solo.

Y es exactamente lo que se cae en la entrevista, donde te piden que describas tu rol concreto en ese
proyecto.

El dato relevante: **más del 75 % de los empleadores detecta al menos una discrepancia durante el
screening**, y entre los candidatos detectados **el 54,9 % pierde la oferta o el puesto**. El
argumento no es moral: la estrategia no funciona.

## Opciones evaluadas

**Una sección de buenas prácticas en el README.** Es lo que hace todo el mercado. No cambia el
comportamiento del sistema ni el del usuario apurado un domingo a la noche.

**Revisión humana obligatoria de todo el CV antes de enviar.** Correcto en teoría; en la práctica se
degrada a un vistazo rápido, y el drift de un verbo es precisamente lo que un vistazo rápido no
detecta.

**Restricciones estructurales en el schema + gates automáticos en el build.**

## Decisión

Tres mecanismos, todos verificables por el build:

1. **Capa de hechos inmutable.** Empleadores, fechas, títulos de puesto, educación y certificaciones
   **no tienen dónde escribirse desde un overlay**: el schema `EntryOverride`
   (`src/core/schema/tailoring.ts`) sólo define campos narrativos, y con `z.strictObject` un intento
   de escribir un hecho no se ignora en silencio, falla la validación.

2. **`provenance` obligatoria en toda variante de texto:**
   `{ source: human | llm_draft | llm_approved, derivedFrom, approvedBy, approvedAt }`. El build
   **falla** si una selección incluye una variante `llm_draft` no aprobada (regla ATS-090).

3. **`cv review`** muestra el diff palabra por palabra contra la variante original, **resaltando los
   cambios de verbo**, porque los verbos de acción son donde vive la inflación.

Y una decisión de encuadre: el objetivo del matcher se documenta explícitamente como **cobertura de
requisitos MUST + encontrabilidad en la búsqueda booleana del reclutador**, **no** "pasar el ATS".

## Consecuencias

- Para inflar un título de puesto hay que editar `profile/work.yaml` —el archivo que es tu currículum,
  no el de esta postulación—, donde el cambio afecta a todas las variantes a la vez y queda en el
  historial de git con tu nombre. La fricción está puesta a propósito.
- Corolario codificado en ATS-091: ningún campo de hechos puede diferir entre dos variantes de la
  misma persona. Si un CV dice "Senior" y otro dice "Staff" para el mismo puesto, una de las dos es
  falsa y el linter no necesita saber cuál.
- El linter falla el build ante texto invisible o de contraste menor a 1,5:1 (ATS-063), fuentes de
  menos de 6 pt (ATS-015), keyword stuffing —vía el recall estricto de ATS-050— y patrones de prompt
  injection (ATS-062). La red que de verdad atrapa la inyección es ATS-050: **cualquier** texto en el
  PDF que no esté en `cv.txt` falla, tenga la forma que tenga. Más del 90 % de las inyecciones reales
  medidas no usa instrucciones explícitas.
- **Sobre el encuadre:** el "75 % de CVs auto-rechazados por el ATS" se rastrea a Preptel (2012),
  empresa cerrada en 2013, sin metodología publicada. El 92 % de los reclutadores no configura
  auto-rechazo por contenido, y Greenhouse y Lever **no puntúan CVs**. El único auto-rechazo real y
  masivo son las **knockout questions del formulario** — por eso `eligibility.yaml` es un bloque de
  primera clase del schema y no un extra, y por eso `questions.yaml` registra las respuestas exactas
  enviadas y las valida contra él (ATS-092).
- Este ADR es la razón por la que existe `docs/ETHICS.md` como documento separado y no como un
  párrafo del README: la línea entre adaptar y mentir necesita ejemplos concretos de los dos lados.
