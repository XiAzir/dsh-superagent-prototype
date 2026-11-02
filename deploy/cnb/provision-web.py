#!/usr/bin/env python3
"""Provision private credentials and a restricted reverse-forward account on the VPS."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import subprocess
import re

PRIVATE = Path('/root/.cnb-superagent')
ACCOUNT = 'cnb-superagent-web'
ROOT = Path(__file__).resolve().parent

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
    raise SystemExit('Run through ssh wuhan as root.')
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
    private_write(credentials, json.dumps({'username': 'azir', 'password': secrets.token_urlsafe(24),
                                          'proxy_secret': secrets.token_hex(32)}, separators=(',', ':')) + '\n')
values = json.loads(credentials.read_text())
os.chown(credentials, 0, 0)
os.chmod(credentials, 0o600)
if (values.get('username') != 'azir' or not re.fullmatch(r'[A-Za-z0-9_-]{32,}', values.get('password', ''))
        or not re.fullmatch(r'[0-9a-f]{64}', values.get('proxy_secret', ''))):
    raise SystemExit('Existing web credentials have an unexpected format.')
if not Path('/etc/nginx/cnb-superagent.htpasswd').exists():
    password_hash = run(['openssl', 'passwd', '-6', '-stdin'], input=(values['password'] + '\n').encode()).stdout.decode().strip()
    private_write(Path('/etc/nginx/cnb-superagent.htpasswd'), values['username'] + ':' + password_hash + '\n')
    import grp
    os.chown('/etc/nginx/cnb-superagent.htpasswd', 0, grp.getgrnam('www-data').gr_gid)
    os.chmod('/etc/nginx/cnb-superagent.htpasswd', 0o640)
env = Path('/etc/cnb-superagent-web.env')
ensure_private(env, 'PUBLIC_ORIGIN=https://superagent.1994622.xyz\nSUPERAGENT_PROXY_SECRET=' + values['proxy_secret'] + '\n')
snippet = Path('/etc/nginx/snippets/cnb-superagent-proxy-auth.conf')
ensure_private(snippet, 'proxy_set_header X-Superagent-Proxy-Key "' + values['proxy_secret'] + '";\n')
print(json.dumps({'account':ACCOUNT,'web_username':values['username'],
                  'proxy_fingerprint':hashlib.sha256(values['proxy_secret'].encode()).hexdigest()[:12],
                  'key_fingerprint':run(['ssh-keygen','-lf',str(key.with_suffix('.pub'))]).stdout.decode().strip()}))
