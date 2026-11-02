#!/usr/bin/env python3
"""Explicit, non-secret SSH policy smoke check. Run with ``python deploy/cnb/test_web_ssh_policy.py``."""
from __future__ import annotations

import subprocess
import sys


REMOTE_SCRIPT = r'''#!/usr/bin/env bash
set -uo pipefail
KEY=/root/.cnb-superagent/web-tunnel-ed25519
KNOWN=$(mktemp /tmp/cnb-web-known.XXXXXX)
LOG=$(mktemp /tmp/cnb-web-ssh.XXXXXX)
PID=
RESULT=0
cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$KNOWN" "$LOG"
}
trap cleanup EXIT

awk '{print "8.148.72.235", $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub > "$KNOWN"
chmod 600 "$KNOWN"
COMMON=(-F /dev/null -i "$KEY" -p 22 -oIdentitiesOnly=yes -oBatchMode=yes
  -oHostKeyAlias=8.148.72.235 -oStrictHostKeyChecking=yes
  -oUserKnownHostsFile="$KNOWN" -oGlobalKnownHostsFile=/dev/null
  -oExitOnForwardFailure=yes)
TARGET=cnb-superagent-web@127.0.0.1

if [[ -n "$(ss -H -ltn 'sport = :13083')" ]]; then
  echo port13083_listener=present
else
  echo port13083_listener=absent
fi

ALT_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
: > "$LOG"
timeout 8 ssh -vv "${COMMON[@]}" -N -T -R "127.0.0.1:${ALT_PORT}:127.0.0.1:13082" "$TARGET" >"$LOG" 2>&1
RC=$?
if grep -q 'Authenticated to ' "$LOG" && grep -q 'remote port forwarding failed' "$LOG"; then
  echo alternate_remote_forward=denied
else
  echo alternate_remote_forward=unverified
  RESULT=1
fi

: > "$LOG"
timeout 8 ssh -vv "${COMMON[@]}" "$TARGET" true >"$LOG" 2>&1
RC=$?
if [[ "$RC" -ne 0 ]] && grep -q 'Authenticated to ' "$LOG" && grep -q 'channel 0: open failed' "$LOG"; then
  echo shell_exec=denied
else
  echo shell_exec=unverified
  RESULT=1
fi

LOCAL_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
: > "$LOG"
ssh -vv "${COMMON[@]}" -N -T -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:22" "$TARGET" >"$LOG" 2>&1 &
PID=$!
sleep 1
if ! kill -0 "$PID" 2>/dev/null || ! grep -q 'Authenticated to ' "$LOG"; then
  echo local_forward_setup=failed
  RESULT=1
else
  python3 - "$LOCAL_PORT" <<'PY'
import socket
import sys
try:
    with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=3):
        pass
except OSError:
    pass
PY
  sleep 1
  if grep -q 'administratively prohibited' "$LOG"; then
    echo local_forward_channel=denied
  else
    echo local_forward_channel=unverified
    RESULT=1
  fi
fi
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
fi
PID=

exit "$RESULT"
'''


def main() -> int:
    try:
        result = subprocess.run(['ssh', 'wuhan', 'bash', '-s'],
                                input=REMOTE_SCRIPT.replace('\r\n', '\n').encode('utf-8'),
                                capture_output=True, timeout=90, check=False)
    except (OSError, subprocess.TimeoutExpired):
        print('ssh_policy_check=unavailable')
        return 2
    if result.stdout:
        print(result.stdout.decode('utf-8', errors='replace'), end='')
    if result.returncode:
        print('ssh_policy_check=failed')
        return result.returncode or 1
    print('ssh_policy_check=passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
