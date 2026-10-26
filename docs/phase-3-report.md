# Informe de cierre arquitectónico — Fases 0 a 3

- Versión: 0.3.3
- Plataforma validada: Windows, Electron 43, Node 22+
- Fecha: 2026-08-16
- Alcance: revisión integral y cierre de Fase 3; Fase 4 no iniciada

## Estado por fase

```text
FASE 0: COMPLETADA Y REVALIDADA
FASE 1: COMPLETADA Y REVALIDADA
FASE 2: COMPLETADA Y REVALIDADA
FASE 3: COMPLETADA Y REVALIDADA
```

### Fase 0

Se mantienen arquitectura Main/Preload/Renderer, renderer no privilegiado, CSP, sandbox, IPC cerrado con Zod, Command Bus, Event Bus, persistencia SQLite migrada, errores normalizados y logging estructurado/redactado. No existe ejecución genérica de shell, filesystem o Git desde el renderer.

### Fase 1

Electron, React, TypeScript, workspaces, recientes, configuración, layout y SQLite continúan operativos. La superficie del preload se verifica por E2E y el cierre con documentos sucios conserva los servicios cuando el usuario cancela.

### Fase 2

Explorer, CRUD confinado, Papelera, Monaco, pestañas, guardado atómico con versión SHA-256, búsqueda, watcher y PTY PowerShell continúan operativos. El E2E edita/guarda, resuelve cambios externos, busca y conserva una sesión real de terminal.

### Fase 3

El Git Engine usa el repositorio real como única fuente de verdad. La UI y terminal integrada comparten root y repositorio; cambios desde terminal o Git externo refrescan estado, rama, archivos, identidad e historial por watcher/eventos con debounce. Se añadieron init, identidad Git guiada, rama inicial, remotos, origin, primer push/upstream, comandos equivalentes, HEAD local/remoto, stash count, últimos commits, ahead/behind/divergencia, estado de remoto, conflictos tipados y resolución visual Monaco.

El ajuste 0.3.3 bloquea pull/push previsiblemente incorrectos cuando ambas historias divergen. El asistente usa fetch como comprobación, muestra commits y archivos exclusivos, permite comparar diffs, ofrece Merge/Rebase de forma explícita, trata el working tree sucio sin stash automático, reutiliza Monaco ante conflictos reales y verifica integración y push hasta `↑0 ↓0`. Merge es la recomendación inicial, no una selección silenciosa.

La escala tipográfica se centralizó mediante tokens CSS y el texto normal de paneles, controles, listas, Git, tabs, estado y terminal parte de 11 px. Monaco y xterm conservan tamaños independientes.

Git y GitHub permanecen separados. GitHub interpreta remotos `github.com` y abre una URL validada; Git/GCM/SSH gestionan autenticación. Forge no recibe ni persiste tokens.

## Pruebas ejecutadas

- `format:check`: aprobado.
- ESLint con cero warnings: aprobado.
- TypeScript renderer + main/preload: aprobado.
- Unitarias e integración: 43/43 en 11 archivos.
- Git real temporal: init/status/diff/stage/unstage/commit/branches/checkout/merge/rebase/abort/remotos/first push/pull/fetch/ahead/behind/divergencia/stash/conflictos/resolución/push final/Papelera.
- Recommendation Engine, Rules Engine, NotificationCenter, Git Advisor y GitRiskPolicy: aprobados.
- Seguridad: traversal, overrides `GIT_*`, protocolo `ext::`, URL con credenciales, comando genérico y redacción de URL: aprobados.
- E2E Electron desde fuentes: 8/8.
- E2E sobre `release/win-unpacked/Forge.exe`: 8/8.
- `npm audit --audit-level=moderate`: 0 vulnerabilidades.

Los recorridos E2E incluyen aislamiento del renderer, edición/terminal, cierre sucio, flujo Git UI, init + detección/configuración de identidad + commit desde terminal + cambio externo + remoto + first push, asistente divergente completo, conflicto visual real y confirmación de nombre sensible. El E2E divergente valida además que los textos críticos muestreados calculen al menos 11 px y genera una captura visual con Source Control, Advisor, commits, ramas y terminal visibles.

## Build

- `npm.cmd run build`: aprobado.
- `npm.cmd run package:win`: aprobado.
- Artefacto validado: `release/win-unpacked/Forge.exe` versión 0.3.3.
- Inicio del ejecutable empaquetado y acceso a SQLite, node-pty, Monaco, Git y preload: aprobado por los mismos ocho recorridos E2E.

## Problemas corregidos

- Commit fallido por ausencia de `user.name`/`user.email` sin recuperación guiada; ahora se detecta antes, se configura localmente desde la UI y Main vuelve a validarlo.
- Push de una rama sin commit inicial que mostraba `src refspec ... does not match any`; ahora se bloquea antes de contactar el remoto y explica el paso faltante.
- El botón de actualización manual no refrescaba los detalles del repositorio ya seleccionado; ahora relee estado, identidad, ramas e historial.
- Estado Git ampliado para no confundir working tree local, referencias remotas y GitHub.
- Sincronización incompleta después de commits/checkouts desde terminal o herramientas externas.
- Ausencia de inicialización/configuración de origin/primer upstream desde UI.
- Falta de transparencia sobre comandos equivalentes.
- Falta de detección explícita de divergencia, stash, último commit y HEAD remoto.
- Conflictos visibles pero sin resolución visual; ahora hay local/remoto/resultado y confirmación explícita.
- Duplicación visual de un archivo conflictivo como preparado y no preparado.
- Ausencia de una arquitectura reusable de recomendaciones y reglas.
- Operaciones de riesgo protegidas sólo por texto genérico; ahora incluyen contexto, consecuencias y enforcement en Main.
- Commits de nombres sensibles sin advertencia; ahora los patrones son configurables y conocen `.gitignore`.
- URLs de remoto con credenciales y valores embebidos en logs no estaban cubiertos por la política completa de redacción.
- Esperas E2E que confundían el estado transitorio de Git con un fallo definitivo.
- Pull fast-forward ofrecido pese a una divergencia ya conocida; ahora se sustituye por Resolver sincronización y Main también lo bloquea.
- Push permitido con commits remotos pendientes; ahora se impide hasta integrar.
- Los conflictos emitidos por Git parcialmente en `stdout` se clasificaban como error genérico; la frontera de proceso analiza ambas salidas y conserva el detalle técnico de forma secundaria.
- No existía una comparación estructurada de commits/archivos exclusivos ni una continuación explícita de Merge/Rebase tras resolver conflictos.
- Textos críticos de Source Control usaban 7–10 px dispersos; ahora consumen una escala tipográfica centralizada con base de 11 px.
- El crecimiento tipográfico podía dejar el área desplazable de cambios Git con altura cero en un panel estrecho; Source Control ahora desplaza el panel completo sin solapar controles ni la barra de estado.
- La limpieza temporal en pruebas Windows podía competir con la liberación de handles de ConPTY/Chromium; las pruebas aplican cierre acotado y reintentos de borrado únicamente sobre sus directorios temporales.

## Problemas conocidos no críticos

- Git for Windows es prerrequisito; si falta se devuelve un error accionable.
- `gh` no está instalado en el entorno validado. No se hizo dependencia obligatoria: Git Credential Manager está disponible y mantiene la autenticación fuera de Forge.
- Linked worktrees cuyo git-dir queda fuera del workspace se rechazan por confinamiento.
- La tarjeta web específica soporta `github.com`; GitHub Enterprise requiere una decisión futura.
- Hooks y filtros del repositorio pueden ejecutar código al invocar operaciones Git explícitas. No se automatizan y los repositorios desconocidos deben tratarse como no confiables.
- Los conflictos binarios, no UTF-8 o mayores de 5 MiB se detectan pero no se editan visualmente.
- Vite informa chunks grandes de Monaco; Monaco y el resolver están cargados de forma diferida. Es un asunto de rendimiento, no de corrección.
- electron-builder informa referencias transitorias duplicadas (`once`, `pump`, `readable-stream`, `end-of-stream`); npm resolvió el árbol, el audit reporta cero vulnerabilidades y el paquete/E2E son correctos.
- El paquete conserva icono predeterminado y metadatos de branding mínimos; no bloquea el uso funcional local.

No existen defectos críticos conocidos en el alcance de Fases 0–3.

## Decisiones arquitectónicas

- ADR-009: Git CLI acotado y autenticación delegada.
- ADR-010: recomendaciones determinísticas e independencia de IA.
- ADR-011: estado Git vivo y resolución visual explícita.
- ADR-012: sincronización Git divergente explícita.
- Git es fuente de verdad; no se crea una tabla ni estado Git paralelo.
- `git.changed` y `file.changed` evolucionan la arquitectura existente; no se creó un bus paralelo.
- Las recomendaciones son estructuradas y generales; Git Advisor es un consumidor, no el propietario del motor.
- Las políticas de riesgo se aplican en Main, aunque la UI también explique y confirme.

## Estado Git/GitHub

Git local funciona sin GitHub y sin red. Soporta repositorios root/anidados, estado completo, diffs, staging, commits, ramas, merge, rebase de sincronización, fetch/pull FF/push y configuración de origin. La UI distingue local/remoto, muestra remoto no disponible y no ejecuta pull/merge/rebase para inspeccionar. Una divergencia se analiza mediante merge-base y rangos exclusivos; la integración sólo ocurre tras una decisión explícita.

GitHub es una integración remota separada. Las credenciales se delegan a Git Credential Manager/Git/SSH/almacén del sistema; no hay token en IPC, renderer, SQLite, configuración ni logs. Vincular un repositorio existente se realiza configurando un remoto seguro. Crear repositorios mediante `gh` no se habilita porque `gh` no está disponible y no se simula esa capacidad.

## Recommendation Engine

`RecommendationEngine` produce `id`, `source`, `severity`, `title`, `message`, `details`, `actions`, `timestamp` y `context`. `NotificationCenter` agrega por workspace/fuente. Las reglas determinísticas del Git Advisor cubren conflicto, identidad/commit inicial ausentes, divergencia, working tree sucio antes de sincronizar, ausencia de remoto/upstream, ahead/behind, stash y nombres sensibles. Funciona offline y sin IA.

## Preparación futura para IA

No se integró proveedor, modelo, SDK ni clave de IA. Los módulos exponen contexto estructurado reutilizable y son completamente funcionales sin IA. Se documenta y aplica la jerarquía:

```text
Seguridad
  > reglas determinísticas de Forge
  > autorización explícita del usuario
  > recomendación de IA futura
```

Una futura recomendación de IA no podrá omitir validaciones, políticas de riesgo ni confirmaciones.

## Conclusión

```text
Sincronización Git divergente:
APROBADA

Resolución visual de conflictos:
APROBADA

Sincronización UI/Terminal:
APROBADA

Git Advisor:
APROBADO

UI base 11 px:
APROBADA

Build:
APROBADO

FASE 3:
APTA PARA CIERRE
```

La Fase 4 no fue iniciada. El desarrollo se detiene en el cierre estable de Fase 3 y queda a la espera de una instrucción explícita.
