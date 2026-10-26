# Informe de cierre — Fase 2

Fecha de cierre: 2026-08-12  
Versión: 0.2.0

## Resultado

La Fase 2 convierte Forge en un entorno utilizable para trabajar sobre código fuente:

- explorador lazy de la root autorizada, con creación, renombrado y papelera;
- archivos de texto en pestañas Monaco, lenguajes, tema, cursor, dirty state y `Ctrl+S`;
- escritura atómica y control de concurrencia por SHA-256;
- watcher de cambios externos con recarga segura y resolución explícita de conflictos;
- búsqueda de texto acotada con navegación a archivo y línea;
- terminal PowerShell real mediante xterm.js, FitAddon y `node-pty`;
- panel lateral e inferior redimensionables y layout persistente;
- confirmaciones ante cierre, recarga o eliminación con cambios locales;
- IPC nominal validado, sin acceso Node ni API genérica en el renderer.

No fue necesaria una migración de base de datos: el layout y los workspaces reutilizan el esquema de Fase 1.

## Evidencia

| Gate                                    | Resultado                                 |
| --------------------------------------- | ----------------------------------------- |
| Prettier                                | Correcto                                  |
| ESLint                                  | Correcto, cero warnings                   |
| TypeScript renderer/main                | Correcto                                  |
| Unitarias e integración                 | 18/18 correctas en 9 archivos             |
| E2E Electron desde fuente               | 3/3 correctas                             |
| Build renderer/main/preload             | Correcto                                  |
| Paquete Windows x64                     | `release/win-unpacked/Forge.exe` generado |
| E2E sobre `Forge.exe`                   | 3/3 correctas                             |
| SQLite y PTY nativos dentro del paquete | Correcto mediante los recorridos E2E      |
| `npm audit`                             | 0 vulnerabilidades                        |

Los E2E recorren el estado vacío y la superficie segura del preload; luego abren un workspace real, editan y guardan, provocan un conflicto externo, crean y buscan un archivo y ejecutan un comando en el PTY que escribe evidencia en disco.

## Defectos encontrados y corregidos

1. Monaco 0.56 incorporaba una dependencia vulnerable: se fijó 0.53.0 y el audit quedó limpio.
2. Reconstruir `node-pty` para Electron requería librerías Spectre no disponibles aunque el paquete ya proveía N-API: se limita `electron-rebuild` a SQLite y se valida el prebuild PTY dentro del `.exe`.
3. Una versión basada en timestamp y tamaño no detectaba cambios externos del mismo tamaño: se sustituyó por SHA-256 y se añadió prueba.
4. Resolver un symlink antes de renombrar/eliminar podía actuar sobre el destino: esas operaciones resuelven ahora el padre y manipulan el enlace.
5. Recargar un documento sucio podía perder cambios: ahora exige confirmación; cerrar pestaña, workspace o ventana también protege el dirty state.
6. Los modelos Monaco podían cruzarse entre workspaces con la misma ruta y quedar vivos tras cerrar: el URI incluye `workspaceId` y los modelos se liberan.
7. El contenido tecleado mientras terminaba un guardado podía ser reemplazado por la instantánea guardada: la respuesta actualiza solo `savedContent`/versión y preserva el buffer actual. El E2E que reveló la carrera pasó después tres veces consecutivas.
8. Un timeout externo alrededor de `electron.launch` podía dejar un proceso huérfano y era insuficiente para el primer arranque empaquetado: se usa el timeout nativo de Playwright.
9. Cancelar la salida después de `before-quit` dejaba la ventana abierta con SQLite ya cerrado: la liberación ocurre ahora en `will-quit` y existe una regresión E2E.
10. Cambiar el tema u ocultar el panel destruía la sesión PowerShell: el tema se actualiza en caliente y el PTY permanece montado; el E2E conserva una variable de sesión.
11. Monaco se superponía al botón para volver a mostrar la terminal: se corrigió el orden de capas y se prueba mediante un clic real, sin forzarlo.

## Criterios comprobados

Los once criterios de Fase 2 definidos en `testing-and-acceptance.md` están cubiertos por integración, E2E o inspección del paquete. En especial, los límites negativos prueban traversal, rutas absolutas, root protegida, nombres inválidos de Windows, archivos binarios/grandes y modificación concurrente.

## Observaciones no bloqueantes

- Monaco mantiene workers y un chunk de editor grandes; la carga diferida evita penalizar la pantalla inicial, pero la optimización adicional queda como trabajo de rendimiento futuro.
- El paquete conserva el icono predeterminado de Electron y no es un instalador firmado con certificado propio; sigue siendo un directorio ejecutable para uso personal.
- La terminal fija PowerShell en Windows. Perfiles configurables corresponden a una evolución posterior.

## Recorrido reproducible

1. Ejecutar `npm.cmd run package:win` y abrir `release/win-unpacked/Forge.exe`.
2. Abrir una carpeta, expandir el árbol y seleccionar un archivo de texto.
3. Editarlo y guardar con `Ctrl+S`; modificarlo externamente para verificar la decisión de conflicto.
4. Crear un archivo desde el explorador y encontrar texto desde Buscar.
5. Ejecutar un comando en la terminal y confirmar que su directorio actual es la root del workspace.
6. Ejecutar `npm.cmd run verify` para repetir el gate automatizado completo.
