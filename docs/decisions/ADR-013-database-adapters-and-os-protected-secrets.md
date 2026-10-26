# ADR-013 — Adaptadores de bases de datos y secretos protegidos por el SO

- Estado: Aceptada
- Fecha: 2026-08-22
- Fase: 4

## Contexto

Forge debe trabajar habitualmente con MySQL, PostgreSQL y SQLite desde un workspace. Esto requiere conexiones privilegiadas, contraseñas propias, SQL libre introducido por el usuario, edición de filas e importación/exportación. El renderer sigue siendo no confiable y SQLite de metadata no puede almacenar contraseñas en claro.

Los tres motores difieren en conexión, catálogo, placeholders, quoting, resultados y transacciones. Exponer drivers o un canal genérico al renderer rompería la arquitectura Main/Preload/Renderer. Añadir un servicio externo de secretos introduciría una dependencia innecesaria para la plataforma inicial Windows.

## Decisión

1. Crear `DatabaseWorkbenchService` en Main y adaptar:
   - MySQL mediante `mysql2/promise`;
   - PostgreSQL mediante `pg` y un `Client` por perfil activo;
   - SQLite mediante `better-sqlite3`, limitado a la root autorizada.
2. Mantener perfiles e historial en la migración SQLite 2, pero consultar catálogo, estructura y filas al motor real. Las sesiones sólo viven en memoria.
3. Implementar `SecretStore` con `safeStorage` asíncrono. En Windows, Electron protege la clave con DPAPI. `database_connections` guarda `secret_ref`; `secret_values` guarda únicamente ciphertext.
4. Permitir que la contraseña introducida por el usuario cruce Renderer → Main sólo en `testConnection` y `saveConnection`. No se retorna, no se registra y la UI sólo recibe `hasPassword`.
5. Exponer comandos IPC nominados y validados. `database.query` acepta una sentencia por invocación; no existe `database.exec` genérico con opciones de driver.
6. Aplicar una política común:
   - límite visible de 1000 filas y páginas de tabla de 200;
   - timeouts remotos;
   - valores parametrizados e identificadores escapados para edición/importación;
   - clave primaria obligatoria para update/delete visual;
   - confirmación de SQL destructivo en cualquier entorno;
   - confirmación de toda escritura/importación en PRODUCCIÓN aplicada en Main;
   - importación CSV/JSON limitada y transaccional.
7. Exportar sólo resultados ya visibles y después de un diálogo nativo. Importar mediante selección nativa, buffer temporal con expiración y previsualización explícita.

## Consecuencias

- Forge incorpora dos dependencias JavaScript sin bindings nativos adicionales: `mysql2` y `pg`.
- Las credenciales cifradas no son portables entre cuentas de Windows; cambiar de usuario requiere ingresarlas nuevamente.
- `preferred` cifra la conexión sin exigir certificado válido; `required` lo valida. La UI debe explicar la diferencia.
- La Fase 4 ejecuta una sentencia por vez. Los scripts multi-sentencia, transacciones manuales persistentes, procedimientos con delimitadores y cancelación avanzada quedan fuera de este alcance.
- SQLite ejecuta su driver síncrono en Main; el límite de resultados y `busy_timeout` reducen riesgo, pero consultas SQLite intensivas en CPU podrían requerir un worker dedicado en una evolución de rendimiento.
- El historial SQL puede contener valores escritos por el usuario; se conserva localmente, acotado a 1000 entradas y nunca se copia al logger.

## Alternativas descartadas

- **Guardar contraseñas en texto plano o configuración `.forge`:** viola el Prompt Maestro y expone secretos al repositorio o perfil de usuario.
- **`keytar`:** añadiría otro módulo nativo y coste de empaquetado cuando Electron ya ofrece protección del SO para Windows.
- **Una única librería ORM:** ocultaría capacidades y metadata propias de cada motor, añadiría abstracciones innecesarias y no mejora un cliente SQL interactivo.
- **Abrir conexiones en Renderer:** rompe sandbox/context isolation y expone sockets, drivers y credenciales a XSS.
- **Permitir múltiples sentencias:** produce comportamiento distinto por driver y dificulta límites, resultados, historial y confirmaciones de riesgo.
- **Persistir catálogos/filas en SQLite:** crea estado obsoleto y una segunda fuente de verdad.

## Validación requerida

- Pruebas reales con SQLite, MySQL 8.4 y PostgreSQL 17.
- E2E Electron y empaquetado para perfiles, cifrado DPAPI, tabla, SQL, historial, importación y exportación.
- Pruebas negativas de traversal, producción, destructividad, sentencia múltiple, límite de filas y rollback de importación.
