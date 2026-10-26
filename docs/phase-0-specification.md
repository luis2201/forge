# Fase 0 — Especificación y arquitectura

## 1. Propósito

Esta fase convierte la visión de Forge en límites y contratos verificables. No incluye código funcional ni anticipa módulos posteriores.

## 2. Alcance del producto

Forge es una aplicación personal de escritorio para Windows. Su unidad de trabajo es el workspace. Cada herramienta deberá consumir el contexto del workspace activo y no mantener una jerarquía paralela de proyectos.

### Alcance de la Fase 1

- Shell de escritorio Electron con React y TypeScript.
- Creación, apertura, cierre y listado de workspaces recientes.
- Una carpeta raíz local autorizada por workspace.
- Navegación base y layout persistente sencillo.
- Preferencias de aplicación y de workspace.
- SQLite con migraciones.
- Logging estructurado con redacción de secretos.
- Bus de eventos y registro de comandos internos.
- IPC explícito, validado y tipado.
- Manejo uniforme de errores.

### No incluido en la Fase 1

Editor Monaco, terminal, Git/GitHub, bases de datos externas, cliente API, SSH/SFTP, Docker, despliegues, IA, docking complejo, plugins y colaboración.

## 3. Principios vinculantes

1. El renderer es no privilegiado.
2. Todo acceso al sistema pasa por una capacidad explícita del proceso main.
3. La posesión de una ruta no implica autorización sobre rutas vecinas.
4. Los secretos nunca se guardan en SQLite, logs ni archivos `.forge`.
5. Los comandos describen intención; los servicios realizan efectos.
6. Los módulos publican eventos y evitan dependencias circulares.
7. Las operaciones destructivas son explícitas, auditables y proporcionales al entorno.
8. Cada fase termina operativa y probada antes de abrir la siguiente.

## 4. Experiencia conceptual

Al iniciar, Forge muestra workspaces recientes y la acción **Abrir carpeta**. Al seleccionar una carpeta, el proceso main valida la ruta, registra la autorización y crea o recupera el workspace. La ventana muestra:

- barra superior con workspace activo;
- navegación vertical de módulos disponibles;
- panel lateral contextual;
- área principal con pestañas;
- panel inferior plegable;
- barra de estado.

En Fase 1, las áreas aún no implementadas deberán aparecer deshabilitadas o no aparecer. No se usarán pantallas ficticias que parezcan funcionales.

## 5. Entornos

Tipo cerrado inicial: `LOCAL | DEVELOPMENT | TEST | STAGING | PRODUCTION`.

- `LOCAL`: sin advertencia adicional salvo acción destructiva.
- `DEVELOPMENT`, `TEST`: identificación visible.
- `STAGING`: identificación visible y confirmación en operaciones de impacto alto.
- `PRODUCTION`: distintivo persistente y confirmación reforzada; el nombre del recurso debe formar parte de la confirmación destructiva.

La clasificación no sustituye controles técnicos de autorización.

## 6. Errores

Todo error que cruce IPC tendrá esta forma lógica:

```ts
type ForgeError = {
  code: string;
  message: string;
  details?: Record<string, string | number | boolean>;
  remediation?: string[];
  correlationId: string;
};
```

No se transportarán stacks al renderer en producción. `details` debe usar una lista permitida por caso y nunca incluir credenciales, contenido completo de archivos ni variables de entorno.

## 7. Estructura prevista

```text
src/
├── main/
│   ├── core/{commands,events,logging,settings,storage,workspaces}
│   ├── modules/
│   ├── ipc/
│   └── bootstrap/
├── preload/
├── renderer/
│   ├── app/
│   ├── core/
│   └── modules/
└── shared/
    ├── contracts/
    ├── schemas/
    └── types/
tests/{unit,integration,e2e}/
docs/decisions/
```

`shared` solo puede contener código seguro para ambos contextos: tipos, esquemas y constantes; no importa Node ni Electron.

## 8. Convenciones

- TypeScript `strict`, sin `any` no justificado.
- Esquemas runtime para toda entrada externa e IPC.
- Nombres de comando `dominio.acción` y eventos en pasado `dominio.hecho`.
- IDs UUID; fechas UTC ISO 8601 en contratos y enteros epoch en SQLite.
- Imports unidireccionales: renderer → shared; preload → shared; main → shared.
- Commits pequeños y orientados a una decisión o comportamiento.
- ADR para decisiones difíciles de revertir.

## 9. Definition of Done por funcionalidad

- comportamiento integrado y accesible desde la UI cuando corresponda;
- validación de entradas y autorización;
- estados de carga, vacío y error;
- logs útiles sin información sensible;
- pruebas proporcionales al riesgo;
- documentación de decisiones relevantes;
- sin fallos críticos conocidos ni funcionalidad simulada.

## 10. Riesgos iniciales

| Riesgo                                     | Mitigación                                                   |
| ------------------------------------------ | ------------------------------------------------------------ |
| IPC crece sin control                      | Registro central, contratos versionados y validación runtime |
| Escape de la raíz autorizada               | Rutas canónicas y verificación tras resolver enlaces         |
| Dependencias nativas complican empaquetado | Aislar adaptadores y probar build Windows desde Fase 1       |
| SQLite bloqueado o incompatible            | Una conexión coordinada, WAL, migraciones transaccionales    |
| Secretos filtrados a logs                  | Redacción central y pruebas específicas                      |
| Módulos fuertemente acoplados              | Puertos internos, comandos y eventos tipados                 |
| Alcance excesivo                           | Criterios por fase y lista explícita de exclusiones          |

## 11. Salida de la Fase 0

La Fase 0 se considera cerrada cuando arquitectura, seguridad, datos, IPC, pruebas y aceptación no tienen contradicciones conocidas y permiten estimar e implementar la Fase 1 sin tomar decisiones estructurales improvisadas.
