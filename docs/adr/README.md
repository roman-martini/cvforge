# Architecture Decision Records

Las once decisiones que definen este workspace, con la evidencia que las sostiene. Cada una tiene la
misma estructura: **Contexto / Opciones evaluadas / Decisión / Consecuencias**.

Los hallazgos verificados empíricamente están anotados como tales. Son la razón por la que estas
decisiones no se van a re-litigar dentro de seis meses: casi todas se tomaron después de que algo
fallara en silencio.

| ADR | Decisión | Lo que la fija |
|---|---|---|
| [0001](0001-schema-modelo-propio-superset-jsonresume.md) | Modelo propio en Zod, superset de JSON Resume; JSON Resume como formato de intercambio | JSON Resume no tiene ids ni campos requeridos: sin ids no hay tailoring determinista. MAC es copyleft |
| [0002](0002-autoria-yaml-artefactos-json.md) | Autoría en YAML 1.2 core, un archivo por sección; JSON sólo como artefacto | Comentarios y diffs legibles. `z.object` descarta campos mal escritos en silencio: se usa `z.strictObject` |
| [0003](0003-motor-de-render-chromium-docx-nativo.md) | HTML/CSS → Chromium para el PDF; DOCX nativo hermano | `preferCSSPageSize`, `tagged`, sin `margin`. Chromium no embebe fuentes variables |
| [0004](0004-runtime-node-24-sin-build-step.md) | Node 24 sin build step; TypeScript sólo como type-checker | `enum` y parameter properties fallan en runtime. Los imports exigen extensión `.ts` |
| [0005](0005-estructura-de-directorios-por-persona.md) | Partición por persona; ejes de configuración compartidos; variantes en directorios | 10 regiones × 7 industrias × 5 seniorities son 350 plantillas o 22 archivos de eje |
| [0006](0006-verificacion-ats-extraccion-dual-pdf.md) | Extracción dual del PDF con `pdfjs-dist`; falla si los dos órdenes difieren | Los extractores del mercado dan resultados opuestos para el mismo PDF |
| [0007](0007-composicion-overlay-por-id.md) | Overlay declarativo por id; jamás merge de arrays | Eleventy removió `setDataDeepMerge()` en v4 por esta clase de problema |
| [0008](0008-idioma-como-eje-de-primera-clase.md) | Locale primario en `profile/` + overlay narrativo por id, sin fallback silencioso | Duplicar el CV por idioma desincroniza empresas, fechas y URLs en semanas |
| [0009](0009-renderers-como-plugins-sobre-viewmodel.md) | Renderers hermanos sobre un ViewModel único; el HTML no es pivote | HTML→DOCX vía `altChunk` produce un archivo del que se extraen cero caracteres |
| [0010](0010-privacidad-pii-fuera-de-git.md) | Repo privado, PII aislada por archivo, hash en vez de blob | Git no olvida, y las referencias son datos de terceros con otra base legal |
| [0011](0011-honestidad-como-control-de-proceso.md) | Hechos inmutables desde un overlay, `provenance` obligatoria, `cv review` con diff de verbos | >75 % de los empleadores detecta alguna discrepancia; casi el 55 % de los detectados pierde la oferta |

## Convención

Los ADR son **inmutables una vez aceptados**. Para revertir o cambiar una decisión se escribe un ADR
nuevo con el siguiente número disponible, que referencia al anterior, y el original pasa a estado
`Reemplazado por ADR-NNNN`. No se edita el contenido de un ADR aceptado: el valor de este directorio
es poder reconstruir por qué algo se decidió con la información que había entonces.
