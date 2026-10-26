# Arquitectura y contratos

## 1. Capas de ejecución

```text
React Renderer
    │ window.forge (API mínima)
Preload / contextBridge
    │ IPC invoke + eventos permitidos
Electron Main
    ├── Command Bus
    ├── Servicios de aplicación
    ├── Adaptadores (SQLite, filesystem, secretos)
    └── Sistema operativo
```

El renderer nunca recibe `ipcRenderer`, rutas de módulos internos, handles de proceso ni acceso genérico a comandos.

## 2. Organización modular

Cada módulo contiene, cuando lo necesite:

```text
module/
├── domain/          # reglas y tipos propios
├── application/     # comandos, consultas y casos de uso
├── infrastructure/  # adaptadores privilegiados
└── ui/              # vistas y estado del renderer
```

Las dependencias apuntan hacia dominio/aplicación. La UI no importa infraestructura. La comunicación entre módulos ocurre mediante contratos públicos o eventos.

## 3. Comandos

El registro de comandos mantiene una lista cerrada. Un comando tiene nombre, esquema de entrada, autorización, handler y tipo de salida.

```ts
interface CommandDefinition<I, O> {
  name: string;
  parse(input: unknown): I;
  authorize(context: CommandContext, input: I): Promise<void>;
  execute(context: CommandContext, input: I): Promise<O>;
}
```

El command bus asigna `correlationId`, mide duración, registra resultado seguro y normaliza errores. No se añadirá un comando genérico `shell.execute` o `filesystem.call`.

## 4. Eventos

El bus inicial es interno al proceso main y en memoria. Los eventos son hechos inmutables y tipados. La persistencia solo se añade cuando exista un requisito de auditoría o recuperación.

```ts
interface DomainEvent<T> {
  id: string;
  name: string;
  occurredAt: string;
  correlationId: string;
  payload: T;
}
```

Los errores de un suscriptor se registran y se aplicará una política explícita por evento; no deben revertir silenciosamente al publicador.

## 5. IPC hasta Fase 4

Canal único de invocación recomendado: `forge:command`, cuyo payload solo acepta nombres registrados. Esto reduce superficie sin convertirlo en ejecución arbitraria.

Contratos disponibles:

| Grupo           | Comandos explícitos                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace       | `chooseAndOpen`, `openRecent`, `close`, `listRecent`, `updateSettings`                                                                                                                                                                                                                                                                                                               |
| Aplicación      | `getSettings`, `updateSettings`, `setDirtyState`                                                                                                                                                                                                                                                                                                                                     |
| Layout          | `get`, `save`                                                                                                                                                                                                                                                                                                                                                                        |
| Archivos        | `list`, `read`, `write`, `createFile`, `createDirectory`, `rename`, `delete`                                                                                                                                                                                                                                                                                                         |
| Búsqueda        | `text`                                                                                                                                                                                                                                                                                                                                                                               |
| Git             | `repositories`, `init`, `status`, `overview`, `identity`, `configureIdentity`, `diff`, `stage`, `unstage`, `discard`, `commit`, `branches`, `remotes`, `setRemote`, `createBranch`, `checkout`, `merge`, `abortMerge`, `analyzeSync`, `integrateSync`, `continueIntegration`, `abortIntegration`, `stash`, `fetch`, `pull`, `push`, `history`, `show`, `conflict`, `resolveConflict` |
| GitHub          | `info`, `openRepository`                                                                                                                                                                                                                                                                                                                                                             |
| Base de datos   | `listConnections`, `saveConnection`, `deleteConnection`, `testConnection`, `connect`, `disconnect`, `catalog`, `structure`, `query`, `tableData`, `mutateRow`, `history`, `clearHistory`, `exportResult`, `previewImport`, `applyImport`                                                                                                                                             |
| Recomendaciones | `list`                                                                                                                                                                                                                                                                                                                                                                               |
| Terminal        | `create`, `write`, `resize`, `close`                                                                                                                                                                                                                                                                                                                                                 |

Cada método del preload construye internamente un comando con esquema Zod discriminado. Las rutas se expresan como rutas relativas al workspace, el contenido editable está limitado a 5 MiB y las dimensiones/datos del terminal tienen límites de contrato.

Eventos renderer permitidos:

- `workspace.opened`
- `workspace.closed`
- `workspace.settingsChanged`
- `application.settingsChanged`
- `file.changed`
- `git.changed`
- `database.changed`
- `recommendations.changed`
- `terminal.data`
- `terminal.exited`

Preload expondrá métodos con nombre, no `invoke(channel, payload)` genérico.

## 6. Workspace y autorización

Un workspace posee un ID estable y una o más roots; Fase 1 admite exactamente una root. Abrir carpeta desde el diálogo nativo crea una concesión para esa ruta. Toda operación posterior:

1. carga la root desde storage usando el workspace ID;
2. convierte root y destino a rutas absolutas canónicas;
3. resuelve traversal y enlaces simbólicos cuando aplique;
4. verifica que el destino sea la root o descendiente real;
5. aplica límites de tamaño/tipo de operación;
6. registra resultado con rutas sanitizadas cuando sea necesario.

No se aceptan roots proporcionadas libremente por una vista web sin el flujo de selección/autorización. En Fase 2, la lectura y escritura rechazan escapes por traversal o symlink; renombrar o enviar a papelera un symlink actúa sobre el enlace y nunca sobre su destino. El guardado usa archivo temporal, reemplazo atómico y una versión SHA-256 para detectar escrituras concurrentes incluso si tamaño y timestamp coinciden.

## 7. Editor, búsqueda y terminal

- Monaco se carga de forma diferida y crea modelos identificados por `workspaceId` y ruta; los modelos cerrados se liberan.
- El watcher nativo observa la root autorizada. Un archivo limpio se recarga; un archivo con cambios locales presenta conflicto y exige una decisión explícita.
- La búsqueda recorre texto dentro del workspace con límites de archivos/resultados e ignora carpetas generadas y enlaces simbólicos.
- xterm.js solo renderiza el terminal. El proceso privilegiado crea un PTY PowerShell fijo con `cwd` en la root; el renderer no elige ejecutable ni recibe handles de proceso.
- La tipografía de la interfaz usa tokens CSS `font-ui-xs/sm/base/md/lg`; el texto normal parte de 11 px. Monaco y xterm mantienen configuraciones independientes para que una futura preferencia de apariencia no mezcle UI, editor y terminal.

## 8. Git y GitHub

- **Git Engine:** Electron Main resuelve una instalación absoluta y confiable de Git; cada caso de uso ejecuta un subcomando fijo con argumentos separados y `shell: false`. Git es la única fuente de verdad: Forge no persiste ramas, HEAD, archivos, commits, conflictos ni sincronización en SQLite.
- Un repositorio sólo se autoriza si su top-level y su directorio `.git` canónicos están dentro de la root del workspace. La detección admite la root y repositorios anidados, con profundidad y cardinalidad acotadas.
- `GitStatus` representa HEAD local/remoto, rama, upstream, remotos, ahead/behind/divergencia, cambios, conflictos tipados, operación activa, número de stash y últimos commits. `GitOverview` agrega la identidad efectiva de autor, recomendaciones y coincidencias de nombres sensibles sin duplicar el estado Git.
- Antes de un commit, Main comprueba `user.name` y `user.email`. Si faltan, la UI lo advierte y permite guardarlos con `git config --local`, únicamente en el repositorio actual. El push se rechaza de forma preventiva si la rama aún no tiene commit inicial.
- El watcher de workspace observa archivos y metadata `.git`. Los cambios de UI publican `git.changed`; las operaciones de la terminal integrada o herramientas externas disparan `file.changed`. La UI agrupa eventos durante 220 ms y vuelve a consultar Git, sin polling agresivo.
- La terminal integrada comparte exactamente la root y el repositorio real con la UI. No existe estado Git paralelo, caché persistente ni simulación.
- `fetch` actualiza las referencias remotas sin integrar. Si `ahead > 0 && behind > 0`, `pull --ff-only` y `push` se bloquean preventivamente y el usuario entra al asistente de sincronización.
- `GitSyncAnalysis` conserva rama local/remota, conteos, commits exclusivos, archivos por lado, solapamientos, conflictos y operación activa. El asistente permite comparar diffs y exige elegir Merge o Rebase; Merge es sólo la recomendación inicial, nunca una decisión silenciosa.
- Un working tree sucio exige revisar, crear commit, autorizar stash o cancelar. Merge/Rebase, continuación y aborto son comandos nominados y confirmados; no existe stash automático ni force push.
- Los protocolos de transporte desconocidos y `remote-helper` externos quedan bloqueados. `fetch`, `pull` y `push` tienen timeout y salida acotada.
- Los resultados mutables incluyen un comando equivalente sanitizado cuando la preferencia de transparencia está activa.
- El resolver Monaco compara stage 2 (local) y stage 3 (remoto), mantiene un resultado editable y sólo ejecuta `git add`/`git rm` tras una confirmación explícita sin marcadores pendientes y con control de versión SHA-256.
- Git y GitHub permanecen separados. GitHub interpreta remotos `github.com` y abre la página validada; no interviene en el estado local. La autenticación HTTPS/SSH permanece en Git Credential Manager, Git/SSH o el almacén del sistema. Forge nunca solicita, recibe ni persiste tokens.

## 9. Bases de datos

- `DatabaseWorkbenchService` mantiene las sesiones exclusivamente en Electron Main. El renderer sólo recibe perfiles sin contraseña, catálogos, estructuras y resultados serializables.
- Los perfiles pertenecen a un workspace y declaran motor, entorno, endpoint o ruta SQLite, base, usuario y TLS. MySQL usa `mysql2`, PostgreSQL usa `pg` y SQLite reutiliza `better-sqlite3` detrás de un contrato común; los detalles propios de cada driver no atraviesan IPC.
- SQLite se restringe a una ruta relativa cuya ubicación canónica permanece dentro de la root autorizada. MySQL y PostgreSQL usan timeouts de conexión/consulta y TLS configurable; `required` valida el certificado y `preferred` cifra sin validarlo.
- Las contraseñas se reciben únicamente al probar o guardar un perfil, pasan una vez de Renderer a Main y nunca vuelven. `EncryptedSecretStore` usa la API asíncrona `safeStorage`; en Windows la clave queda protegida por DPAPI. `database_connections` sólo conserva `secret_ref` y `secret_values` guarda el blob cifrado.
- Cada ejecución acepta exactamente una sentencia. SELECT/CTE se envuelven con un límite interno de 1001 filas y sólo se exponen 1000; tabla/datos usa páginas de 200. El historial persiste el SQL solicitado, resultado seguro, duración y estado, pero el logger no registra sentencias ni filas.
- SQL destructivo y borrado visual requieren confirmación explícita. Toda escritura en un perfil `PRODUCTION` exige una confirmación adicional aplicada en Main. La grilla deriva controles de `dataType`, nullability, default, generación y autoincremento; insert/update/delete construye identificadores validados y valores parametrizados, y una clave primaria completa es obligatoria para update/delete.
- La importación básica acepta CSV o un arreglo JSON, máximo 5 MiB/10 000 filas, previsualiza hasta 50 y aplica todo en una transacción. La exportación sólo escribe CSV/JSON después de un diálogo nativo de destino.
- Cerrar un workspace o Forge cierra sus conexiones. `database.changed` invalida el estado visual sin crear una fuente de verdad paralela.

## 10. Recomendaciones, reglas y notificación

`RecommendationEngine` es una capacidad general del core. Recibe reglas tipadas y produce el modelo estructurado `id`, `source`, `severity`, `title`, `message`, `details`, `actions`, `timestamp` y `context`. `NotificationCenter` agrega resultados por workspace y fuente; no conoce Git.

`GitAdvisor` es un consumidor del motor general. Sus reglas determinísticas explican conflictos, identidad de autor o commit inicial ausentes, divergencia, working tree sucio antes de sincronizar, upstream/remoto ausente, ahead/behind, stash y nombres sensibles. `GitRiskPolicy` clasifica operaciones como `SAFE`, `WARNING` o `DANGER` y define si requieren confirmación y qué consecuencias deben mostrarse.

Forge es completamente funcional sin inteligencia artificial. Una capa futura de IA sólo podrá consumir los mismos contextos estructurados y proponer recomendaciones opcionales; ningún módulo funcional importa o depende de un proveedor/modelo de IA.

```text
Seguridad
  > reglas determinísticas de Forge
  > autorización explícita del usuario
  > recomendación de IA futura
```

Una recomendación futura nunca podrá desactivar validación, confinamiento, políticas de riesgo ni confirmaciones.

## 11. Persistencia

- Repositorios ocultan SQLite a los casos de uso.
- Migraciones numeradas, inmutables y transaccionales.
- `PRAGMA foreign_keys = ON`, `journal_mode = WAL` y `busy_timeout` definido.
- Backup previo para migraciones futuras de riesgo alto.
- La apertura falla de forma segura si la base tiene una versión más nueva que la aplicación.
- La migración 2 añade perfiles de base de datos, historial SQL y blobs cifrados. Catálogos, tablas, filas y sesiones se consultan al motor real y no se duplican en SQLite.

## 12. Logging

Registro estructurado con: timestamp, level, category, event, correlationId y metadata permitida. Destinos iniciales: archivo rotado y consola solo en desarrollo.

Nunca registrar tokens, passwords, claves, headers de autorización, contenido de Credential Manager, variables completas de entorno ni cuerpos de petición sin política específica.

## 13. Configuración

Precedencia futura, de menor a mayor: defaults → aplicación → workspace → sesión. La configuración sensible queda fuera de esta cadena y se resuelve por `secretRef` mediante el servicio de secretos.

## 14. Versionado

- Esquema SQLite: entero incremental.
- Configuración `.forge`: campo `schemaVersion`.
- Contratos IPC: evolucionan de forma compatible durante una versión; un cambio incompatible exige versión de contrato.
