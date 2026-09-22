#!/usr/bin/env bash
# Public repositories build on GitHub-hosted machines. Only this deployment task
# enters the VPC; it receives no operator credentials and cannot read other namespaces.
set -euo pipefail
operation=${1:?verify or deploy}
[[ "$operation" == verify || "$operation" == deploy ]] || exit 2
[[ "${GITHUB_SHA:?}" =~ ^[0-9a-f]{40}$ ]] || exit 2
request=$(mktemp "${RUNNER_TEMP:?}/fiva-codebuild-XXXXXX.json")
trap 'rm -f "$request"' EXIT
jq -n --arg op "$operation" --arg sha "$GITHUB_SHA" --arg server "${SERVER_IMAGE:-}" --arg client "${CLIENT_IMAGE:-}" \
 '{projectName:"fiva-opensign-deploy",environmentVariablesOverride:[
 {name:"SOURCE_SHA",value:$sha,type:"PLAINTEXT"},
 {name:"OPERATION",value:$op,type:"PLAINTEXT"},
 {name:"SERVER_IMAGE",value:$server,type:"PLAINTEXT"},
 {name:"CLIENT_IMAGE",value:$client,type:"PLAINTEXT"}]}' > "$request"
build_id=$(aws codebuild start-build --cli-input-json "file://$request" --query 'build.id' --output text)
printf 'AWS deployment task: %s\n' "$build_id"
printf '\nAWS CodeBuild task: `%s` (operation: `%s`)\n' "$build_id" "$operation" >> "$GITHUB_STEP_SUMMARY"
deadline=$((SECONDS + 2400))
while (( SECONDS < deadline )); do
 result=$(aws codebuild batch-get-builds --ids "$build_id" --output json)
 status=$(jq -er '.builds[0].buildStatus' <<< "$result")
 case "$status" in
  SUCCEEDED) echo 'AWS deployment task succeeded'; exit 0 ;;
  IN_PROGRESS) sleep 10 ;;
  *) jq '.builds[0] | {buildStatus, phases: [.phases[] | select(.phaseStatus == "FAILED" or .phaseStatus == "FAULT" or .phaseStatus == "TIMED_OUT") | {phaseType, phaseStatus, contexts}], logs: {deepLink: .logs.deepLink}}' <<< "$result"; exit 1 ;;
 esac
done
echo 'Timed out waiting for the bounded AWS deployment task; inspect it before retrying.' >&2
exit 1
