# Modelo de seguridad

## 1. Activos

- código y archivos locales;
- credenciales y claves;
- metadata de proyectos;
- capacidad de ejecutar procesos;
- conexiones a servicios y servidores;
- historial, logs y contenido contextual para IA.

## 2. Fronteras y amenazas

El renderer se considera no confiable. Se contemplan XSS, payloads IPC manipulados, path traversal, symlink escape, ejecución de comandos, URLs maliciosas, filtración de secretos, dependencias comprometidas y operaciones destructivas accidentales.

## 3. Configuración obligatoria de BrowserWindow

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  preload: trustedPreloadPath,
}
```

Si una capacidad futura fuera incompatible con sandbox, deberá aislarse y justificarse mediante ADR; no se desactivará globalmente por conveniencia.

## 4. Contenido y navegación

- CSP restrictiva; en producción sin `unsafe-eval`.
- No cargar contenido remoto dentro de la ventana privilegiada.
- Bloquear navegación no esperada y creación libre de ventanas.
- URLs externas: parsear, permitir solo `https:` (salvo excepción documentada), mostrar/validar host y abrir mediante API controlada.
- DevTools deshabilitadas en builds de producción salvo modo diagnóstico explícito.
- Permisos de sesión denegados por defecto.

## 5. IPC

- Canales registrados; sender y ventana validados.
- Entrada `unknown` validada en runtime, con límites de longitud y cardinalidad.
- Salida serializable y mínima.
- Rate limiting para operaciones costosas cuando aparezcan.
- Errores normalizados sin stack ni datos sensibles.
- Ninguna API genérica para filesystem, procesos, shell o red.

## 6. Secretos

`SecretStore` define `set`, `get`, `delete` y `has`. En Fase 4, `EncryptedSecretStore` protege contraseñas de bases de datos mediante la API asíncrona `safeStorage` de Electron. En Windows, el cifrado usa DPAPI y queda asociado a la sesión del usuario. Si el cifrado del sistema no está disponible, Forge rechaza guardar el secreto; no existe fallback en texto plano.

`database_connections` guarda sólo:

```text
secret_ref: forge:<scope>:<resource-id>:<purpose>
```

El blob cifrado se persiste separado en `secret_values`; la contraseña en claro vive sólo durante test/guardado/conexión y no se registra. Fase 4 incorpora la excepción controlada documentada por ADR-013: la contraseña introducida por el usuario cruza Renderer → Main una vez al probar o guardar, pero nunca vuelve al renderer. Listados y errores sólo representan `hasPassword`.

La autenticación Git continúa delegada directamente a Git Credential Manager; no se mezcla con el almacén propio de Forge.

Para remotos GitHub, Forge sólo devuelve `owner`, repositorio, nombre del remoto, URL web reconstruida sin credenciales y disponibilidad de GCM. Una URL remota que contenga userinfo o token se redacta antes de formar errores o resultados.

Antes de cada commit, Forge compara los nombres staged con patrones configurables (`.env`, `*.pem`, `*.key`, `id_rsa`, `credentials.json` por defecto) y consulta `git check-ignore`. Una coincidencia exige confirmación reforzada, pero no inspecciona ni transmite el contenido y no pretende sustituir un escáner de secretos.

## 7. Terminal local y procesos futuros

La terminal interactiva de Fase 2 es una capacidad explícita solicitada por el usuario y, por definición, permite introducir comandos. Se aísla del resto de Forge con estas reglas:

- el renderer solo solicita crear una sesión asociada a un `workspaceId` válido;
- Electron Main fija `powershell.exe` y el directorio de trabajo en la root autorizada;
- no existe una API oculta o genérica `shell.execute` para otros componentes;
- las sesiones se cierran al cerrar el workspace, la ventana o la aplicación;
- escritura y resize se validan y acotan antes de llegar al PTY;
- salida y códigos de cierre vuelven por eventos permitidos y tipados.

La terminal representa una acción directa del usuario, no una autorización para que automatizaciones o IA ejecuten comandos. Esas capacidades futuras deberán pasar por perfiles, confirmaciones y políticas propias.

Para otros procesos:

- Usar ejecutable + array de argumentos; evitar shell por defecto.
- Lista permitida o perfil configurado por funcionalidad.
- Directorio de trabajo resuelto dentro del workspace cuando corresponda.
- Timeout, cancelación, límites de salida y códigos de resultado.
- Confirmación reforzada para producción y acciones destructivas.
- IA y automatizaciones deben pasar por el mismo command bus y autorización que la UI.

## 8. Filesystem de Fase 2

- Toda ruta parte de un `workspaceId` persistido y se normaliza como relativa.
- Se rechazan rutas absolutas, traversal, nombres reservados de Windows y escapes mediante symlink.
- La root no puede renombrarse ni eliminarse.
- La eliminación usa la papelera del sistema, no borrado recursivo irreversible.
- Los archivos binarios o mayores de 5 MiB no se abren en el editor.
- El guardado es atómico y compara una versión SHA-256 para impedir sobrescrituras silenciosas.
- Los cambios externos sobre un documento sucio requieren confirmación para recargar o una acción explícita para sobrescribir.

## 9. Git y GitHub de Fase 3

- Git se resuelve a una ruta absoluta instalada; nunca se busca un `git.exe` dentro del workspace.
- Los comandos usan `execFile`, array de argumentos, `shell: false`, timeout y límite de salida. No existe un comando Git genérico en IPC.
- Se eliminan del entorno las variables `GIT_*` capaces de redirigir repositorio, índice, objetos, configuración inyectada o ejecutables internos.
- `core.fsmonitor` externo queda desactivado y la lista de protocolos permite sólo `file`, `http`, `https`, `ssh` y `git`; `ext::` y helpers desconocidos se bloquean.
- La ruta top-level y el git-dir reales deben permanecer dentro de la root autorizada. Por esta razón, un linked worktree cuyo git-dir esté fuera del workspace se rechaza en esta fase.
- `pull` es `--ff-only`; no inicia merges implícitos y se bloquea con un working tree sucio o una historia divergente. `push` se bloquea mientras existan commits remotos no integrados.
- Merge y Rebase de sincronización se exponen como operaciones nominadas, requieren decisión/confirmación explícita y se pueden continuar o abortar. El stash incluye archivos nuevos sólo tras autorización; Forge nunca lo ejecuta automáticamente.
- Abrir GitHub sólo acepta una URL reconstruida `https://github.com/<owner>/<repo>` y vuelve a validar protocolo y host en Main.
- Las URLs de remoto con credenciales o protocolos `remote-helper` se rechazan. Los comandos equivalentes y salidas pasan por redacción antes de llegar al renderer.
- `user.name` y `user.email` se validan en el contrato y nuevamente en Main. Forge los escribe con argumentos separados y alcance `--local`; no modifica silenciosamente la identidad global ni confunde estos datos con credenciales o tokens de GitHub.
- El resolver de conflictos rechaza binarios, texto no UTF-8, resultados mayores de 5 MiB y marcadores pendientes. Verifica la versión del archivo antes de escribir atómicamente y preparar o eliminar el resultado.

Los hooks, filtros y configuración propia de Git pueden ejecutar código cuando el usuario solicita explícitamente commit, checkout, merge o sincronización. Forge no convierte esas acciones en automáticas: se debe tratar un repositorio desconocido como código no confiable. Un modelo general de Workspace Trust queda pendiente antes de automatizar operaciones Git o ejecutarlas por IA.

## 10. Bases de datos de Fase 4

- El renderer no abre sockets, archivos SQLite ni importa drivers; todos los accesos ocurren en Main mediante comandos nominados y esquemas Zod.
- Una base SQLite sólo se abre dentro de la root canónica del workspace. Traversal, ruta absoluta y padre resuelto fuera de la root se rechazan antes de crear el archivo.
- Los perfiles nunca contienen URL con contraseña. Host, puerto, base, usuario, TLS y `hasPassword` son metadata; el secreto se resuelve por referencia sólo al conectar.
- MySQL deshabilita `multipleStatements`; Forge aplica además una sentencia por operación a los tres motores. Los valores de edición/importación se parametrizan y los identificadores se validan y escapan por dialecto.
- Las consultas de lectura visibles se limitan a 1000 filas. Conexión y consulta remota tienen timeout; SQLite usa `busy_timeout` y una sesión por perfil.
- DROP, TRUNCATE, DELETE, ALTER y REVOKE requieren confirmación en cualquier entorno. En `PRODUCTION`, toda escritura, edición visual o importación exige confirmación reforzada en Main.
- Update/delete visual exige clave primaria completa. Las vistas son de sólo lectura en el editor visual.
- CSV/JSON se limita por tamaño y filas; la importación es transaccional y un fallo revierte todo. Exportar exige selección de destino por diálogo nativo.
- El historial SQL es metadata funcional solicitada; no se envía a logs. Los errores de driver se acotan y redactan antes de cruzar IPC.

## 11. Jerarquía de decisiones y futura IA

La prioridad es invariable:

```text
Seguridad
  > reglas determinísticas de Forge
  > autorización explícita del usuario
  > recomendación de IA futura
```

`GitRiskPolicy` clasifica operaciones peligrosas y los handlers de Main aplican las confirmaciones, no sólo la UI. Las operaciones no expuestas (force push, hard reset, clean o borrado de ramas) no pueden invocarse mediante IPC. Una futura IA no recibirá capacidad para omitir esquemas, autorización, validación de rutas, reglas de riesgo ni confirmaciones.

Forge no contiene SDK, proveedor, modelo, clave ni llamada de IA en Fase 3. Todos los flujos funcionales y recomendaciones determinísticas operan sin red y sin IA.

## 12. Dependencias y distribución

- Lockfile obligatorio y actualización deliberada.
- Auditoría de dependencias en CI, evaluando explotabilidad y no solo conteo.
- Empaquetado reproducible en lo razonable.
- Firma de código y actualización segura se consideran requisitos antes de distribuir fuera del uso personal.
- No incluir sourcemaps públicos con rutas o fuentes sensibles.

## 13. Checklist de revisión

- ¿La operación necesita privilegios?
- ¿La entrada se valida en runtime?
- ¿El recurso pertenece al workspace autorizado?
- ¿Puede destruir o exfiltrar datos?
- ¿Requiere confirmación o distintivo de entorno?
- ¿Los logs y errores redactan secretos?
- ¿Existe una prueba negativa del límite de seguridad?
