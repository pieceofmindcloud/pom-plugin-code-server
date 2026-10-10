#!/usr/bin/env bash
# Rebuild step of the POM's local development rebuild (`development.rebuild`
# in ui/manifest.json). The release build passes the pinned official release
# to cargo through CODE_SERVER_* variables (scripts/build.sh); the POM's local
# rebuild cannot set them, so this step writes the same metadata to
# $POM_PLUGIN_OUT_DIR, where build.rs reads it when the variables are absent.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
out="${POM_PLUGIN_OUT_DIR:?dev-release: POM_PLUGIN_OUT_DIR is not set}"
platform="${POM_PLUGIN_PLATFORM:?dev-release: POM_PLUGIN_PLATFORM is not set}"

metadata="$("$root/scripts/fetch-runtime.sh" --platform "$platform" --metadata-only)"
mkdir -p "$out"
{
  printf 'CODE_SERVER_URL=%s\n' "$(printf '%s\n' "$metadata" | sed -n 's/^url=//p')"
  printf 'CODE_SERVER_SHA256=%s\n' "$(printf '%s\n' "$metadata" | sed -n 's/^sha256=//p')"
  printf 'CODE_SERVER_SIZE=%s\n' "$(printf '%s\n' "$metadata" | sed -n 's/^size=//p')"
  printf 'CODE_SERVER_VERSION=%s\n' "$(printf '%s\n' "$metadata" | sed -n 's/^version=//p')"
  printf 'CODE_SERVER_ROOT=%s\n' "$(printf '%s\n' "$metadata" | sed -n 's/^server_root=//p')"
} > "$out/code-server-release.env"
grep -q '^CODE_SERVER_URL=https://' "$out/code-server-release.env" \
  || { echo 'dev-release: the official code-server release URL is missing' >&2; exit 2; }
echo "dev-release: $out/code-server-release.env" >&2
