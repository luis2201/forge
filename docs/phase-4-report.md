# Informe de cierre — Fase 4

- Versión: 0.4.0
- Plataforma validada: Windows, Electron 43, Node 22+
- Fecha: 2026-08-22
- Alcance rector: Prompt General Maestro — MySQL, PostgreSQL, SQLite, conexiones, navegador, tablas/vistas, consultas, edición, historial, estructura e importación/exportación básica

## Resultado

Forge 0.4.0 puede utilizarse como herramienta habitual de bases de datos dentro de un workspace:

- perfiles MySQL, PostgreSQL y SQLite asociados a workspace y entorno;
- prueba, guardado, conexión, desconexión, edición y eliminación de perfiles;
- contraseña protegida mediante `safeStorage` asíncrono/DPAPI, nunca retornada por IPC ni almacenada en claro;
- navegador de esquemas con tablas y vistas;
- estructura de columnas, tipo, nullability, clave primaria, default, generación y claves foráneas disponibles;
- Monaco SQL con Ctrl+Enter, una sentencia por ejecución, resultados tabulares, duración, filas afectadas y límite visible de 1000;
- navegador paginado con fila nueva y edición inline, controles derivados del tipo/default/NULL y delete por fila; todo parametrizado y con clave primaria obligatoria;
- historial SQL local por workspace, reutilizable y acotado a 1000 entradas;
- importación CSV/JSON con previsualización, límites y transacción completa;
- exportación CSV/JSON mediante diálogo nativo;
- confirmaciones en Main para SQL destructivo y toda escritura/importación en `PRODUCTION`;
- cierre de sesiones al cerrar workspace o Forge.

No se incorporaron funciones de Fase 5 ni controles ficticios de API.

## Arquitectura y persistencia

- Migración 2: `database_connections`, `database_query_history` y `secret_values`.
- `database_connections` contiene sólo metadata y `secret_ref`; `secret_values` contiene ciphertext protegido por el sistema operativo.
- `DatabaseWorkbenchService` y los tres adaptadores viven en Electron Main. El renderer no recibe drivers, sockets, rutas absolutas ni secretos.
- Dependencias incorporadas: `mysql2` 3.23.4 y `pg` 8.23.0. SQLite reutiliza `better-sqlite3`.
- `database.changed` extiende el Event Bus existente; no existe un estado persistido paralelo del motor.
- ADR-013 documenta adaptadores, DPAPI, contrato de una sentencia, límites y política de riesgo.

## Pruebas ejecutadas

- `format:check`: aprobado.
- ESLint con cero warnings: aprobado.
- TypeScript renderer + main/preload: aprobado.
- Unitarias e integración normal: 46/46 aprobadas en 12 archivos; 2 pruebas remotas se omiten cuando el gate no habilita contenedores.
- Integración remota explícita: 2/2 aprobadas contra contenedores oficiales temporales MySQL 8.4 y PostgreSQL 17.
- SQLite real: perfil, archivo confinado, DDL, catálogo, estructura, query, edición, historial, exportación e importación.
- Seguridad/robustez: ciphertext, secreto ausente del perfil, traversal, producción, SQL destructivo, sentencia múltiple, punto y coma en string, límite 1000 y rollback total de importación.
- E2E Electron desde fuentes: 9/9.
- E2E sobre `release/win-unpacked/Forge.exe`: 9/9.
- `npm audit --audit-level=moderate`: 0 vulnerabilidades.

El E2E de Fase 4 crea una base SQLite real, prueba/guarda/conecta el perfil, navega `main.customers`, añade, modifica y elimina filas desde la grilla, importa CSV, exporta CSV, ejecuta SQL en Monaco, abre el historial y verifica mediante la base interna que un perfil remoto contiene ciphertext y no el secreto. El smoke de renderer adicional valida controles `VARCHAR`, booleano, decimal y fecha, y adjunta capturas antes y después del CRUD.

Los E2E de Fases 1–3 permanecen en el mismo gate: aislamiento del renderer, editor/terminal, cierre sucio, Git local, init/identidad/primer push, divergencia, conflicto visual y nombre sensible.

## Build

- `npm.cmd run build`: aprobado.
- `npm.cmd run package:win`: aprobado.
- Artefacto: `C:\Users\Luis\Desktop\forge\release\win-unpacked\Forge.exe`.
- FileVersion: 0.4.0.
- ProductVersion: 0.4.0.0.
- Tamaño: 225 441 792 bytes.
- SHA-256: `CB7F09A90218AF43CCEC555A1D084D2F29777009834568898C9EF1E8A2720E5F`.
- Inicio, SQLite, DPAPI, MySQL/PostgreSQL empacados, Monaco, node-pty, Git y preload: validados por build/E2E y pruebas reales de adaptadores.

## Problemas encontrados y corregidos

1. `better-sqlite3` alterna ABI entre Node/Vitest y Electron; los gates reconstruyen explícitamente para el runtime correspondiente.
2. PostgreSQL ejecutaba tres lecturas de estructura concurrentes sobre un único `Client`, comportamiento deprecado antes de pg 9; se hicieron secuenciales.
3. La paginación solicitaba una fila de sondeo pero podía mostrarla y duplicarla en la página siguiente; ahora la fila adicional sólo determina `hasMore`.
4. Update/delete con una clave nula podía desalinear placeholders y parámetros; el generador de WHERE incrementa índices sólo para valores enlazados.
5. Cambiar un perfil remoto a SQLite podía conservar una credencial sin uso; ahora elimina la referencia y ciphertext.
6. Un fallo de unicidad al crear perfil podía dejar ciphertext huérfano; la creación revierte el secreto nuevo.
7. PostgreSQL aceptaba múltiples sentencias aunque MySQL/SQLite no; el contrato común valida una sentencia y respeta delimitadores, comentarios y strings.
8. Un SELECT libre podía devolver un conjunto enorme antes del límite visual; SELECT/CTE se envuelve con un límite interno de 1001 y sólo expone 1000.
9. Una primera ejecución de E2E empaquetado reveló una carrera al cancelar `app.quit()` con archivos sucios. `before-quit` cancela ahora sincrónicamente y sólo reanuda después de confirmación; pasó 3/3 aislado y 9/9 en el paquete completo.
10. La UI de base de datos se revisó visualmente y se ajustó al layout/tipografía existente sin colapsar tabla, catálogo ni terminal.

## Problemas conocidos no críticos

- SQLite usa `better-sqlite3` síncrono en Main. Resultados y waits están acotados, pero una consulta SQLite intensiva en CPU podría requerir un worker dedicado en una fase de rendimiento.
- La Fase 4 ejecuta una sentencia por vez. Scripts multi-sentencia, transacciones manuales persistentes y edición de procedimientos quedan fuera del alcance actual.
- TLS admite desactivado, cifrado sin validación (`preferred`) y certificado válido (`required`); certificados CA/cliente personalizados no se configuran todavía.
- Importación básica usa CSV separado por coma o JSON como arreglo de objetos, máximo 5 MiB/10 000 filas. No incluye mapeo interactivo de columnas ni formatos binarios.
- La grilla tiene controles para texto, enum, booleano, entero, decimal, fecha/hora y JSON, además de `DEFAULT`, `NULL` y autoincremento. Los tipos binarios todavía no tienen editor hexadecimal.
- Los tipos complejos/binarios de resultados se normalizan para IPC; no existe visor hexadecimal ni editor binario.
- La política Application Control activa en la máquina de desarrollo bloquea ejecutables y módulos nativos recién compilados sin firma Authenticode. El paquete se genera correctamente, pero para repetir E2E sobre ese artefacto bajo esta política se necesita un certificado de firma confiable; backend real y renderer se validan por separado mientras tanto.
- Persisten las advertencias de build ya conocidas: chunks grandes de Monaco, metadato author/icono predeterminados y referencias transitorias duplicadas. El audit es cero y el empaquetado completa correctamente.

No existen defectos críticos conocidos en el alcance de Fases 0–4.

## Criterios de aceptación

Los quince criterios de Fase 4 definidos en `testing-and-acceptance.md` están cubiertos por integración, motores reales, E2E, inspección visual, auditoría o paquete Windows.

```text
Conexiones MySQL/PostgreSQL/SQLite:
APROBADAS

Secretos safeStorage/DPAPI:
APROBADOS

Navegador y estructura:
APROBADOS

SQL, resultados e historial:
APROBADOS

Edición de datos:
APROBADA

Importación/exportación básica:
APROBADA

Protecciones de producción:
APROBADAS

Regresión Fases 0–3:
APROBADA

Build y paquete Windows:
APROBADOS

FASE 4:
APTA PARA CIERRE
```

## Recorrido reproducible

1. Abrir `release/win-unpacked/Forge.exe` y un workspace.
2. Abrir Bases de datos, crear un perfil SQLite relativo —por ejemplo `data/app.sqlite`— y usar Probar/Guardar.
3. Elegir una tabla para revisar Datos/Estructura, usar Añadir fila, editar o eliminar directamente desde las acciones de cada fila.
4. Ejecutar una consulta desde Consulta SQL con Ctrl+Enter y recuperarla desde Historial SQL.
5. Importar CSV/JSON después de revisar la previsualización y exportar el resultado visible a CSV/JSON.
6. Para MySQL/PostgreSQL, configurar host/puerto/base/usuario/TLS; la contraseña guardada no vuelve a mostrarse.
