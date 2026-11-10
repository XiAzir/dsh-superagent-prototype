#!/usr/bin/env bash
# Dedicated recovery preserves import diagnostics and verifies the startup build.
set -euo pipefail
exec 9>/run/lock/cnb-superagent-recovery.lock
flock -n 9 || exit 0
exec python3 /usr/local/lib/cnb-superagent/recovery.py --env-file /etc/cnb-watchdog-superagent.env "$@"
