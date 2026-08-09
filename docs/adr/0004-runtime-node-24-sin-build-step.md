# ADR-0004 — Stack de runtime: Node 24 sin build step, TypeScript sólo como type-checker

**Fecha:** 2026-08-07 · **Estado:** Aceptado

## Contexto

Node 24.13 ejecuta archivos `.ts` nativamente; el type stripping es **Stability: 2 (Stable)** desde
la v24.12.0. Verificado localmente: `node src/cli.ts` corre con exit 0 y cero warnings.

La pregunta es si conviene apoyarse en eso o mantener la cadena de herramientas habitual.

## Opciones evaluadas

**tsx / tsup / esbuild como runtime o bundler.** Resuelven un problema que Node 24 ya resolvió, y
cada uno agrega una dependencia al arranque de un CLI donde el cold start es tiempo real que el
usuario espera.

**Monorepo (Turborepo / Nx) con workspaces.** Infraestructura para una escala que este proyecto no
tiene. Si algún día hace falta, migrar a workspaces cuesta una tarde; mantener Turborepo desde el
día uno cuesta todos los días.

**Bundling del CLI.** Innecesario sin publicación a npm.

## Decisión

Proyecto **único**, sin bundler y sin workspaces. `package.json` con `"type": "module"` y scripts que
invocan `node src/cli.ts` directo. TypeScript es **exclusivamente** `tsc --noEmit`, en pre-commit y
en CI. El CLI se arma con **commander@15**, que es zero-dependency.

## Consecuencias

Trampas duras, todas verificadas ejecutando código:

- **`enum` → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` en runtime.** Prohibido por convención; se usa
  `as const` + union types. Lo mismo con **parameter properties** (`constructor(private x: T)`),
  **namespaces con valores** y **decoradores**.
- Los imports locales **exigen** extensión `.ts` explícita: `from './lib'` da `ERR_MODULE_NOT_FOUND`.
- Sin `"type": "module"`, Node trata los `.ts` como CommonJS y **el error no menciona TypeScript**
  por ningún lado, lo que hace el diagnóstico largo.
- **`typescript` pinneado a `~6.0.3`.** `typescript@latest` trae 7.0.2 y `typescript-eslint@8.66.0`
  declara `peerDependencies: { typescript: ">=4.8.4 <6.1.0" }`. Revisitar cuando salga TS 7.1 con
  soporte de typescript-eslint.
- `tsconfig.json` obligatorio: `module` y `moduleResolution` en `nodenext`, `strict`, `noEmit: true`,
  **`erasableSyntaxOnly: true`** (hace que falle `tsc` en desarrollo en vez de Node en producción),
  `allowImportingTsExtensions: true` y `verbatimModuleSyntax: true`. **No** poner
  `rewriteRelativeImportExtensions`: con `noEmit` no hace absolutamente nada.
- **Todo el pipeline es Node**, incluida la extracción de texto del PDF para el linter (ADR-0006).
  No se introduce Python en el camino crítico.
- Beneficio principal: editar un `.ts` y correr el CLI es un solo paso. No hay un artefacto compilado
  que pueda estar desactualizado respecto del fuente, que es una clase entera de bugs que
  simplemente no existe.
