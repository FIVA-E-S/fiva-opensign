#!/usr/bin/env bash
# Change only images in the existing AWS pod template, including matching init containers.
set -euo pipefail
namespace=${1:?namespace}; deployment=${2:?deployment}; container=${3:?container}; image=${4:?image}
mode=${5:-deploy}
[[ "$mode" == verify || "$mode" == deploy ]] || exit 2
[[ "$image" =~ ^325836185229\.dkr\.ecr\.eu-west-1\.amazonaws\.com/fiva/[a-z0-9-]+@sha256:[0-9a-f]{64}$ ]] || { echo 'An immutable Fiva ECR digest is required' >&2; exit 2; }
repository=${image%@*}
# JSON Patch tests reject concurrent template changes. No secret values are printed.
patch=$(kubectl -n "$namespace" get deployment "$deployment" -o json | jq -ce --arg container "$container" --arg image "$image" --arg repository "$repository" '
 . as $d | .spec.template.spec as $p |
 if ([$p.containers[] | select(.name == $container)] | length) != 1 then error("Container missing or ambiguous") else . end |
 ($p.containers | to_entries | map(select(.value.name == $container)) | .[0]) as $main |
 if (($main.value.image | split("@")[0] | split(":")[0]) != $repository) then error("Unexpected current image repository") else . end |
 [{op:"test",path:"/metadata/resourceVersion",value:$d.metadata.resourceVersion}] +
 (["containers","initContainers"] | map(. as $kind | ($p[$kind] // [] | to_entries[]) |
 select((.value.image | split("@")[0] | split(":")[0]) == $repository) |
 {op:"replace",path:("/spec/template/spec/"+$kind+"/"+(.key|tostring)+"/image"),value:$image}))')
args=()
if [[ "$mode" == verify ]]; then args+=(--dry-run=server); fi
kubectl -n "$namespace" patch deployment "$deployment" --type=json --patch "$patch" "${args[@]}" -o name
