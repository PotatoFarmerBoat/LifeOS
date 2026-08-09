# LifeOS on Windows — Native Install (windows-port)

Native Windows installation from this branch. No WSL. Every step below was
executed and verified on Windows 11 (26200) on 2026-08-09 — evidence in
[WINDOWS-PORT-ISA.md](WINDOWS-PORT-ISA.md).

## Prerequisites

| What | Why | Get it |
|---|---|---|
| Git for Windows | Claude Code runs hooks through its Git Bash; `git` on PATH | `winget install Git.Git` |
| bun ≥ 1.2 | Runs every installer tool and most hooks | `winget install Oven-sh.Bun` |
| Claude Code CLI | The harness itself, authenticated (`claude` → `/login`) | `npm install -g @anthropic-ai/claude-code` |

Open a **fresh** PowerShell after installing so PATH is current.

## 1. Get the code

```powershell
git clone -b windows-port https://github.com/PotatoFarmerBoat/LifeOS.git
cd LifeOS\LifeOS
```

## 2. Set HOME for this session

Windows doesn't set `HOME`; the installer tools fall back to it. Without this,
paths resolve wrong (upstream #1729 class).

```powershell
$env:HOME = $env:USERPROFILE
```

## 3. Look before you leap (read-only)

```powershell
bun Tools\DetectEnv.ts       # expect bun/git installed:true, harness detected
bun Tools\ScanConflicts.ts   # what already lives in your ~/.claude
```

If `ScanConflicts` shows existing hooks or user content, read its output before
continuing — everything below is additive, but know your starting state.

## 4. Deploy core + user tree

```powershell
bun Tools\DeployCore.ts            # dry run — review
bun Tools\DeployCore.ts --apply
bun Tools\ScaffoldUser.ts --apply  # user tree → ~/.config/LIFEOS/USER
bun Tools\LinkUser.ts --apply      # directory junction, no elevation needed
```

## 5. Hooks — choose your variant

**Existing `settings.json` you maintain by hand (recommended default):**

```powershell
bun Tools\InstallHooks.ts --omit MergeSettings.ts --omit 31337   # dry run: expect added 48, omitted 3
bun Tools\InstallHooks.ts --omit MergeSettings.ts --omit 31337 --apply
```

- `--omit MergeSettings.ts` drops the SessionStart entry that regenerates
  `settings.json` from LifeOS-owned sources on every launch. Skipping it keeps
  ownership of the file with you. (It also drops the paired SettingsBackport
  step — intended; that pair only makes sense together.)
- `--omit 31337` drops the two `http://localhost:31337` guard hooks — dead
  weight unless you run the Pulse server.

**Fresh config, full LifeOS ownership:** run without `--omit` (51 entries).

Either way the tool backs up `settings.json` first
(`settings.json.lifeos-backup-<epoch>`) and merges additively — your existing
keys (permissions, theme, …) are untouched.

## 6. Wire the launcher

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Force $PROFILE | Out-Null }
Add-Content $PROFILE 'function lifeos { & "$env:USERPROFILE\.claude\LIFEOS\TOOLS\lifeos.ps1" @args }'
. $PROFILE
```

`lifeos` now launches Claude Code with `--append-system-prompt-file
…\LIFEOS_SYSTEM_PROMPT.md` — the constitutional layer. A plain `claude` session
deliberately does not load it. (cmd users: put `%USERPROFILE%\.claude\LIFEOS\TOOLS`
on PATH and run `lifeos.cmd`.)

## 7. Verify

```powershell
bun "$env:USERPROFILE\.claude\LIFEOS\TOOLS\Doctor.ts"
```

Expect **"Hook interpreter resolution — live"**. Two optional tools several
hooks shell out to:

```powershell
winget install BurntSushi.ripgrep.MSVC jqlang.jq
```

Remaining ❌ lines (codex, Cloudflare, ElevenLabs, Interceptor…) are optional
capabilities — decline them for good with `Doctor.ts decline <name>`.

## Known limitations on Windows (open work)

- **Pulse dashboard / statusline / worksweep / derivedsync** — launchd-based;
  Task Scheduler equivalents are W10 in the ISA, not yet built.
- **SessionEnd hooks under `claude -p`** report "Hook cancelled" — print-mode
  teardown grace, not a defect (each exits rc=0 standalone). Interactive
  sessions are the normal path.
- macOS-native features (Kitty, macOS Computer Use, voice via `say`) are out of
  scope; Doctor reports them absent without failing.

## Rollback

```powershell
# restore the newest settings backup:
Get-ChildItem "$env:USERPROFILE\.claude\settings.json.lifeos-backup-*" | Sort-Object Name | Select-Object -Last 1
# then remove what the install added:
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\LIFEOS", "$env:USERPROFILE\.claude\hooks", "$env:USERPROFILE\.claude\skills"
```

(`~/.config/LIFEOS/USER` holds your data — it is deliberately not in the
rollback line. Delete it only if you mean it.)

## Troubleshooting breadcrumbs (every entry was hit for real, 2026-08-09)

| Symptom | Cause → fix |
|---|---|
| Files land in a relative `.claude` or weird paths during install | `HOME` unset (Windows never sets it) → `$env:HOME = $env:USERPROFILE` in the session first |
| DetectEnv says bun/git not installed though they run | You're on upstream/pre-fix code — must be `windows-port` (fix: `Bun.which` replaced `command -v`, InstallEngine.ts) |
| LinkUser fails EPERM on symlink | Pre-fix branch; `windows-port` uses junctions (no elevation) |
| Doctor: "not executable (chmod +x)" ×31 / "bun: not on PATH" | Pre-fix Doctor lying — hooks actually fire (proven live). Doctor on `windows-port` checks correctly |
| `ENOENT uv_spawn 'claude'` from any tool | npm ships only `.cmd`/`.ps1` shims, no claude.exe; bare `spawn("claude")` dies. Pattern: `claudeArgv()` in lifeos.ts — resolve with `Bun.which`, route `.cmd` via `cmd /c` |
| A hook "doesn't fire" when you test it by piping JSON in PowerShell | PS native-pipe encoding breaks the JSON parse and `catch → exit 0` masks it as a guard rejection. **Always file-redirect:** `bun X.hook.ts < envelope.json` |
| A hook or tool hangs forever | Something shelled to POSIX `find`; `System32\find.exe` shadows it and blocks reading stdin. Known callers: IntegrityCheck's `findFiles` (audit before W10) |
| Hooks silently no-op only on Windows | Backslashed `file_path` vs `'/'`-built string compares (#1119 class). Fixed in 6 files on this branch; the pattern for new code: normalize `.replaceAll('\\','/')` at entry. Regression tests: `Probes/windows/w8.pathform.test.ts` |
| SessionEnd hooks say "Hook cancelled" under `claude -p` | Print-mode teardown grace, NOT a defect — each exits rc=0 standalone. Interactive sessions are the real path |
| Your hand-built `settings.json` rules vanish after a session | The MergeSettings SessionStart hook took ownership (you installed without `--omit MergeSettings.ts`). Restore newest `settings.json.lifeos-backup-*`, reinstall hooks with the omit |
| `gh` commands hit danielmiessler/LifeOS instead of the fork | gh resolves the upstream remote — use `-R PotatoFarmerBoat/LifeOS` or `gh repo set-default` |
| No "Run workflow" button for windows-probes | Workflow lives only on `windows-port`, not the default branch — trigger by pushing to the branch |

**Map of everything:** fork `PotatoFarmerBoat/LifeOS`, branch `windows-port` (green CI baseline: run 31302180037). Clone `C:\Users\zachary.simandl\code\LifeOS`. Disposable probe sandbox `C:\Users\zachary.simandl\code\lifeos-sandbox` (safe to delete whole). Separate installs that do NOT share config: WSL Ubuntu (`wsl -d Ubuntu`, user `zac`, launch with `lifeos`) and the Cowork VM bootstrap kit (`External Brain\_lifeos-cowork\BOOTSTRAP.md`). Evidence for every closed claim: `WINDOWS-PORT-ISA.md` Log.
