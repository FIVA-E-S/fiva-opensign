#!/usr/bin/env bash
set -euo pipefail
verification_dir=$(mktemp -d "${RUNNER_TEMP:?}/fiva-ecr-verify-XXXXXX")
trap 'rm -rf -- "$verification_dir"' EXIT
printf 'Fiva GitHub OIDC ECR access verification\n' > "$verification_dir/verification.txt"
printf 'FROM scratch\nCOPY verification.txt /verification.txt\n' > "$verification_dir/Dockerfile"
while read -r repository; do
 bash scripts/aws/build-image.sh "$repository" "$verification_dir/Dockerfile" "$verification_dir" "ci-access-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" verification_image
 printf '| %s | ECR push verified (verification artifact only) |\n' "$repository" >> "$GITHUB_STEP_SUMMARY"
done < <(awk '!/^#/ && NF == 4 {print $4}' scripts/aws/workloads.txt | sort -u)
