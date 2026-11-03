[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)+$')]
    [string]$Repository,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$')]
    [string]$Branch = 'main',

    [ValidateRange(1, 65535)]
    [int]$LocalPort = 14082,

    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$ArchiveHost = 'archive-server',

    [string]$KnownHostsFile,

    [switch]$InfoOnly,

    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$workspaceBaseUrl = "http://127.0.0.1:${LocalPort}/"
$lookupPython = @'
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "__CNB_REPOSITORY__"
BRANCH = "__CNB_BRANCH__"
API = "https://api.cnb.cool/"
PRIVATE = Path("/root/.cnb-superagent")
SN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SSH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,253}@cnb\.space$")

def request(path, token_path):
    token = token_path.read_text(encoding="utf-8").strip()
    if len(token) < 16:
        raise ValueError
    req = urllib.request.Request(
        API + path,
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.cnb.api+json"},
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        value = json.load(response)
    if not isinstance(value, dict) or value.get("errcode") not in (None, 0):
        raise ValueError
    return value

def main():
    rows = []
    list_token = PRIVATE / "watchdog-list-token"
    has_more = True
    page = 1
    while has_more and page <= 20:
        query = urllib.parse.urlencode({"slug": REPO, "page_size": 100, "page": page})
        value = request("workspace/list?" + query, list_token)
        items = value.get("list", value.get("data"))
        if not isinstance(items, list):
            raise ValueError
        rows.extend(
            item for item in items
            if isinstance(item, dict)
            and item.get("slug") == REPO
            and item.get("branch") == BRANCH
            and item.get("status") == "running"
        )
        has_more = value.get("hasMore") is True
        page += 1
    if has_more or len(rows) != 1:
        raise ValueError
    sn = rows[0].get("sn")
    if not isinstance(sn, str) or not SN_RE.fullmatch(sn):
        raise ValueError
    detail = request(REPO + "/-/workspace/detail/" + urllib.parse.quote(sn, safe=""),
                     PRIVATE / "watchdog-token")
    remote_ssh = detail.get("remoteSsh") or detail.get("ssh")
    if not isinstance(remote_ssh, str) or not SSH_RE.fullmatch(remote_ssh):
        raise ValueError
    print(json.dumps({"sn": sn, "remoteSsh": remote_ssh}, separators=(",", ":")))

try:
    main()
except Exception:
    print("CNB workspace lookup failed.", file=sys.stderr)
    raise SystemExit(1)
'@

$authLinkPython = @'
import json
import re
import sys
from pathlib import Path

LOG_DIR = Path("/workspace/.artifacts")
LOG_GLOB = "dsh-superagent-superagent-*.log"
URL_RE = re.compile(r"http://127\.0\.0\.1:13082/\?[^\s\"'<>]+")
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

try:
    logs = sorted(LOG_DIR.glob(LOG_GLOB), key=lambda path: path.stat().st_mtime, reverse=True)
    if not logs:
        raise ValueError
    try:
        content = logs[0].read_text(encoding="utf-8", errors="replace")
    except OSError:
        raise ValueError
    content = ANSI_RE.sub("", content)
    for line in reversed(content.splitlines()):
        matches = list(URL_RE.finditer(line))
        for match in reversed(matches):
            value = match.group(0).rstrip(".,;)")
            if "token=" in value.partition("?")[2]:
                print(json.dumps({"authUrl": value}, separators=(",", ":")))
                raise SystemExit(0)
    print("Authentication link was not found in the latest runtime logs.", file=sys.stderr)
    raise SystemExit(1)
except ValueError:
    print("Authentication link was not found in the latest runtime log.", file=sys.stderr)
    raise SystemExit(1)
except SystemExit:
    raise
except Exception:
    print("Authentication link lookup failed.", file=sys.stderr)
    raise SystemExit(1)
'@

$lookupPython = $lookupPython.Replace('__CNB_REPOSITORY__', $Repository).Replace('__CNB_BRANCH__', $Branch)

function Invoke-RemotePython {
    param(
        [Parameter(Mandatory)] [string]$Target,
        [Parameter(Mandatory)] [string]$PythonSource,
        [Parameter(Mandatory)] [string[]]$SshOptions
    )

    $result = $PythonSource | & ssh @SshOptions -T $Target python3 -
    if ($LASTEXITCODE -ne 0) {
        throw 'The remote read-only Python request failed.'
    }
    return ($result -join "`n")
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw 'OpenSSH client (ssh) was not found in PATH.'
}

$ArchiveSshOptions = @('-o', 'StrictHostKeyChecking=ask')
$CnbSshOptions = @('-o', 'StrictHostKeyChecking=ask')
if ($KnownHostsFile) {
    $knownHostsPath = (Resolve-Path -LiteralPath $KnownHostsFile -ErrorAction Stop).Path
    $CnbSshOptions = @('-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHostsPath")
}

$lookupText = Invoke-RemotePython -Target $ArchiveHost -PythonSource $lookupPython -SshOptions $ArchiveSshOptions
try {
    $workspace = $lookupText | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw 'The CNB lookup returned an invalid response.'
}

$sn = [string]$workspace.sn
$remoteSsh = [string]$workspace.remoteSsh
if ($sn -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
    $remoteSsh -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,253}@cnb\.space$') {
    throw 'The CNB lookup response failed local validation.'
}

if ($InfoOnly -and $VerifyOnly) {
    throw '-InfoOnly and -VerifyOnly are mutually exclusive.'
}

if ($InfoOnly) {
    [pscustomobject]@{
        sn        = $sn
        remoteSsh = $remoteSsh
        baseURL   = $workspaceBaseUrl
    } | ConvertTo-Json -Compress
    exit 0
}

$authText = Invoke-RemotePython -Target $remoteSsh -PythonSource $authLinkPython -SshOptions $CnbSshOptions
try {
    $authResult = $authText | ConvertFrom-Json -ErrorAction Stop
    $remoteAuthUrl = [Uri]::new([string]$authResult.authUrl, [UriKind]::Absolute)
} catch {
    throw 'The CNB runtime log response was invalid.'
}

if ($remoteAuthUrl.Scheme -ne 'http' -or $remoteAuthUrl.Host -ne '127.0.0.1' -or
    $remoteAuthUrl.Port -ne 13082 -or $remoteAuthUrl.AbsolutePath -ne '/' -or
    $remoteAuthUrl.UserInfo -or $remoteAuthUrl.Fragment -or $remoteAuthUrl.Query -notmatch '(^|[?&])token=[^&]+') {
    throw 'The runtime authentication URL did not match the expected loopback endpoint.'
}

if ($VerifyOnly) {
    [pscustomobject]@{
        urlValid = $true
        origin   = "http://127.0.0.1:${LocalPort}"
    } | ConvertTo-Json -Compress
    exit 0
}

$localAuthUrl = "http://127.0.0.1:${LocalPort}/$($remoteAuthUrl.Query)"
$forward = "127.0.0.1:${LocalPort}:127.0.0.1:13082"
$tunnelOptions = @($CnbSshOptions) + @('-o', 'ExitOnForwardFailure=yes')

Write-Host "CNB workspace: $sn"
Write-Host "SSH target: $remoteSsh"
Write-Host "Open this authenticated link after the tunnel starts:"
Write-Host $localAuthUrl
Write-Host 'Keep this window open; press Ctrl+C to close the tunnel.'

& ssh @tunnelOptions -N -L $forward $remoteSsh
if ($LASTEXITCODE -ne 0) {
    throw "SSH tunnel exited with status $LASTEXITCODE."
}
