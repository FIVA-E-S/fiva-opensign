#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${DOCKER_CONFIG:-}" && "$DOCKER_CONFIG" == "${RUNNER_TEMP:?}/fiva-docker-"* ]]; then
 docker logout "${ECR_REGISTRY:?}" >/dev/null 2>&1 || true
 rm -rf -- "$DOCKER_CONFIG"
fi
if [[ -n "${AWS_CONTEXT_DIR:-}" && "$AWS_CONTEXT_DIR" == "${RUNNER_TEMP:?}/fiva-eks-"* ]]; then rm -rf -- "$AWS_CONTEXT_DIR"; fi
