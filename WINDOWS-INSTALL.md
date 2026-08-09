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
