# Pruebas y criterios de aceptación

## 1. Estrategia

La pirámide de pruebas combina:

- unitarias para dominio, validadores, normalización de rutas y redacción;
- integración para SQLite, migraciones, IPC y servicios del main;
- E2E para los recorridos críticos dentro de Electron empaquetado o equivalente cercano.

Las pruebas de seguridad negativas son obligatorias en fronteras privilegiadas.

## 2. Matriz de Fase 1

| Área            | Pruebas mínimas                                                           |
| --------------- | ------------------------------------------------------------------------- |
| Workspaces      | crear, abrir, reabrir, cerrar, recientes, carpeta ausente                 |
| Rutas           | traversal, prefijo engañoso, casing Windows, symlink/junction, ruta larga |
| IPC             | comando desconocido, payload inválido, sender inválido, error sanitizado  |
| SQLite          | base nueva, migración, rollback, versión futura, restricciones FK         |
| Settings/layout | defaults, persistencia, JSON corrupto, actualización parcial              |
| Logging         | correlation ID, rotación, redacción de secretos, error de escritura       |
| Ventana         | aislamiento, Node inaccesible, CSP, navegación bloqueada                  |

## 3. Criterios de aceptación de Fase 1

1. La aplicación instala o ejecuta un build de Windows sin pasos manuales no documentados.
2. Arranca con una base nueva y aplica migraciones automáticamente.
3. Permite seleccionar una carpeta mediante diálogo nativo y abrirla como workspace.
4. Reiniciar Forge conserva recientes, preferencias y layout.
5. Una carpeta eliminada o inaccesible produce un mensaje accionable y no corrompe metadata.
6. El renderer no dispone de `require`, `process`, `fs`, `ipcRenderer` ni una API genérica de invocación.
7. Todos los comandos IPC de Fase 1 rechazan payloads fuera de esquema.
8. Las pruebas demuestran que una operación no puede escapar de la root autorizada.
9. CSP, bloqueo de navegación y apertura controlada de enlaces están activos en producción.
10. Logs y errores no exponen valores marcados como secretos en el corpus de pruebas.
11. Cerrar/eliminar metadata de un workspace no modifica los archivos del usuario.
12. `lint`, typecheck, unit, integration, E2E y build pasan en CI Windows.
13. No existen controles visibles que prometan módulos aún no implementados.
14. Los fallos recuperables se muestran con motivo y acciones sugeridas.

## 4. Matriz de Fase 2

| Área                | Pruebas mínimas                                                                 |
| ------------------- | ------------------------------------------------------------------------------- |
| Filesystem          | CRUD, papelera, traversal, absoluta, root protegida, symlink, binario, 5 MiB    |
| Concurrencia        | cambio externo con igual tamaño, conflicto local, recarga y overwrite explícito |
| Editor y pestañas   | abrir, editar, guardar, conservar escritura durante guardado, cierre sucio      |
| Búsqueda            | coincidencias, mayúsculas/minúsculas, exclusiones y límites                     |
| Terminal            | PTY real, `cwd` del workspace, entrada, salida, resize y cierre                 |
| Renderer seguro     | superficie exacta del preload; ausencia de `require` y `process`                |
| Empaquetado Windows | arranque, SQLite, Monaco, watcher y `node-pty` desde `Forge.exe`                |

## 5. Criterios de aceptación de Fase 2

1. El explorador navega la root autorizada y permite crear, renombrar y enviar elementos a la papelera.
2. Monaco abre archivos de texto en pestañas, aplica lenguaje/tema y guarda con `Ctrl+S`.
3. Ninguna escritura silenciosa reemplaza una versión del disco modificada fuera de Forge.
4. Seguir escribiendo mientras termina un guardado no pierde las pulsaciones posteriores.
5. Los cambios externos recargan archivos limpios y presentan una decisión explícita si hay cambios locales.
6. Cerrar pestaña, workspace o aplicación advierte cuando existen archivos sin guardar.
7. La búsqueda abre el resultado y navega a su línea sin salir de Forge.
8. La terminal local es interactiva, inicia en la root y libera su PTY al cerrar.
9. Persisten tema, tamaño del sidebar y estado/tamaño del panel inferior.
10. Los módulos nativos funcionan tanto en desarrollo como dentro del paquete Windows.
11. Formato, lint sin warnings, tipos, pruebas, auditoría y empaquetado pasan sin defectos bloqueantes.

## 6. Matriz de Fase 3

| Área                  | Pruebas mínimas                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Detección y límites   | root, repositorio anidado, traversal, git-dir externo y ausencia de repositorio                                                             |
| Estado y diff         | tracked, untracked, staged, HEAD local/remoto, stash, conflicto tipado, diff y límites                                                      |
| Flujo local           | init, identidad faltante/configuración local, stage, unstage, discard/Papelera, commit, rama, checkout, merge, resolver visual y abort      |
| Sincronización        | eventos terminal/externos, upstream, push, pull FF, fetch, bloqueo divergente, comparación, Merge/Rebase, stash autorizado y remoto caído   |
| GitHub y credenciales | remoto HTTPS/SSH, configuración de origin, redacción, URL validada y GCM sin token en Forge                                                 |
| IPC y proceso         | sin `git.exec`, revisión SHA validada, ejecutable absoluto, entorno saneado y `shell: false`                                                |
| Recomendaciones       | modelo estructurado, reglas determinísticas, Git Advisor, NotificationCenter y severidad                                                    |
| Riesgo y secretos     | confirmaciones en Main/UI, working tree sucio, patrones configurables y `.gitignore`                                                        |
| UI/E2E                | init, identidad, diff, commit, terminal, primer push, asistente divergente, conflicto visual, push final, tipografía base y nombre sensible |
| Empaquetado Windows   | mismo recorrido E2E sobre `Forge.exe`                                                                                                       |

## 7. Criterios de aceptación de Fase 3

1. Forge detecta repositorios dentro de la root autorizada sin aceptar escapes ni git-dir externos.
2. El panel muestra HEAD/rama local y remota, upstream, remotos, ahead/behind/divergencia, stash, operación activa y estado staged/unstaged/conflictivo.
3. Un usuario puede abrir diffs de archivos rastreados, nuevos, preparados y commits históricos.
4. Stage, unstage y commit operan sobre selecciones explícitas; no existe una API de argumentos Git arbitrarios.
5. Descartar exige confirmación y los archivos no rastreados van a la Papelera del sistema.
6. Crear/cambiar ramas, merge y abortar funcionan; los conflictos tipados se comparan y resuelven visualmente mediante una acción explícita.
7. Fetch, pull fast-forward y push funcionan; el primer push configura upstream cuando el remoto es inequívoco.
8. Una divergencia bloquea pull/push inadecuados y ofrece comparación de commits/archivos y Merge/Rebase explícitos, con Merge recomendado inicialmente.
9. Archivos distintos, el mismo archivo sin conflicto y un conflicto real se prueban por separado; el flujo termina en `ahead=0`, `behind=0` tras el push.
10. Un working tree sucio no se integra ni se guarda en stash sin decisión explícita.
11. El remoto GitHub se reconoce sin devolver credenciales y sólo se abre una URL HTTPS de `github.com` validada.
12. La autenticación se delega a Git Credential Manager; Forge no guarda ni registra tokens.
13. El proceso Git usa ejecutable absoluto, no shell, entorno saneado, protocolos permitidos, timeout y salida limitada.
14. El Recommendation Engine general, Rules Engine, NotificationCenter, Git Advisor y política de riesgo funcionan sin IA.
15. Los patrones sensibles son configurables y un commit coincidente exige confirmación reforzada.
16. Las operaciones de terminal/herramientas externas actualizan automáticamente la UI sin polling agresivo.
17. Los flujos de Fases 1 y 2 continúan pasando sin regresiones.
18. Si falta `user.name` o `user.email`, Forge lo advierte, ofrece configuración local y bloquea el commit; una rama sin commit inicial no intenta push.
19. La UI normal usa tokens centralizados con 11 px como base sin alterar arbitrariamente Monaco ni xterm.
20. Formato, lint, tipos, 43 pruebas, auditoría, ocho E2E fuente, build y ocho E2E empaquetadas pasan sin defectos bloqueantes.

## 8. Matriz de Fase 4

| Área                    | Pruebas mínimas                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Migración y perfiles    | migración 2, CRUD, unicidad, pertenencia al workspace y cierre de sesiones                                   |
| Secretos                | cifrado/descifrado, indisponibilidad segura, no retorno por IPC, reemplazo y borrado                         |
| SQLite                  | ruta confinada, creación/apertura, catálogo, estructura, query, paginación y busy timeout                    |
| MySQL/PostgreSQL        | conexión real, autenticación, catálogo, estructura, SELECT, mutación parametrizada y desconexión             |
| SQL y resultados        | sentencia única, punto y coma en strings, límite 1000, tipos serializables, timeout e historial              |
| Edición visual          | fila nueva inline, controles por tipo/default/NULL, update/delete por fila, PK obligatoria y vista read-only |
| Riesgo/entornos         | DROP/DELETE/ALTER y toda escritura en PRODUCCIÓN bloqueados hasta confirmación en Main                       |
| Importación/exportación | CSV/JSON, límites, columnas inválidas, rollback total, diálogo nativo y contenido exportado                  |
| UI/E2E                  | crear/probar conexión, árbol, datos, edición, consulta Monaco, historial, import/export y base tipográfica   |
| Regresión/empaquetado   | recorridos de Fases 1–3 y mismo flujo SQLite/cifrado sobre `Forge.exe`                                       |

## 9. Criterios de aceptación de Fase 4

1. Los perfiles MySQL, PostgreSQL y SQLite pertenecen al workspace y se pueden crear, editar, probar, conectar, desconectar y eliminar.
2. Una contraseña sólo cruza hacia Main al probar/guardar, se protege mediante `safeStorage`, no vuelve al renderer y no aparece en SQLite en claro, errores o logs.
3. Una ruta SQLite absoluta, traversal o padre canónico fuera de la root autorizada se rechaza antes de abrir o crear el archivo.
4. Los tres adaptadores funcionan contra motores reales y exponen el mismo contrato de catálogo, estructura, consulta y mutación.
5. El navegador agrupa esquemas y muestra tablas/vistas; estructura incluye columnas, tipos, nullability, clave primaria, default y claves foráneas disponibles.
6. El editor SQL usa Monaco, permite una sentencia por ejecución, Ctrl+Enter, resultados tabulares, duración, filas afectadas y errores accionables.
7. SELECT/CTE sólo expone 1000 filas y la navegación de tabla usa páginas acotadas.
8. Insert/update/delete visual usa una grilla inline con controles según el tipo, respeta autoincremento/default/NULL y envía valores parametrizados; update/delete exige clave primaria completa y las vistas permanecen de sólo lectura.
9. SQL destructivo y delete visual exigen confirmación explícita; toda escritura/importación en `PRODUCTION` se bloquea también en Main hasta confirmación reforzada.
10. El historial conserva hasta 1000 sentencias por workspace con estado/duración/conexión y puede reutilizarse o limpiarse con confirmación.
11. CSV y JSON de hasta 5 MiB/10 000 filas se previsualizan; la importación es transaccional y revierte completamente ante error.
12. Los resultados visibles se exportan a CSV/JSON únicamente después de seleccionar destino con el diálogo del sistema.
13. Cerrar workspace o aplicación libera MySQL, PostgreSQL y SQLite sin dejar sesiones huérfanas.
14. El módulo funciona sin IA, sin API remota de Forge y sin exponer sockets/drivers al renderer.
15. Formato, lint, tipos, unitarias/integración, motores reales, auditoría, E2E fuente, build Windows y E2E empaquetado pasan sin defectos bloqueantes.

## 10. Gates de CI previstos

```text
format:check
lint
typecheck
test:unit
test:database-ui
test:integration
test:e2e
build:windows
dependency:audit
```

El audit no debe bloquear por una cifra aislada: cada hallazgo requiere clasificación, mitigación o excepción temporal documentada con vencimiento.

## 11. Evidencia de cierre

El cierre de cada fase debe adjuntar:

- versión/build probado;
- resultados de gates;
- checklist de aceptación;
- defectos conocidos con severidad;
- ADR y migraciones añadidas;
- recorrido manual corto reproducible.

## 12. Recorrido funcional de cierre de Fase 3

El recorrido se ejecuta exclusivamente sobre repositorios temporales:

```text
workspace sin .git
→ init desde UI (main)
→ detectar identidad ausente y configurarla localmente desde la UI
→ add y commit desde la terminal integrada
→ observar historial y working tree actualizados en UI
→ cambiar rama mediante Git externo
→ observar rama actualizada automáticamente en UI
→ configurar origin bare local desde UI
→ primer push y upstream
→ cambio en peer + fetch
→ detectar behind
→ commit local controlado
→ detectar ahead/behind y divergencia
→ bloquear pull/push directo y abrir el asistente
→ comparar commits y archivos exclusivos
→ integrar archivos distintos mediante Merge y terminar en ↑0 ↓0
→ integrar zonas compatibles del mismo archivo mediante Rebase
→ provocar una divergencia con conflicto real
→ verificar tipo y contenido local/remoto
→ aceptar ambos en Monaco
→ marcar explícitamente como resuelto
→ completar la integración y ejecutar push final
```

Los tramos de UI/terminal/resolver son E2E; el peer remoto, fetch, ahead/behind y divergencia se verifican en integración con procesos Git reales. No se usan repositorios personales ni remotos de producción.

## 13. Recorrido funcional de cierre de Fase 4

```text
workspace temporal con app.sqlite
→ abrir Bases de datos
→ crear perfil SQLite relativo al workspace
→ probar y guardar
→ conectar y navegar main/customers
→ inspeccionar columnas y datos
→ insertar y editar mediante valores parametrizados
→ importar CSV después de previsualizar
→ exportar el resultado visible a CSV
→ ejecutar SELECT desde Monaco con Ctrl+Enter
→ reutilizar la consulta desde Historial SQL
→ guardar un perfil remoto con contraseña
→ comprobar que IPC/perfil no devuelven el secreto y SQLite sólo contiene ciphertext
```

En integración adicional se levantan contenedores oficiales temporales MySQL 8.4 y PostgreSQL 17. Cada adaptador prueba conexión, DDL, catálogo, estructura, inserción parametrizada, tabla, SELECT acotado y limpieza. Los contenedores se eliminan al terminar y no usan datos personales.
