# ADR-0005 — Estructura de directorios: partición por persona, ejes de configuración compartidos

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

El espacio del problema es N personas × M idiomas × K arquetipos × J vacantes × F formatos.

**No existe prior art de multi-persona en herramientas de autoría.** RenderCV es "un YAML = un CV".
Reactive Resume resuelve N personas con cuentas y una base Postgres, que es otra categoría de
producto. Hay que diseñar la partición desde cero.

## Opciones evaluadas

**Una carpeta por combinación.** Explota de inmediato: 10 regiones × 7 industrias × 5 seniorities son
350 artefactos que hay que mantener sincronizados a mano.

**Una rama de git por variante.** No escala, no permite comparar dos variantes lado a lado —que es
justo lo que uno quiere hacer— y convierte propagar un cambio del perfil maestro en N merges.

**Monorepo con workspaces npm.** Infraestructura desproporcionada; ver ADR-0004.

**Partición de primer nivel por persona, con ejes de configuración compartidos.**

## Decisión

Partición de primer nivel `people/<slug>/`. Los temas, los perfiles regionales, los de industria y
la taxonomía viven **compartidos en la raíz** (`config/`, `themes/`). La combinatoria **se
materializa en tiempo de build, nunca en el filesystem**. Las variantes son **directorios**, no
ramas.

```
people/<slug>/
├─ meta.yaml
├─ profile/            estructura + narrativa en el locale primario
├─ i18n/<locale>.yaml  sólo narrativa de los demás locales
├─ contact.private.yaml   (gitignored) / contact.example.yaml (commiteado)
├─ targets/<arquetipo>.yaml
├─ jds/                (gitignored)
└─ applications/YYYY-MM-DD--<empresa>--<rol>/
      job.raw.md  job.yaml  overlay.yaml  questions.yaml
      cover-letter.yaml  match-report.md  meta.yaml  sent/ (gitignored)
```

## Consecuencias

- Con 3 personas × 5 vacantes × 4 formatos se escriben **3 conjuntos `profile/` + 15 overlays
  pequeños**, no 60 archivos.
- Agregar una región o una industria es agregar **un** archivo en `config/`, y queda disponible para
  todas las personas a la vez.
- La estructura por persona hace que la regla de privacidad de ADR-0010 sea expresable en dos líneas
  de `.gitignore` (`contact.private.yaml`, `people/*/applications/*/sent/`), en vez de depender de
  que nadie se equivoque al commitear.
- El nombre de directorio de una postulación —`YYYY-MM-DD--<empresa>--<rol>`— ordena
  cronológicamente solo y es el identificador natural para los comandos del CLI.
- Costo aceptado: hay una sola persona "activa" implícita por comando, así que los comandos llevan el
  slug como primer argumento. A cambio, no hay estado global ni "persona seleccionada".
