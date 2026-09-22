# Despliegue AWS

Estos helpers actualizan únicamente las imágenes de los deployments AWS
existentes. Conservan configuración, secretos, almacenamiento, seguridad y
réplicas. No aplicar los manifiestos antiguos de Azure al clúster AWS.

Documentación operativa y recuperación:
https://github.com/FIVA-E-S/fiva_server/blob/main/developer_docs/fiva_server/deployment.md

Las verificaciones manuales usan server dry-run y publican una imagen mínima de
prueba en ECR; nunca despliegan esa imagen. Los cambios normales en main activan
el despliegue de la aplicación con un digest inmutable.

## Repositorio público

La compilación y publicación ECR se ejecutan en runners alojados por GitHub.
La tarea AWS CodeBuild `fiva-opensign-deploy` ejecuta únicamente la verificación o
el despliegue en la VPC, con un rol limitado al namespace OpenSign. No se abren
los runners privados a PRs de este repositorio público ni se amplía el acceso
público a EKS. CodeBuild consume recursos solo mientras se ejecuta; no mantiene
servidores permanentes. Sus logs se conservan siete días.
