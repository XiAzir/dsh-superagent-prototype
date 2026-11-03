#!/usr/bin/env python3
"""Provision private credentials and a restricted reverse-forward account on a VPS."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import subprocess
import re
from urllib.parse import urlsplit

PRIVATE = Path('/root/.cnb-superagent')
ACCOUNT = 'cnb-superagent-web'
ROOT = Path(__file__).resolve().parent
DEFAULT_PUBLIC_ORIGIN = 'https://superagent.example.com'

def public_origin():
    value = os.environ.get('PUBLIC_ORIGIN', DEFAULT_PUBLIC_ORIGIN)
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname or ''
        port = parsed.port
    except ValueError:
        raise SystemExit('PUBLIC_ORIGIN must be a valid HTTPS origin.') from None
    labels = hostname.split('.')
    valid_host = (len(hostname) <= 253 and len(labels) >= 2 and all(
        re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
        for label in labels))
    if (parsed.scheme != 'https' or not valid_host or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or any(ord(char) < 0x21 or ord(char) == 0x7f for char in value)
            or (port is not None and not 1 <= port <= 65535)):
        raise SystemExit('PUBLIC_ORIGIN must be a safe HTTPS origin without a path or credentials.')
    normalized_host = hostname.lower()
    if port is not None and port != 443:
        normalized_host += f':{port}'
    return f'https://{normalized_host}'

def web_username():
    value = os.environ.get('SUPERAGENT_WEB_USERNAME', 'operator')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value):
        raise SystemExit('SUPERAGENT_WEB_USERNAME must contain 1-64 letters, digits, underscores, or hyphens.')
    return value

def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)

def private_write(path, text, exclusive=True):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC), 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        stream.write(text)
    os.chmod(path, 0o600)

def ensure_private(path, text):
    if path.is_symlink():
        raise SystemExit('Private configuration must be a regular file.')
    if path.exists():
        os.chown(path, 0, 0)
        os.chmod(path, 0o600)
        if path.read_text() != text:
            raise SystemExit('Existing private configuration differs; review before changing it.')
    else:
        private_write(path, text)

if os.geteuid() != 0:
    raise SystemExit('Run this script through SSH as root.')
origin = public_origin()
username = web_username()
os.umask(0o077)
PRIVATE.mkdir(mode=0o700, exist_ok=True)
key = PRIVATE / 'web-tunnel-ed25519'
if not key.exists():
    run(['ssh-keygen', '-q', '-t', 'ed25519', '-f', str(key), '-N', '', '-C', 'cnb-superagent-web'])
public = key.with_suffix('.pub').read_text().strip()
if not public.startswith('ssh-ed25519 '):
    raise SystemExit('Unexpected tunnel key type.')
try:
    account = pwd.getpwnam(ACCOUNT)
    if account.pw_shell != '/usr/sbin/nologin':
        raise SystemExit('Existing account has an unexpected shell; review before proceeding.')
except KeyError:
    run(['useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', ACCOUNT])
keys_dir = Path('/etc/ssh/authorized_keys')
if keys_dir.is_symlink():
    raise SystemExit('Authorized key directory must be a regular directory.')
keys_dir.mkdir(mode=0o755, exist_ok=True)
# The private umask above also applies to mkdir; sshd reads as the target user.
# This directory contains public keys only and must allow that user's traversal.
os.chown(keys_dir, 0, 0)
os.chmod(keys_dir, 0o755)
authorized = keys_dir / ACCOUNT
expected = 'restrict,port-forwarding,permitlisten="127.0.0.1:13083" ' + public + '\n'
if authorized.exists() and authorized.read_text() != expected:
    raise SystemExit('Unexpected existing authorized key; review before replacing.')
if not authorized.exists():
    private_write(authorized, expected)
# sshd reads this root-owned file after dropping privileges to the target user.
os.chmod(authorized, 0o644)
sshd_file = Path('/etc/ssh/sshd_config.d/90-superagent-web.conf')
desired = (ROOT / 'web-sshd.conf').read_text()
if sshd_file.exists() and sshd_file.read_text() != desired:
    raise SystemExit('Unexpected existing SSH Match config; review before replacing.')
if not sshd_file.exists():
    private_write(sshd_file, desired)
run(['sshd', '-t'])
run(['systemctl', 'reload', 'ssh'])

credentials = PRIVATE / 'web-credentials.json'
if not credentials.exists():
    private_write(credentials, json.dumps({'username': username, 'password': secrets.token_urlsafe(24),
                                          'proxy_secret': secrets.token_hex(32)}, separators=(',', ':')) + '\n')
values = json.loads(credentials.read_text())
os.chown(credentials, 0, 0)
os.chmod(credentials, 0o600)
if (values.get('username') != username or not isinstance(values.get('password'), str)
        or not re.fullmatch(r'[A-Za-z0-9_-]{32,}', values['password'])
        or not isinstance(values.get('proxy_secret'), str)
        or not re.fullmatch(r'[0-9a-f]{64}', values['proxy_secret'])):
    raise SystemExit('Existing web credentials have an unexpected format.')
if not Path('/etc/nginx/cnb-superagent.htpasswd').exists():
    password_hash = run(['openssl', 'passwd', '-6', '-stdin'], input=(values['password'] + '\n').encode()).stdout.decode().strip()
    private_write(Path('/etc/nginx/cnb-superagent.htpasswd'), values['username'] + ':' + password_hash + '\n')
    import grp
    os.chown('/etc/nginx/cnb-superagent.htpasswd', 0, grp.getgrnam('www-data').gr_gid)
    os.chmod('/etc/nginx/cnb-superagent.htpasswd', 0o640)
env = Path('/etc/cnb-superagent-web.env')
ensure_private(env, 'PUBLIC_ORIGIN=' + origin + '\nSUPERAGENT_PROXY_SECRET=' + values['proxy_secret'] + '\n')
snippet = Path('/etc/nginx/snippets/cnb-superagent-proxy-auth.conf')
ensure_private(snippet, 'proxy_set_header X-Superagent-Proxy-Key "' + values['proxy_secret'] + '";\n')
print(json.dumps({'account':ACCOUNT,'web_username':values['username'],
                  'proxy_fingerprint':hashlib.sha256(values['proxy_secret'].encode()).hexdigest()[:12],
                  'key_fingerprint':run(['ssh-keygen','-lf',str(key.with_suffix('.pub'))]).stdout.decode().strip()}))
