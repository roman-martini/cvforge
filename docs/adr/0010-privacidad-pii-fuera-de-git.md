# ADR-0010 — Privacidad: repo privado, PII fuera de git, hash en vez de blob

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

Un repositorio con datos de N personas contiene teléfonos, direcciones postales, documentos de
identidad (obligatorios en varios perfiles de LATAM y España), pretensiones salariales y **datos de
contacto de terceros** en las referencias.

Ese último caso es distinto de todos los demás: bajo GDPR y bajo la Ley 25.326 argentina, los datos
de un tercero tienen una base legal distinta de los propios. Esa persona te dio su teléfono para que
la llamaran, no para que su número viviera en un repositorio.

Y **git no olvida**: un dato commiteado sigue en el historial aunque después se borre del working
tree, y limpiarlo requiere reescribir la historia de todo el repo.

## Opciones evaluadas

**Todo dentro, repo privado.** Un repo privado deja de serlo con un click, o cuando se agrega un
colaborador, o cuando se hace un fork para mostrar el proyecto. La privacidad no puede depender de un
flag reversible.

**Cifrado del repo (git-crypt, SOPS, transparent encryption).** Resuelve el problema real, pero rompe
los diffs legibles —que es la razón por la que ADR-0002 eligió YAML— y agrega gestión de claves al
onboarding.

**Separación por archivo + gitignore, aplicada desde el commit inicial.**

## Decisión

Reglas duras, aplicadas **desde el commit inicial**:

1. Repo **privado por defecto**, con un check de CI que falla si el remote es público y existen datos
   reales fuera de `fixtures/`.
2. `people/<slug>/contact.private.yaml` **gitignored**, con un `contact.example.yaml` commiteado con
   placeholders — así el pipeline es reproducible por un tercero sin exponer a nadie.
3. Referencias de terceros: **sólo iniciales y rol** en el repo. Datos de contacto, nunca. El schema
   `ReferenceEntry` directamente no tiene campo de contacto.
4. **Nunca** commitear adjuntos escaneados (Zeugnisse, títulos, DNI): se referencian por ruta local
   fuera del repo.
5. Trazabilidad del entregable: se guarda el **SHA-256** del PDF enviado en `meta.yaml`, no el
   binario. `applications/*/sent/` está gitignored.
6. Campo `visibility: public | private` por ítem: el compilador emite una proyección *public-safe*
   —sin teléfono, dirección postal ni referencias— para el HTML publicable.
7. El CI corre **contra `fixtures/`**, nunca contra `people/`. **Nunca** subir PDFs reales como
   artifacts de GitHub Actions: son descargables por cualquiera con permiso de lectura.

## Consecuencias

- La separación es **por archivo, no por campo**, precisamente para que un `git add .` distraído no
  arrastre PII. Un campo sensible mezclado entre campos normales depende de que la persona se acuerde;
  un archivo entero en `.gitignore`, no.
- `profile/*.yaml` **sí** se versiona: es el CV, y su historial es valioso. Lo que no está ahí es el
  teléfono, la dirección ni el documento.
- Guardar el hash en vez del binario da toda la trazabilidad que hace falta —"esto exactamente fue lo
  que mandé"— sin acumular PDFs con datos personales en el historial. Es verificable: se regenera el
  PDF y se compara el SHA-256, que es determinista gracias a la normalización de timestamps de
  ADR-0003.
- `visibility: private` es **control de superficie de exposición, no cifrado**. No protege contra
  alguien con acceso al repo; evita que un dato termine en una página pública.
- Costo aceptado: un colaborador nuevo tiene que crear su `contact.private.yaml` a partir del
  `.example`. Es un paso del onboarding, documentado en el README.
