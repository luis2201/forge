# ADR-008 — Escritura atómica y versión de contenido

Estado: aceptada  
Fecha: 2026-08-12

## Contexto

El editor debe impedir tanto archivos parcialmente escritos como pérdidas silenciosas cuando otra herramienta modifica el mismo archivo. Timestamp y tamaño no bastan: dos contenidos pueden compartir ambos valores.

## Decisión

Cada lectura calcula una versión SHA-256 del contenido. El guardado exige la versión observada por el editor, vuelve a calcular la del disco y rechaza la operación si difieren. Si coincide, escribe un archivo temporal en el mismo directorio y lo reemplaza mediante rename.

La UI ofrece recargar o sobrescribir solo como decisiones explícitas. Los documentos sucios también bloquean cierres accidentales.

## Consecuencias

- Se detectan cambios de igual tamaño o timestamp y se evita el guardado parcial habitual.
- Leer y guardar tiene un coste lineal adicional, aceptable bajo el límite de 5 MiB de Fase 2.
- La semántica de reemplazo puede requerir un adaptador específico si se soportan plataformas adicionales en el futuro.
