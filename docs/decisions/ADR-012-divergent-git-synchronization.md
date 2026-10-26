# ADR-012 — Sincronización Git divergente explícita

## Contexto

Una rama con commits locales y remotos exclusivos no puede actualizarse mediante fast-forward. Ofrecer `pull` como acción primaria produce un fallo previsible y no explica que divergencia y conflicto son estados distintos.

## Decisión

- `fetch` es la operación de comprobación remota; no integra cambios.
- `GitStatus` sigue siendo la vista viva del repositorio. No se persiste ni duplica estado Git.
- Cuando `ahead > 0 && behind > 0`, Main bloquea `pull --ff-only` y `push` antes de ejecutar una operación inadecuada.
- `GitSyncAnalysis` deriva desde Git el merge-base, commits exclusivos, archivos afectados por lado, solapamientos, working tree, conflictos y operación activa.
- La UI ofrece comparación previa y una decisión explícita entre Merge y Rebase. Merge aparece recomendado inicialmente, pero nunca se ejecuta sin confirmación.
- Un working tree sucio requiere revisar, crear commit, autorizar stash o cancelar. No existe stash automático.
- Un conflicto real reutiliza el resolver Monaco local/remoto/resultado y exige guardar y preparar explícitamente. Después se continúa o aborta la operación nominada.
- Tras integrar y tras publicar, Forge vuelve a consultar el estado real hasta verificar `ahead=0`, `behind=0`.

## Consecuencias

- Los fallos fast-forward previsibles se convierten en prevención y guía contextual.
- La comparación estructurada queda disponible para una futura capa de IA sin introducir una dependencia de IA.
- Merge/Rebase pueden ejecutar hooks o filtros del repositorio; continúan siendo acciones conscientes del usuario y sujetas a las reglas de seguridad existentes.
- La implementación añade comandos IPC cerrados; no añade un ejecutor Git genérico ni force push.

## Alternativas descartadas

- Elegir automáticamente la estrategia configurada globalmente por Git: oculta una decisión con efectos sobre el historial.
- Ejecutar `pull` y explicar el error después: el estado ya permite anticiparlo.
- Asumir conflicto cuando ambos lados modifican el mismo archivo: Git debe determinar si las zonas son incompatibles.
- Mantener un grafo Git paralelo en SQLite: crea desincronización con terminal y herramientas externas.

## Estado

Aceptada en Fase 3, Forge 0.3.3.
