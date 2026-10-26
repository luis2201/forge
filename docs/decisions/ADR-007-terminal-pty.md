# ADR-007 — Terminal PTY explícito y acotado

Estado: aceptada  
Fecha: 2026-08-12

## Contexto

La Fase 2 requiere una terminal local interactiva. Una terminal permite ejecutar comandos arbitrarios elegidos por el usuario, mientras que la arquitectura prohíbe exponer al renderer una primitiva genérica de ejecución que otros módulos puedan reutilizar sin control.

## Decisión

Electron Main administra sesiones `node-pty`; el renderer usa xterm.js como presentación. `terminal.create` acepta únicamente un workspace autorizado y dimensiones acotadas. Main selecciona PowerShell en Windows y fija la root como `cwd`. Los únicos comandos IPC son crear, escribir bytes, redimensionar y cerrar; no se permite escoger binario, argumentos iniciales ni directorio.

Las sesiones pertenecen al workspace y se cierran con él o al finalizar la aplicación. Datos, salida y cierre circulan mediante contratos tipados.

## Consecuencias

- El usuario conserva una terminal real para su trabajo diario.
- Un XSS no obtiene una API genérica para iniciar procesos diferentes, aunque podría escribir en una sesión que el usuario haya abierto; por eso CSP, aislamiento y prevención de XSS siguen siendo controles críticos.
- Automatizaciones, IA y módulos futuros no pueden apropiarse de este permiso: necesitarán comandos y autorizaciones propios.
- `node-pty` es una dependencia nativa que debe probarse también dentro del paquete Windows.

## Alternativas descartadas

- Simular una terminal o limitarla a comandos predefinidos: no satisface el objetivo funcional.
- Exponer `spawn` o `shell.execute` al renderer: amplía innecesariamente la superficie privilegiada.
