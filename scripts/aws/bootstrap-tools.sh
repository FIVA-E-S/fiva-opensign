#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
printf '%s\n' "$HOME/.local/bin" >> "$GITHUB_PATH"
for tool in docker jq curl python3; do command -v "$tool" >/dev/null; done
if ! command -v aws >/dev/null || [[ "$(aws --version 2>&1)" != aws-cli/2.* ]]; then
 tools_dir=$(mktemp -d "${RUNNER_TEMP:?}/fiva-tools-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-XXXXXX")
 printf 'AWS_TOOLS_DIR=%s\n' "$tools_dir" >> "$GITHUB_ENV"
 curl --fail --silent --show-error --location --retry 3 \
   https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.31.16.zip -o "$tools_dir/awscliv2.zip"
 printf '9e4e8984765a0ff186d5285493231ef8dd034d60482cdc7913477c77230eb3c8  %s/awscliv2.zip\n' "$tools_dir" | sha256sum --check
 python3 -m zipfile -e "$tools_dir/awscliv2.zip" "$tools_dir/unpacked"
 chmod +x "$tools_dir/unpacked/aws/dist/aws" "$tools_dir/unpacked/aws/dist/aws_completer"
 bash "$tools_dir/unpacked/aws/install" --install-dir "$tools_dir/install" --bin-dir "$tools_dir/bin" >/dev/null
 export PATH="$tools_dir/bin:$PATH"
 printf '%s\n' "$tools_dir/bin" >> "$GITHUB_PATH"
fi
aws --version
