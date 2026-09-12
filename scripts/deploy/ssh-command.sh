#!/usr/bin/env bash
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ (sha-[0-9a-f]{40})$ ]]; then
  exec sudo -n /usr/local/sbin/kinan-deploy "${BASH_REMATCH[1]}"
fi
printf 'Only deploy sha-<40-character SHA> is permitted.\n' >&2
exit 64
