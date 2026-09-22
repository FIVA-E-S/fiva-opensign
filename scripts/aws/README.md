# Despliegue AWS

Estos helpers actualizan únicamente las imágenes de los deployments AWS
existentes. Conservan configuración, secretos, almacenamiento, seguridad y
réplicas. No aplicar los manifiestos antiguos de Azure al clúster AWS.

Documentación operativa y recuperación:
https://github.com/FIVA-E-S/fiva_server/blob/main/developer_docs/fiva_server/deployment.md

Las verificaciones manuales usan server dry-run y publican una imagen mínima de
prueba en ECR; nunca despliegan esa imagen. Los cambios normales en main activan
el despliegue de la aplicación con un digest inmutable.
