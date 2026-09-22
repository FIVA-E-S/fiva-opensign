#!/usr/bin/env bash
set -euo pipefail
# workload file: namespace deployment container ECR_repository
while read -r namespace deployment container repository; do
 [[ -n "$namespace" && "$namespace" != \#* ]] || continue
 uri="${ECR_REGISTRY:?}/$repository"
 aws ecr describe-repositories --repository-names "$repository" --query 'repositories[0].repositoryUri' --output text | grep -Fx "$uri"
 image=$(kubectl -n "$namespace" get deployment "$deployment" -o json | jq -er --arg c "$container" '.spec.template.spec.containers[] | select(.name == $c) | .image')
 [[ "${image%@*}" == "$uri" ]] || { echo 'Wrong registry/repository in deployment' >&2; exit 1; }
 digest=${image#*@}
 [[ "$(aws ecr describe-images --repository-name "$repository" --image-ids "imageDigest=$digest" --query 'imageDetails[0].imageDigest' --output text)" == "$digest" ]]
 bash scripts/aws/patch-image.sh "$namespace" "$deployment" "$container" "$image" verify
 kubectl -n "$namespace" rollout status "deployment/$deployment" --timeout=30s
 printf '| %s | %s | ECR digest + EKS server dry-run OK |\n' "$namespace" "$deployment" >> "$GITHUB_STEP_SUMMARY"
done < scripts/aws/workloads.txt
