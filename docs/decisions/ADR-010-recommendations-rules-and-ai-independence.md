# ADR-010 — Recomendaciones determinísticas e independencia de IA

- Estado: aceptada en Fase 3
- Fecha: 2026-08-16

## Contexto

Git necesita explicar divergencia, conflictos, riesgos y posibles nombres sensibles. Otros módulos futuros necesitarán recomendaciones equivalentes. Resolverlo dentro de la UI Git produciría texto no reutilizable y acoplaría la futura asistencia de IA a capacidades funcionales.

## Decisión

- Mantener `RecommendationEngine` y `NotificationCenter` como capacidades generales del core.
- Producir recomendaciones estructuradas con identidad, fuente, severidad, mensaje, detalles, acciones, timestamp y contexto.
- Expresar las decisiones actuales mediante `DeterministicRule<TContext>`; el motor no depende de red ni IA.
- Implementar `GitAdvisor` como adaptador de contexto Git sobre el motor general.
- Separar `GitRiskPolicy` de las recomendaciones: una recomendación informa, mientras una política aplicada en Main puede bloquear o exigir confirmación.
- Establecer la jerarquía: seguridad > reglas determinísticas > autorización explícita > recomendación de IA futura.
- Prohibir dependencias directas de módulos funcionales hacia proveedores/modelos de IA.

## Consecuencias

- UI, automatizaciones futuras y una IA opcional pueden consumir el mismo modelo sin analizar texto libre.
- Las reglas son unit-testables, reproducibles y completamente funcionales offline.
- Una IA futura puede proponer explicaciones o acciones, pero no omitir políticas, contratos IPC ni confirmaciones.
- `NotificationCenter` es deliberadamente en memoria; Git sigue siendo fuente de verdad y las recomendaciones se regeneran desde su estado real.

## Alternativas descartadas

- Reglas embebidas en componentes React: mezcla decisión, presentación y efectos.
- Guardar recomendaciones Git como estado permanente: se volverían obsoletas respecto al repositorio real.
- Implementar primero un proveedor de IA: introduciría una dependencia no requerida y violaría la funcionalidad offline.
