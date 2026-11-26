#!/bin/sh
# Render checks of the hosted deployment files: `docker compose config` of the stack (and of the
# drill overrides), `helm lint` and `helm template` of the chart for each ci/*-values.yaml with a
# Kubernetes schema check (kubeconform), and a parse of every rendered deployment configuration
# by Foxwarm itself. Needs docker (CLI with the compose plugin), helm and kubeconform on PATH;
# FOXWARM_CHECK_BINARY (a Foxwarm build) or FOXWARM_HOSTED_IMAGE (the hosted image) enables the
# parse check.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
kubernetes="${KUBERNETES_VERSION:-1.31.0}"

sh "$here/generate-secrets.sh" "$work/secrets" >/dev/null
cp -R "$work/secrets" "$work/stack-secrets"
# compose.yaml names ./secrets; render it from a copy of this directory with generated ones.
mkdir "$work/stack"
cp -R "$here/compose.yaml" "$here/deployment.yaml" "$here/haproxy.cfg" "$here/postgres-init" "$here/drills" "$work/stack/"
mv "$work/stack-secrets" "$work/stack/secrets"
docker compose -f "$work/stack/compose.yaml" config --quiet
echo "compose: compose.yaml renders"
FOXWARM_DRILL_SECRETS="$work/secrets" docker compose -f "$work/stack/compose.yaml" -f "$work/stack/drills/compose.drill.yaml" --profile drill config --quiet
echo "compose: compose.yaml with drills/compose.drill.yaml renders"

parse() { # $1: a deployment configuration file
  if [ -n "${FOXWARM_CHECK_BINARY:-}" ]; then
    output="$(FOXWARM_DEPLOYMENT_CONFIG="$1" "$FOXWARM_CHECK_BINARY" hosted health 2>&1 || true)"
  elif [ -n "${FOXWARM_HOSTED_IMAGE:-}" ]; then
    output="$(docker run --rm --read-only -v "$1:/etc/foxwarm/deployment.yaml:ro" "$FOXWARM_HOSTED_IMAGE" hosted health 2>&1 || true)"
  else
    echo "parse: skipped (no FOXWARM_CHECK_BINARY or FOXWARM_HOSTED_IMAGE)"
    return 0
  fi
  # `hosted health` parses the file before probing; with no replica running, the probe is
  # refused, while a configuration error names the deployment configuration instead.
  case "$output" in
    *"Deployment configuration"*|*"FOXWARM_DEPLOYMENT_CONFIG"*) echo "parse: $1 refused: $output" >&2; exit 1 ;;
    *"Connection refused"*) echo "parse: $(basename "$1") is a valid deployment configuration" ;;
    *) echo "parse: unexpected output for $1: $output" >&2; exit 1 ;;
  esac
}
parse "$here/deployment.yaml"
parse "$here/drills/deployment.drill.yaml"

chart="$here/helm/foxwarm"
for values in "$chart"/ci/*-values.yaml; do
  name="$(basename "$values" .yaml)"
  helm lint "$chart" --strict -f "$values" >/dev/null
  helm template foxwarm "$chart" -f "$values" > "$work/$name.yaml"
  kubeconform -strict -summary -kubernetes-version "$kubernetes" "$work/$name.yaml"
  # The ConfigMap's deployment.yaml, as a replica reads it.
  awk '/^  deployment.yaml: \|/{grab=1; next} grab && /^    /{sub(/^    /, ""); print; next} grab{grab=0}' "$work/$name.yaml" > "$work/$name.deployment.yaml"
  test -s "$work/$name.deployment.yaml"
  parse "$work/$name.deployment.yaml"
  echo "helm: $name renders and validates"
done
# Required values are enforced.
if helm template foxwarm "$chart" --set image.repository=x >/dev/null 2>&1; then
  echo "helm: rendering without secrets should fail" >&2
  exit 1
fi
echo "helm: missing secrets are refused"
