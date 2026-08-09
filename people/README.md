# `people/` — los datos reales

Una carpeta por persona, con el slug como nombre: `people/jane-doe/`.
Para crear una nueva, `cv new <slug>` copia `_template/` y la deja lista para completar.

Si querés ver un perfil completo y bien escrito antes de empezar el tuyo, está en
`fixtures/people/jane-doe/`. Esa carpeta es ficticia y es contra la que corre el CI;
esta es la que tiene datos de verdad, y por eso las reglas de abajo no son opcionales.

## Qué se versiona y qué no

| Ruta | ¿Va a git? | Qué lleva |
|---|---|---|
| `<slug>/meta.yaml` | sí | locale primario, versión del modelo, consentimiento |
| `<slug>/profile/` | sí | toda la estructura y la narrativa del CV |
| `<slug>/i18n/` | sí | narrativa de los locales no primarios |
| `<slug>/targets/` | sí | arquetipos reutilizables |
| `<slug>/applications/` | sí | vacante, overlay, respuestas, carta, estado |
| `<slug>/contact.example.yaml` | sí | los mismos campos, con placeholders |
| **`<slug>/contact.private.yaml`** | **NO** | teléfono, dirección postal, documento |
| **`<slug>/jds/`** | **NO** | avisos crudos capturados |
| **`<slug>/applications/*/sent/`** | **NO** | los binarios que efectivamente se enviaron |

## Por qué la separación

`profile/` es el CV: nombre, mail, empresas, fechas, logros. Es información que ya
viaja en cada postulación y que su dueño quiere que se lea. Versionarla es lo que
permite ver qué cambió entre dos versiones del CV y por qué.

`contact.private.yaml` es lo otro: el teléfono, la dirección de tu casa, el número de
documento. Git no olvida — un dato que entró en un commit sigue estando después de
borrarlo del archivo, en cada clon, en cada fork y en cada backup. Manteniéndolo fuera
del árbol versionado, el repositorio sigue siendo clonable y el pipeline reproducible
sin que nadie quede expuesto.

El precio de esa separación es un paso de setup, y `contact.example.yaml` existe para
que sea uno solo:

```
cp people/<slug>/contact.example.yaml people/<slug>/contact.private.yaml
```

El cargador aplica ese archivo encima de `profile/basics.yaml` antes de validar, así
que los campos sensibles llegan al CV renderizado sin haber pasado nunca por git.

## Las otras dos reglas de datos ajenos

**Referencias: sólo iniciales y rol.** Nunca el teléfono ni el mail de un tercero.
Los datos de contacto de otra persona tienen una base legal distinta de los propios
bajo RGPD y Ley 25.326: esa persona aceptó que la llames vos, no que su número viva
en tu repositorio.

**Adjuntos escaneados: fuera del repo.** Certificados de trabajo, títulos, documentos.
Se referencian por ruta local y no se commitean nunca.
