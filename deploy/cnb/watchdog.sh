#!/usr/bin/env bash
# An unavailable receiver needs local repair; only a valid health response
# may trigger CNB workspace recovery.
set -euo pipefail
response=$(curl -fsS --connect-timeout 3 --max-time 8 \
    http://127.0.0.1:9012/superagent-runtime/health) || exit 0
printf '%s' "$response" | jq -e '.status == "ok" or .status == "waiting"' >/dev/null || exit 0
export CNB_WATCHDOG_ENV=/etc/cnb-watchdog-superagent.env
exec /usr/local/bin/cnb-watchdog.sh
