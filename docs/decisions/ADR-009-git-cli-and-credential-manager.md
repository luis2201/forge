# ADR-009 — Git CLI acotado y autenticación delegada

- Estado: aceptada en Fase 3
- Fecha: 2026-08-15

## Contexto

Forge necesita cubrir el flujo Git habitual y GitHub sin entregar una shell al renderer ni convertirse en custodio de tokens. La máquina objetivo ya dispone de Git for Windows y Git Credential Manager. Una librería Git embebida añadiría otra implementación, dependencias nativas y un flujo de autenticación diferente al que el usuario ya administra.

## Decisión

Usar el Git CLI instalado mediante un servicio exclusivo de Electron Main:

- resolver una ruta absoluta del ejecutable desde ubicaciones de instalación y entradas absolutas de `PATH`;
- ofrecer casos de uso nominados y esquemas IPC cerrados, nunca argumentos libres;
- ejecutar con `execFile`, `shell: false`, argumentos separados, timeout y buffers limitados;
- autorizar top-level y git-dir canónicos dentro del workspace;
- sanear overrides `GIT_*`, desactivar fsmonitor externo y bloquear protocolos/helper desconocidos;
- usar `pull --ff-only` y confirmaciones para operaciones destructivas;
- delegar credenciales por completo a Git Credential Manager y no persistir tokens en Forge.
- detectar la identidad efectiva antes del commit y ofrecer configuración `--local` guiada cuando falten `user.name` o `user.email`;
- impedir el push de una rama sin commit inicial y devolver una recuperación comprensible en lugar del error `src refspec`.

## Consecuencias

- Git for Windows es un prerrequisito funcional y se informa con un error accionable si falta.
- El comportamiento de credenciales, SSH y rotación conserva la configuración Git existente del usuario.
- Los linked worktrees con git-dir fuera de la root se rechazan deliberadamente en esta fase.
- GitHub Enterprise no recibe todavía la tarjeta web específica, aunque los remotos Git seguros pueden seguir usándose.
- Hooks y filtros del repositorio pueden ejecutarse durante acciones Git explícitas; los repositorios desconocidos deben considerarse no confiables y no se automatizan desde IA.

## Alternativas descartadas

- `libgit2`/bindings: más superficie nativa, diferencias de compatibilidad y autenticación, y mayor coste de empaquetado.
- GitHub CLI como dependencia obligatoria: no está instalado en el entorno objetivo y no es necesario para el flujo Git solicitado.
- Guardar un PAT en SQLite: incumple la separación de secretos y duplica las capacidades de Credential Manager.
