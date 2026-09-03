# Prompt: relevar evidencia para mi CV en esta máquina

Uso: en cualquiera de mis máquinas, abrí Claude Code con ESTE repo (cvforge)
como directorio de trabajo y pegale todo lo que sigue. Después le digo qué
directorios explorar.

---

Sos Claude Code corriendo en cvforge, mi generador de CVs. Mi perfil ya existe
en `people/roman-martini/`, armado desde la evidencia de mis repos personales.
Tu tarea: relevar los proyectos que te indique en ESTA máquina e integrar la
evidencia nueva directamente en ese perfil.

## Cómo funciona este repo (lo mínimo que necesitás)

- El CLAUDE.md del repo, ya cargado en tu contexto, trae las reglas técnicas.
  Las de fondo: los datos son un pool de hechos seleccionables por `id`; nada
  se inventa (`docs/ETHICS.md`); todo texto que redactes vos lleva
  `provenance: { source: llm_draft }` — el build falla a propósito si un
  borrador sin aprobar llega a un CV renderizado, y así debe ser.
- Los comentarios de `people/roman-martini/profile/*.yaml` documentan la
  evidencia ya cargada y los gaps pendientes: leelos antes de agregar nada,
  para no duplicar hechos que ya están.

## Qué hacer

1. Preguntame en un único mensaje: (a) qué directorios explorar en esta
   máquina, (b) qué emails y nombres usa mi git acá — la identidad
   corporativa no es `roman-martini`, no atribuyas nada sin confirmarla.
2. Por cada repo donde yo tenga commits (verificalo con `git log --author`):
   dominio y propósito en abstracto; mi participación visible (módulos o
   áreas tocadas según `git log` por paths, período de mis commits en
   formato YYYY-MM, volumen relativo de commits míos vs. total); stack con
   versiones; prácticas demostrables (tests, CI, migraciones, ADRs, docs);
   logros candidatos a bullet XYZ, solo con evidencia y con cada cifra
   contable citando su fuente.
3. Integrá al perfil según el tipo de hecho:
   - Proyectos personales míos → `profile/projects.yaml` y `profile/skills.yaml`.
   - Evidencia de trabajo para un empleador o cliente → NO va a projects: se
     anota como comentario en `profile/work.yaml` (período de commits,
     módulos, stack, bullets candidatos), como insumo para cuando yo complete
     ese empleo con fechas de contrato y título reales.
4. Corré `node src/cli.ts validate roman-martini` (si faltan dependencias,
   antes `npm install`) y no des nada por terminado hasta que esté en verde.
5. Cerrá con tres cosas: qué agregaste y dónde, qué descartaste y por qué, y
   la lista de preguntas que solo yo puedo responder.

## Reglas duras

- CONFIDENCIALIDAD — en máquinas corporativas esto es lo primero: este repo
  es personal, así que se guarda el patrón, nunca el activo de la empresa.
  Sin nombres de clientes finales, sin endpoints ni rutas reales, sin
  esquemas de datos, sin URLs internas, sin credenciales, sin código copiado.
  «Módulo de reservas con máquina de estados e integración con un sistema
  externo» sí; el nombre de la tabla, no.
- NO inventes: fechas solo de `git log`; títulos de puesto y seniority no
  salen del código — dejámelos como preguntas. Toda inferencia, marcada como
  inferencia.
- NO modifiques hechos ya cargados salvo error demostrable, y citá la fuente
  de cada hecho nuevo en un comentario junto al dato.
- NO hagas commit ni push: eso lo decido y lo hago yo.
- Si un repo no tiene commits míos, listalo en una línea y no lo explores.
