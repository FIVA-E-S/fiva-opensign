#!/usr/bin/env bash
set -euo pipefail
# Never write the operator's ~/.kube/config or reuse its AWS login profile.
[[ "${AWS_CLUSTER_NAME:?}" == fiva-prod && "${AWS_REGION:?}" == eu-west-1 ]] || exit 2
[[ "$(aws sts get-caller-identity --query Account --output text)" == 325836185229 ]] || exit 2
command -v jq >/dev/null
context_dir=$(mktemp -d "${RUNNER_TEMP:?}/fiva-eks-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-XXXXXX")
chmod 700 "$context_dir"
export KUBECONFIG="$context_dir/config"
# A fixed kubectl version avoids invoking a laptop wrapper or an Azure context.
curl --fail --silent --show-error --location --retry 3 \
 https://dl.k8s.io/release/v1.34.4/bin/linux/amd64/kubectl -o "$context_dir/kubectl"
curl --fail --silent --show-error --location --retry 3 \
 https://dl.k8s.io/release/v1.34.4/bin/linux/amd64/kubectl.sha256 -o "$context_dir/kubectl.sha256"
(cd "$context_dir"; printf '%s  kubectl\n' "$(cat kubectl.sha256)" | sha256sum --check)
chmod 700 "$context_dir/kubectl"
aws eks update-kubeconfig --name "$AWS_CLUSTER_NAME" --region "$AWS_REGION" --kubeconfig "$KUBECONFIG" --alias fiva-github-aws >/dev/null
printf 'KUBECONFIG=%s\nAWS_CONTEXT_DIR=%s\n' "$KUBECONFIG" "$context_dir" >> "$GITHUB_ENV"
printf '%s\n' "$context_dir" >> "$GITHUB_PATH"
