# ADR-0008 — Idioma como eje de primera clase, con locale primario + overlay narrativo

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

JSON Resume no tiene ningún mecanismo de i18n: su bloque `languages` significa "idiomas que la
persona habla", no "idiomas en los que existe este documento".

Y el problema no es traducir. Los bullets en inglés **no son traducción literal** de los de español:
las convenciones de redacción cambian por mercado, la extensión cambia, y el énfasis cambia. Pero
las empresas, las fechas, las URLs y las keywords técnicas son **las mismas**.

Duplicar el CV completo por idioma desincroniza esos datos compartidos en semanas: con dos idiomas y
N personas, cada empresa, cada fecha y cada URL se mantiene 2N veces.

## Opciones evaluadas

**(A) Archivo completo por idioma con los mismos ids.** Legible, pero duplica toda la estructura. Es
el anti-patrón descrito arriba.

**(B) Campos localizados en línea** (`summary: { es: "…", en: "…" }`). No duplica nada, pero hace
ilegible el archivo principal: cada bullet pasa a ser un objeto de N idiomas y el diff de un cambio
de estructura se pierde entre traducciones.

**(C) Híbrido: estructura neutral una vez + overlay narrativo por locale, indexado por id.**

## Decisión

**(C), con locale primario.**

- `people/<slug>/profile/*.yaml` contiene **toda la estructura** —ids, fechas, empresas, URLs,
  keywords técnicas, priorities— **y los campos narrativos redactados en el locale primario**,
  declarado en `meta.primaryLocale`. Los archivos siguen siendo legibles por un humano sin tener que
  cruzar dos ficheros.
- `people/<slug>/i18n/<locale>.yaml` contiene **únicamente** los campos narrativos de los locales no
  primarios, indexados por `id`.
- **Sin fallback silencioso**: si el locale objetivo carece de traducción para un `id` incluido en la
  selección, el build **falla** indicando el `id` y el campo.

## Consecuencias

- Agregar una empresa cuesta **una** edición; traducirla cuesta N líneas en N archivos pequeños.
- Un cambio de fecha o de URL se hace en un solo lugar y vale para todos los idiomas: la clase de
  bug "el CV en inglés dice que sigo en Acme" deja de ser posible.
- Campos narrativos traducibles, incluidos los no obvios: `basics.label`, `basics.summary`,
  `work[].summary`, `positions[].title`, `bullets[].outcome|method|variants`, `skills[].level`,
  `languages[].fluency`, `education.area`, `education.studyType`.
- Campos **nunca** traducibles: nombres de empresa, URLs, fechas, keywords técnicas e `id`.
- La ausencia de fallback es deliberada y es la parte que más incomoda al principio. Un CV en inglés
  con un bullet en español que nadie notó es peor que un build que falla: el build se arregla en dos
  minutos, el CV ya se envió.
- El patrón de fecha del mercado **no** se resuelve acá: sale del perfil regional en la etapa
  ViewModel. Traducir una fecha a mano en un archivo de i18n es señal de que algo está en la capa
  equivocada.
