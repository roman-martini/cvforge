# Preguntas pendientes del perfil

Salieron del relevamiento de los repos de AVAIN Sistemas (2026-10-30). Solo
vos podés responderlas: los repos no lo dicen. Cada una indica qué archivo del
perfil se completa con la respuesta. Cuando la respondas, cargá el dato donde
dice y borrá la pregunta.

## Para poder renderizar la experiencia en AVAIN

1. **Título del puesto** en AVAIN (y si cambió, cada etapa con su fecha).
   Hoy dice `"PENDIENTE"`. → `profile/work.yaml`, `positions[].title`
2. **Fecha real de ingreso.** Hoy figura 2024-07, que es tu primer commit y no
   la fecha de contrato; el primer commit en un producto es de 2024-10.
   → `profile/work.yaml`, `positions[].startDate`
3. **Seniority** en cada etapa. → `profile/work.yaml`, `positions[].seniority`
4. **Cómo presentar la relación laboral**: el perfil previo dice facturación
   como monotributista, pero usás email corporativo. ¿Va como empleo, como
   contrato o como consultoría? → `profile/work.yaml`
5. **Industria**: "Software para salud" está inferido del dominio. ¿Es correcto
   o lo describís de otra forma? → `profile/work.yaml`, `company.industry`
6. **Ubicación y modalidad** (ciudad, remoto o híbrido). → `profile/work.yaml`,
   `location`

## Para que el CV entre en el presupuesto

7. Con AVAIN cargado, el CV ocupa 3 páginas y el arquetipo permite 2. ¿Qué
   preferís: recortar proyectos personales, recortar bullets de AVAIN (hay 13
   y el rango es de 3 a 6) o subir el límite a 3 páginas?
   → `targets/general.yaml` u overlay
8. **Aprobación de los 13 bullets de AVAIN**: están en `llm_draft`. Leelos y
   pasá a `llm_approved` los que firmes. → `profile/work.yaml`

## Rol y equipo

9. ¿Trabajabas solo o en equipo? ¿De qué tamaño era, contando a quienes no
   commitean (líderes, QA, diseño)?
10. ¿Tenías un rol formal además de desarrollador (referente técnico,
    responsable de plataforma, revisor)? ¿Aprobabas los PRs de otros? Hay 70
    merges hechos por vos, 6 sobre ramas de otro desarrollador.
11. El UI kit corporativo, ¿fue iniciativa tuya o un encargo?

## Cifras de impacto (no están en los repos)

12. **Uso en producción**: clientes o instituciones, videoconsultas por mes,
    exámenes y certificados emitidos, consultas por QR, usuarios de los
    dashboards.
13. El **~81 % de ahorro de relay TURN** salió de pruebas controladas con una
    muestra por escenario. ¿Se confirmó en la facturación real después del
    deploy?
14. **API de mensajería**: ¿hay fecha de salida a producción y volumen real de
    envíos? ¿El cálculo de costo por cliente se usa para facturar?
15. **Pipelines**: ¿cuánto tiempo estuvo frenado el despliegue automático antes
    del arreglo? ¿Hay métricas de frecuencia, tiempo de deploy o fallos
    evitados?
16. ¿Hay métricas de productividad atribuibles al UI kit (pantallas
    reemplazadas, tiempo de desarrollo)?

## Autoría (para no atribuirte de más ni de menos)

17. El repo central de pipelines arrancó con un commit "Inicial limpio" que ya
    traía la estructura. ¿La diseñaste vos o la importaste de trabajo previo?
18. El kit de arquitectura hexagonal de la API de mensajería, del que vienen
    sus primeros 7 ADRs, ¿es tuyo?
19. El query builder de la API de monitoreo, ¿es diseño tuyo o vino de otro
    proyecto?
20. La documentación técnica consolidada (diagramas C4, guías de arquitectura),
    ¿cuánto es tuyo y cuánto agrupaste de otros?
21. La librería CSS previa al UI kit, ¿la creaste vos o solo la integraste y
    publicaste?
22. El prototipo de videoconsulta de 2025 en tu sandbox, ¿fue el antecedente
    del front de videoconsulta actual? ¿Hubo una versión anterior a la
    reescritura de 2025-09?
23. ¿Qué relación hay entre tu design system personal open-source y el UI kit
    corporativo, y qué se puede decir públicamente sin exponer a la empresa?

## Estado de cosas que el código no muestra

24. ¿El front del panel de mensajería está publicado o desplegado en algún
    lado? No tiene remoto configurado.
25. ¿El front de monitoreo con el UI kit está desplegado en producción? Hubo un
    rollback el 2026-07-01.
26. ¿Las versiones del UI kit se publicaron de verdad en el feed privado?
    ¿Otros desarrolladores lo consumen?
27. El incidente de timeout del monitoreo, ¿se resolvió? ¿Se confirmó la causa?
28. ¿El error de concurrencia del pool SQL llegaba a producción? ¿Con qué
    frecuencia?
29. ¿La app de monitoreo embebida en el sistema .NET legado sigue en uso?

## Perfil

30. ¿Subo SQL Server de `intermediate` a `advanced`? La evidencia nueva (MERGE,
    OPENJSON, bloqueos en unit of work, paginación keyset, migraciones
    versionadas en 7 repos) lo justifica. → `profile/skills.yaml`
31. ¿Cómo querés presentar el desarrollo asistido por IA en el trabajo de
    AVAIN (OpenSpec, agentes de Claude Code)? Hoy figura en un bullet.
