#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
install_dir=/usr/local/lib/cnb-superagent
unit=/etc/systemd/system/cnb-superagent-web.service
backup_dir="/root/.cnb-superagent/web-backups/$(date -u +%Y%m%dT%H%M%S)-$$"
for item in archive_server.py web_gateway.mjs web-gateway.service; do
    [[ -f "$source_dir/$item" ]] || { echo 'Required source is missing.' >&2; exit 1; }
done
[[ -f /etc/cnb-superagent-web.env && -f "$install_dir/archive.py" ]]
was_active=0
was_enabled=0
systemctl is-active --quiet cnb-superagent-web.service && was_active=1
systemctl is-enabled --quiet cnb-superagent-web.service 2>/dev/null && was_enabled=1
install -d -m 0700 "$backup_dir"
for item in archive_server.py web_gateway.mjs; do
    [[ ! -f "$install_dir/$item" ]] || cp -a "$install_dir/$item" "$backup_dir/$item"
done
[[ ! -f "$unit" ]] || cp -a "$unit" "$backup_dir/web-gateway.service"
rollback() {
    trap - ERR
    set +e
    systemctl stop cnb-superagent-web.service 2>/dev/null || true
    for item in archive_server.py web_gateway.mjs; do
        [[ ! -f "$backup_dir/$item" ]] || cp -a "$backup_dir/$item" "$install_dir/$item"
    done
    [[ ! -f "$backup_dir/web-gateway.service" ]] || cp -a "$backup_dir/web-gateway.service" "$unit"
    systemctl daemon-reload
    systemctl restart cnb-superagent-archive.service
    [[ "$was_active" == 0 ]] || systemctl restart cnb-superagent-web.service
    [[ "$was_enabled" == 1 ]] || systemctl disable cnb-superagent-web.service
    echo "Web deployment failed; prior files are preserved in $backup_dir" >&2
    exit 1
}
trap rollback ERR
python3 -m py_compile "$source_dir/archive_server.py"
node --check "$source_dir/web_gateway.mjs"
install -m 0644 "$source_dir/archive_server.py" "$install_dir/archive_server.py"
install -m 0644 "$source_dir/web_gateway.mjs" "$install_dir/web_gateway.mjs"
install -m 0644 "$source_dir/web-gateway.service" "$unit"
systemctl daemon-reload
systemctl restart cnb-superagent-archive.service
systemctl enable cnb-superagent-web.service
systemctl restart cnb-superagent-web.service
# Type=simple reports active before Node/Python have bound their sockets.
# Keep failed probes inside conditionals, so only the parent performs rollback.
ready=0
for attempt in {1..30}; do
    status="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:13084/ || true)"
    if [[ "$status" == 401 ]] &&
        curl --fail --silent --max-time 2 http://127.0.0.1:9012/superagent-runtime/health >/dev/null &&
        systemctl is-active --quiet cnb-superagent-archive.service &&
        systemctl is-active --quiet cnb-superagent-web.service; then
        ready=1
        break
    fi
    sleep 1
done
[[ "$ready" == 1 ]]
echo "Public web backend installed; rollback files: $backup_dir"
