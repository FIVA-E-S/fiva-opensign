#!/usr/bin/env bash
set -euo pipefail
repository=${1:?ECR repository}; dockerfile=${2:?Dockerfile}; context=${3:?build context}; tag=${4:?tag}; output_key=${5:-image}
[[ "$tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || exit 2
uri="${ECR_REGISTRY:?}/$repository"
# Successful list is required: an AWS outage must not trigger a rebuild.
digest=$(aws ecr describe-images --repository-name "$repository" --filter tagStatus=TAGGED --query "imageDetails[?contains(imageTags, '$tag')].imageDigest | [0]" --output text)
if [[ "$digest" == None ]]; then
 docker buildx build --pull --provenance=false --platform linux/amd64 -f "$dockerfile" -t "$uri:$tag" --push "$context"
 digest=$(aws ecr describe-images --repository-name "$repository" --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text)
fi
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
printf '%s=%s@%s\n' "$output_key" "$uri" "$digest" >> "$GITHUB_OUTPUT"
