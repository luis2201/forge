# Modelo de datos

Las tablas se incorporan sólo al iniciar la fase que las necesita. La migración 1 contiene el núcleo y la migración 2 añade el módulo de bases de datos de Fase 4.

## Tablas

### `schema_migrations`

| Campo        | Tipo    | Regla    |
| ------------ | ------- | -------- |
| `version`    | INTEGER | PK       |
| `name`       | TEXT    | NOT NULL |
| `applied_at` | INTEGER | NOT NULL |
| `checksum`   | TEXT    | NOT NULL |

### `workspaces`

| Campo            | Tipo    | Regla              |
| ---------------- | ------- | ------------------ |
| `id`             | TEXT    | PK, UUID           |
| `name`           | TEXT    | NOT NULL           |
| `created_at`     | INTEGER | NOT NULL           |
| `updated_at`     | INTEGER | NOT NULL           |
| `last_opened_at` | INTEGER | nullable           |
| `is_archived`    | INTEGER | NOT NULL DEFAULT 0 |

### `workspace_roots`

| Campo            | Tipo    | Regla                  |
| ---------------- | ------- | ---------------------- |
| `id`             | TEXT    | PK                     |
| `workspace_id`   | TEXT    | FK workspaces, cascade |
| `canonical_path` | TEXT    | NOT NULL               |
| `display_path`   | TEXT    | NOT NULL               |
| `created_at`     | INTEGER | NOT NULL               |

Índice único inicial por `canonical_path` normalizada según reglas de Windows. Fase 1 impone máximo una root activa por workspace desde el servicio.

### `workspace_settings`

| Campo            | Tipo    | Regla                   |
| ---------------- | ------- | ----------------------- |
| `workspace_id`   | TEXT    | PK/FK                   |
| `schema_version` | INTEGER | NOT NULL                |
| `settings_json`  | TEXT    | JSON validado, NOT NULL |
| `updated_at`     | INTEGER | NOT NULL                |

### `application_settings`

| Campo            | Tipo    | Regla                   |
| ---------------- | ------- | ----------------------- |
| `key`            | TEXT    | PK                      |
| `schema_version` | INTEGER | NOT NULL                |
| `value_json`     | TEXT    | JSON validado, NOT NULL |
| `updated_at`     | INTEGER | NOT NULL                |

La clave `general` de Fase 3 incluye tema, telemetría desactivada, preferencia para mostrar comandos Git y patrones de nombres potencialmente sensibles. Estos datos no son credenciales. El esquema rechaza patrones vacíos y limita cantidad/longitud.

### `workspace_layouts`

| Campo            | Tipo    | Regla                   |
| ---------------- | ------- | ----------------------- |
| `workspace_id`   | TEXT    | PK/FK                   |
| `schema_version` | INTEGER | NOT NULL                |
| `layout_json`    | TEXT    | JSON validado, NOT NULL |
| `updated_at`     | INTEGER | NOT NULL                |

### `database_connections`

| Campo               | Tipo    | Regla                                             |
| ------------------- | ------- | ------------------------------------------------- |
| `id`                | TEXT    | PK, UUID                                          |
| `workspace_id`      | TEXT    | FK workspaces, cascade                            |
| `name`              | TEXT    | NOT NULL, único por workspace sin distinguir case |
| `engine`            | TEXT    | mysql, postgresql o sqlite                        |
| `environment`       | TEXT    | entorno Forge válido                              |
| `host`              | TEXT    | NOT NULL, vacío para SQLite                       |
| `port`              | INTEGER | nullable                                          |
| `database_name`     | TEXT    | NOT NULL, vacío para SQLite                       |
| `username`          | TEXT    | NOT NULL, vacío para SQLite                       |
| `ssl_mode`          | TEXT    | disabled, preferred o required                    |
| `sqlite_path`       | TEXT    | relativa al workspace; vacía para remotos         |
| `secret_ref`        | TEXT    | nullable; nunca contiene el secreto               |
| `created_at`        | INTEGER | NOT NULL                                          |
| `updated_at`        | INTEGER | NOT NULL                                          |
| `last_connected_at` | INTEGER | nullable                                          |

### `secret_values`

| Campo             | Tipo    | Regla                                      |
| ----------------- | ------- | ------------------------------------------ |
| `ref`             | TEXT    | PK; coincide con una referencia de dominio |
| `encrypted_value` | BLOB    | blob cifrado por `safeStorage`/DPAPI       |
| `created_at`      | INTEGER | NOT NULL                                   |
| `updated_at`      | INTEGER | NOT NULL                                   |

El valor en claro no se persiste. El blob no es portable entre usuarios de Windows y sólo se descifra en Electron Main.

### `database_query_history`

| Campo             | Tipo    | Regla                                       |
| ----------------- | ------- | ------------------------------------------- |
| `id`              | TEXT    | PK, UUID                                    |
| `workspace_id`    | TEXT    | FK workspaces, cascade                      |
| `connection_id`   | TEXT    | FK nullable, set null al borrar conexión    |
| `connection_name` | TEXT    | snapshot no sensible                        |
| `statement`       | TEXT    | sentencia solicitada                        |
| `succeeded`       | INTEGER | booleano                                    |
| `duration_ms`     | INTEGER | no negativo                                 |
| `row_count`       | INTEGER | no negativo                                 |
| `error_code`      | TEXT    | nullable; sin mensaje/credencial del driver |
| `executed_at`     | INTEGER | NOT NULL                                    |

Se conservan hasta 1000 entradas por workspace. Las filas/resultados no se persisten.

## Reglas

- Paths no son secretos, pero pueden revelar identidad; los logs deben abreviarlos cuando no sean necesarios.
- JSON se valida al escribir y al leer. Un valor inválido se pone en cuarentena lógica y se reemplaza por defaults con aviso recuperable.
- Borrar un workspace elimina metadata local, no su carpeta ni sus archivos.
- Archivar preserva settings y layout.
- `secret_values` almacena únicamente ciphertext protegido por el sistema operativo; nunca texto plano.
- No se persiste estado Git, recomendaciones derivadas, remotos, HEAD, ramas, commits ni conflictos: se consultan al repositorio real.
- No se persisten tokens, passwords, credenciales GitHub ni resultados de Git Credential Manager.
- No se persisten catálogos, esquemas, tablas, filas ni estado de sesión de motores externos.

## Configuración `.forge`

Opcional y no necesaria en Fase 1. Cuando se introduzca:

```json
{
  "schemaVersion": 1,
  "workspace": { "name": "CloudPOS" }
}
```

Debe existir un esquema cerrado, ignorar o reportar extensiones desconocidas de forma definida y rechazar campos con nombres asociados a secretos (`password`, `token`, `privateKey`, etc.).

## Evolución prevista, no implementada

Las entidades futuras (`api_requests`, `ssh_connections`, `deploy_profiles`, etc.) tendrán migraciones en su propia fase. Esto evita esquemas especulativos y campos que luego condicionen un diseño aún no validado.
