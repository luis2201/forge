# ADR-011 — Estado Git vivo y resolución visual explícita

- Estado: aceptada en Fase 3
- Fecha: 2026-08-16

## Contexto

La UI, la terminal integrada y herramientas externas pueden modificar simultáneamente el mismo repositorio. Mantener un modelo mutable paralelo en Forge causaría divergencia. Resolver conflictos escribiendo directamente sin control de concurrencia también podría perder cambios externos.

## Decisión

- Consultar el Git CLI para todo estado derivado y no persistir estado Git en SQLite.
- Usar eventos del watcher para archivos y metadata `.git`, eventos de dominio después de comandos gráficos y debounce controlado en el renderer.
- Refrescar detalles completos cuando cambia metadata Git y sólo el overview para archivos de trabajo ordinarios.
- Obtener base/local/remoto desde los stages 1/2/3 del índice y presentar local/remoto/resultado con Monaco.
- No preparar automáticamente un conflicto: exigir “Marcar como resuelto”, rechazar marcadores restantes y comprobar SHA-256 antes de escritura atómica + `git add` o `git rm`.

## Consecuencias

- Una operación realizada en cualquiera de las interfaces queda visible en las demás sobre el mismo repositorio real.
- No se necesita polling agresivo ni esquema de persistencia adicional.
- Los conflictos de texto UTF-8 de hasta 5 MiB tienen resolución visual; binarios y codificaciones no soportadas fallan de forma segura.
- Un cambio concurrente obliga a recargar y revisar; nunca se sobreescribe silenciosamente.

## Alternativas descartadas

- Copiar status/ramas/commits a SQLite: duplica la fuente de verdad y requiere invalidación compleja.
- Polling frecuente: consume procesos y batería aunque no haya actividad.
- Marcar resuelto al pulsar “aceptar local/remoto”: confunde selección de contenido con autorización del efecto Git.
