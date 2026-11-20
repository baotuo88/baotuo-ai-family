#!/bin/sh
set -eu
umask 077

# The image owns /data as UID 1000. A new named volume inherits that ownership.
# Do not chown arbitrary mounts or write the host user's Codex configuration.
: "${DATA_DIR:=/data}"
: "${HOME:=${DATA_DIR}/home}"
: "${CODEX_CLI_HOME:=${DATA_DIR}/codex-home}"
: "${CODEX_ADMIN_WORKSPACE:=${DATA_DIR}/runtime/admin}"
: "${CODEX_FAMILY_WORKSPACE:=${DATA_DIR}/runtime/family}"
export DATA_DIR HOME CODEX_CLI_HOME CODEX_ADMIN_WORKSPACE CODEX_FAMILY_WORKSPACE

if ! mkdir -p "$DATA_DIR" "$HOME" "$CODEX_CLI_HOME" \
    "$CODEX_ADMIN_WORKSPACE" "$CODEX_FAMILY_WORKSPACE" \
    "$DATA_DIR/inbox" "$DATA_DIR/office" "$DATA_DIR/outbox"; then
  echo 'Cannot initialize gateway directories. The container runs as UID 1000; check volume ownership.' >&2
  exit 1
fi
if [ ! -w "$DATA_DIR" ] || [ ! -w "$CODEX_CLI_HOME" ]; then
  echo 'Gateway data/credential directories are not writable by the container user.' >&2
  exit 1
fi

# Only normal service startup reconciles configuration. Maintenance/QR/restore
# commands must not rewrite credentials as an unintended side effect.
if [ "${GATEWAY_AUTO_CONFIGURE:-0}" = "1" ] &&
   [ "$#" -eq 2 ] && [ "$1" = "node" ] && [ "$2" = "dist/apps/server/index.js" ]; then
  if [ -f "$DATA_DIR/.settings/models.enc" ]; then
    echo 'Dashboard model settings found; keeping environment bootstrap credentials unchanged.'
  elif [ "${CODEX_CLI_AUTH_MODE:-api_key}" = "api_key" ] && [ -z "${CODEX_CLI_API_KEY:-}" ]; then
    echo 'Model key not configured. Open /admin to complete setup.'
  elif ! node dist/apps/server/configure-codex.js --apply --if-changed --quiet; then
    echo 'Gateway configuration failed. Check CODEX_CLI_* in .env; service not started.' >&2
    exit 1
  fi
fi

exec "$@"
