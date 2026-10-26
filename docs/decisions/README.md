# Decisiones arquitectónicas

Formato para ADR futuros: contexto, decisión, consecuencias, alternativas y estado.

## Registro inicial

| ID      | Decisión                                           | Estado                       |
| ------- | -------------------------------------------------- | ---------------------------- |
| ADR-001 | Electron + React + TypeScript + Vite               | Aceptada por alcance maestro |
| ADR-002 | Renderer no privilegiado y preload mínimo          | Aceptada                     |
| ADR-003 | SQLite para metadata; secretos en almacén del SO   | Aceptada                     |
| ADR-004 | Workspace como agregado principal                  | Aceptada                     |
| ADR-005 | Command bus y event bus tipados                    | Aceptada                     |
| ADR-006 | Arquitectura modular con contratos compartidos     | Aceptada                     |
| ADR-007 | Terminal PTY explícito y acotado                   | Aceptada en Fase 2           |
| ADR-008 | Escritura atómica y versión de contenido SHA-256   | Aceptada en Fase 2           |
| ADR-009 | Git CLI acotado y autenticación delegada           | Aceptada en Fase 3           |
| ADR-010 | Recomendaciones determinísticas e independencia IA | Aceptada en Fase 3           |
| ADR-011 | Estado Git vivo y conflictos visuales              | Aceptada en Fase 3           |
| ADR-012 | Sincronización Git divergente explícita            | Aceptada en Fase 3           |
| ADR-013 | Adaptadores DB y secretos protegidos por el SO     | Aceptada en Fase 4           |

Las decisiones que incorporen nuevas capacidades privilegiadas deben evaluar mantenimiento, compatibilidad con Electron, dependencias nativas, licencia, seguridad y coste de empaquetado en Windows. Git continúa delegando credenciales a Git Credential Manager. Desde Fase 4, las contraseñas propias de bases de datos se protegen con `safeStorage`/DPAPI detrás de `SecretStore` y nunca se mezclan con Git.
