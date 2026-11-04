# Windows maintenance build

This checkout carries local Windows compatibility changes on top of upstream commit
`6337fc823ce20251c8de8085948165c81aaa701e`. Keep the patch when updating upstream; this
is a locally maintained build of the research prototype.

## Requirements

- Windows 10/11, PowerShell 7 (`pwsh`), Node.js >=24.9.0, Git for Windows and pnpm.
- Python 3.8+ (`python`) for the optional service manager.
- GitHub CLI 2.48+ and a dedicated agent account before connecting a repository.
- DeepSeek Harness compatible with `engines.dsh`; the local installation uses 0.2.2-rc.1.

Use a separate `superagent` DSH profile. Keep the existing interactive `web` profile
unchanged. Account configuration stays pending until the operator selects the
repository, dedicated account and allowed users. Installing the bundle does not
authorize any GitHub or Feishu writes.

## Install and foreground launch

From PowerShell 7, in the maintained checkout:

```powershell
pnpm install --frozen-lockfile
pnpm build
# Run the next command only for a brand new profile.
dsh --profile superagent --from-default-profile web --dump-config
dsh plugin --profile superagent add "link:$((Get-Location).Path)"
```

Set the profile's `cordis.patch.yml` to use a drive-qualified state path, for example:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: C:/Users/your-user/.dsh/state/superagent
```

Then run:

```powershell
dsh --profile superagent --no-open
```

Open the local URL DSH prints and select **Superagent**. The initial state should
ask for the GitHub repository and the agent CLI. No worker starts while setup is
pending. A model provider must also be configured for this dedicated profile.

Windows startup protects the state directory with an owner-only inheritable NTFS
DACL before creating the database. The operator's OS account still owns workers;
use a dedicated Windows account when OS-level isolation is required.

## Dedicated GitHub account

Create a dedicated `.ps1` wrapper, for example `gh-agent.ps1`:

```powershell
param()
$env:GH_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'dsh-superagent-gh'
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
& gh.exe @args
exit $LASTEXITCODE
```

Authenticate in your own terminal:

```powershell
pwsh -NoProfile -File C:/absolute/path/gh-agent.ps1 auth login
pwsh -NoProfile -File C:/absolute/path/gh-agent.ps1 api user --jq .login
```

Use that wrapper's absolute path in the GitHub Source settings. Keep credentials
out of prompts, config examples and chat. `.ps1` wrappers run through PowerShell 7;
native executables run with an argument vector. Feishu is optional and requires
its own bot-only CLI configuration.

For npm-installed CLIs, select their `.ps1` launcher. A `.cmd` launcher with a
matching `.ps1` is resolved to that script; a standalone `.cmd` or `.bat` is
rejected to prevent message text from being reinterpreted by the command shell.

## Ticket preparation

On Windows the configured prepare program runs in PowerShell 7, with the ticket
variables available through `$env:`. For example, after choosing an existing clone:

```powershell
$ticketRef = "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"
$head = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { 'HEAD' }
git -C C:/src/widgets fetch --no-tags "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${head}:${ticketRef}"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git -C C:/src/widgets worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" "$ticketRef"
exit $LASTEXITCODE
```

Use the operator-approved clone path. Explicitly propagate native-command exit
codes so a failed prepare operation becomes a failed Ticket.

## Background lifecycle

The Windows branch uses hidden managed processes rather than tmux. From the checkout:

```powershell
python scripts/dsh-superagent start
python scripts/dsh-superagent status
python scripts/dsh-superagent stop
python scripts/dsh-superagent restart
```

Status codes retain the upstream meanings: 0 ready, 1 stopped/runtime error,
2 source error, 3 waiting for setup. Only the exact profile's managed process is
stopped; an ambiguous or unverified process is refused. Stop marks an intentional
pause so a later `--respect-stop` check leaves it stopped. No recurring check is
created by this installation.

## Verification and updates

`pnpm check` runs typechecking, tests and build. The POSIX-only service fixture
suite remains for Unix; Windows has a separate real-process lifecycle suite.
Windows-specific checks also cover argument preservation, cancellation, account
wrappers, Git credential configuration and inherited state-directory ACLs.

Real GitHub pushes, comments and Feishu messages require separately configured
accounts and operator-approved end-to-end checks. Back up the state database and
preserve this checkout's patch before upgrading upstream.
