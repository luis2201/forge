# Forge

Forge será un entorno de desarrollo de escritorio, orientado inicialmente a Windows, que agrupa el trabajo diario alrededor de un **workspace**: código, terminal, Git, bases de datos, APIs, servidores, Docker, despliegues, logs e IA contextual.

## Estado

**Fases 0–4 revalidadas. Fase 4 — Bases de datos: implementada en Forge 0.4.0.**

Forge permite trabajar sobre el mismo repositorio Git real desde la UI, la terminal integrada y herramientas externas. Incluye init/origin/primer push, detección y configuración local de identidad Git, estado local-remoto, asistente de divergencia con comparación y Merge/Rebase explícitos, comandos equivalentes, recomendaciones determinísticas, protecciones de riesgo/nombres sensibles y resolución visual de conflictos con Monaco. La interfaz usa una escala tipográfica centralizada con 11 px como base, separada de Monaco y xterm. GitHub se reconoce como integración separada y la autenticación se delega a Git Credential Manager/Git; Forge no almacena tokens.

Forge incorpora un workbench de bases de datos para MySQL, PostgreSQL y SQLite: perfiles por workspace/entorno, contraseñas cifradas por Windows, conexión y catálogo, tablas/vistas, estructura, Monaco SQL, resultados acotados, CRUD gráfico en la grilla con controles según el tipo de columna, historial, CSV/JSON y confirmaciones reforzadas para producción. Los tres adaptadores se validan contra motores reales.

Forge funciona completamente sin GitHub y sin inteligencia artificial. SQLite y el flujo local funcionan sin red.

## Documentación

- [Especificación de Fase 0](docs/phase-0-specification.md)
- [Arquitectura y contratos](docs/architecture.md)
- [Seguridad](docs/security.md)
- [Modelo inicial de datos](docs/data-model.md)
- [Pruebas y criterios de aceptación](docs/testing-and-acceptance.md)
- [Informe de cierre de Fase 1](docs/phase-1-report.md)
- [Informe de cierre de Fase 2](docs/phase-2-report.md)
- [Informe de cierre de Fase 3](docs/phase-3-report.md)
- [Informe de cierre de Fase 4](docs/phase-4-report.md)
- [Decisiones arquitectónicas](docs/decisions/README.md)

## Desarrollo

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run verify
```

El ejecutable Windows validado queda en `release/win-unpacked/Forge.exe` después de `npm.cmd run package:win`.

## Validación

`npm.cmd run verify` ejecuta formato, lint, tipos, pruebas unitarias y de integración, E2E en Electron, empaquetado Windows y E2E sobre el ejecutable generado.

## Próximo hito

La Fase 5 incorporará el cliente API del Prompt Maestro. No se han añadido controles ficticios de esa fase.
