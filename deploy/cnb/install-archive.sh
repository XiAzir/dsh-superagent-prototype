#!/usr/bin/env bash
set -Eeuo pipefail

readonly SERVICE_USER='cnb-superagent'
readonly SERVICE_GROUP='cnb-superagent'
readonly SERVICE_NAME='cnb-superagent-archive.service'
readonly INSTALL_DIR='/usr/local/lib/cnb-superagent'
readonly STATE_DIR='/var/lib/cnb-superagent'
readonly ENV_FILE='/etc/cnb-superagent-archive.env'
readonly PORT='9012'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fail() {
    printf 'CNB archive installation failed: %s\n' "$1" >&2
    exit 1
}

[[ "${EUID}" -eq 0 ]] || fail 'run this installer as root.'
command -v systemctl >/dev/null 2>&1 || fail 'systemd is required.'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required.'
command -v install >/dev/null 2>&1 || fail 'install is required.'

for source in archive.py archive_server.py archive.service; do
    [[ -f "${SCRIPT_DIR}/${source}" ]] || fail "required source file is missing: ${source}."
done

[[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || fail "create ${ENV_FILE} with the archive token and settings first."
chown root:root "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"
if ! python3 - "${ENV_FILE}" <<'PY'
import re
import sys

required = {
    "SUPERAGENT_ARCHIVE_TOKEN",
    "SUPERAGENT_ARCHIVE_DIR",
    "SUPERAGENT_ARCHIVE_PORT",
}
values = {}
try:
    with open(sys.argv[1], encoding="utf-8") as source:
        for raw in source:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or key in values:
                raise ValueError
            values[key] = value.strip()
    token = values["SUPERAGENT_ARCHIVE_TOKEN"]
    if not re.fullmatch(r"[A-Za-z0-9_+/=-]{32,}", token):
        raise ValueError
    if values["SUPERAGENT_ARCHIVE_DIR"] != "/var/lib/cnb-superagent":
        raise ValueError
    if values["SUPERAGENT_ARCHIVE_PORT"] != "9012":
        raise ValueError
    if not required.issubset(values):
        raise ValueError
except (OSError, KeyError, ValueError):
    sys.exit(1)
PY
then
    fail "${ENV_FILE} must define a 32+ character token, ${STATE_DIR}, and port ${PORT}."
fi

if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    groupadd --system "${SERVICE_GROUP}"
fi
if ! getent passwd "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --gid "${SERVICE_GROUP}" --home-dir /nonexistent --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o root -g root -m 0755 "${INSTALL_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 "${STATE_DIR}"
install -o root -g root -m 0644 "${SCRIPT_DIR}/archive.py" "${INSTALL_DIR}/archive.py"
install -o root -g root -m 0644 "${SCRIPT_DIR}/archive_server.py" "${INSTALL_DIR}/archive_server.py"
install -o root -g root -m 0644 "${SCRIPT_DIR}/archive.service" "/etc/systemd/system/${SERVICE_NAME}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null
systemctl restart "${SERVICE_NAME}"
systemctl is-active --quiet "${SERVICE_NAME}" || fail 'the dedicated archive service did not become active.'

printf 'Installed and started %s. The service uses %s on 127.0.0.1:%s.\n' \
    "${SERVICE_NAME}" "${STATE_DIR}" "${PORT}"
