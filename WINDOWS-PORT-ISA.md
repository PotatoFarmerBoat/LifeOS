---
principal_stated_goal: "lifeos really needs to run on windows. natively - not wsl."
phase: climbing
opened: 2026-08-09
home: WINDOWS-PORT-ISA.md (branch windows-port, fork PotatoFarmerBoat/LifeOS)
---

# ISA — LifeOS native on Windows

## Problem

LifeOS v7.28.3 installs but misreports and partially misfunctions on Windows. The 2026-08-09 spike (Log below) proved the **runtime substrate works** — all four hook invocation forms execute via Git Bash, real LifeOS hooks produce their artifacts — while the **detection/diagnostic layer lies** (`detectTool()` uses POSIX `command -v`; Doctor demands `chmod +x`) and one installer step fails outright (`LinkUser` symlink EPERM). Upstream merges Windows fixes readily (#704, #706, #1274 merged; #1733 pattern documented; #1732 open), so residual gaps are contribution targets, not fork burden.

## Vision

A Windows machine with Git for Windows + bun runs `bun Tools/*.ts` install end-to-end, every registered hook fires in live sessions, Doctor tells the truth, and `lifeos` launches a constitution-loaded session from PowerShell — with zero WSL involvement and zero divergence from upstream main.

## Out of Scope

- macOS-native integrations: Kitty terminal persistence, macOS Computer Use / Interceptor browser driving, `say`/`afplay`, launchd plists (Task Scheduler analogues are in scope as W10, plist mechanics are not).
- Cross-vendor audit (codex CLI), Cloudflare/wrangler flows, ElevenLabs voice — optional capabilities, Doctor should report them absent without failing the platform.
- WSL and Cowork-VM paths (both already working; documented elsewhere).

## Constraints

- **Git Bash + bun are declared Windows prerequisites.** Hooks execute via Git Bash (`sh -c`) per Claude Code's Windows default — the port targets that substrate, NOT a PowerShell rewrite of 90 hook scripts. Verified live 2026-08-09.
- **Additive to upstream.** Every fix lands as a PR-able slice against `upstream/main`; the fork's ideal end-state is zero delta.
- **No changes to the operator's real `~/.claude`.** All probes run against disposable config roots via `CLAUDE_CONFIG_DIR` + overridden `HOME`/`USERPROFILE` (pattern proven in the spike; sandbox at `..\lifeos-sandbox\`).

## Goal

`W1–W9` verified on a stock Windows 11 machine and `W11` green on `windows-latest` CI; fixes submitted upstream as reviewable slices.

## Claims

- [x] **W1 — detectTool truth.** With bun/git/claude on PATH, `DetectEnv.ts` reports each installed with version+path. Probe: run on Windows, assert JSON fields. Fixed: `InstallEngine.ts` detectTool + hasBin → `Bun.which()`. Evidence: probe 2026-08-09 — bun 1.3.14 + git 2.54.0 detected with paths; harness confidence `assumed`→`detected`.
- [x] **W2 — LinkUser junction fallback.** On symlink EPERM (unelevated NTFS), `LinkUser.ts --apply` falls back to a directory junction and exits `ok:true`, contract passed. Fixed: both `setupUserSeparation` symlinkSync sites pass `"junction"` on win32 (sibling of #1730). Evidence: probe 2026-08-09 — fresh unelevated scaffold+link, `ok:true`, contract passed, `Get-Item LinkType: Junction`.
- [x] **W3 — Doctor tells the truth on Windows.** Fixed: `which`/`whichPath` → `Bun.which()` (the `':'` PATH split + missing PATHEXT read every binary as absent on win32); mode-bit check gated to POSIX; POSIX shebang paths (`/bin/bash`) probed via basename + Git-for-Windows bash.exe instead of NT `existsSync`. Evidence: probe 2026-08-09 — "Hook interpreter resolution — live", zero chmod strings, bun PATH true.
- [x] **W4 — Hook execution semantics (regression guard).** All four invocation forms fire from a real `claude -p` session on Windows: shell-form with `$HOME` expansion; bare `.ts` by path (shebang); explicit `bun file.ts`; `.sh` script. Probe: `Probes/windows/sentinel/` config, assert 6 log lines. Evidence 2026-08-09: S1/S2/S3/S4/S5/U1 all logged; `uname=MINGW64_NT-10.0-26200`; HOME expanded `/c/Users/...` in sh, `C:\Users\...` in bun — dual-form noted as W8 risk.
- [ ] **W5 — Full-config session start clean.** With the complete 51-hook LifeOS config, SessionStart + UserPromptSubmit hooks run without spawn errors and produce artifacts. Probe: fresh sandbox session; assert `settings.json` merge (51 entries intact), `MEMORY/STATE/drift-reminder.json`, `isa-nudge/*.json`; `--debug` shows zero spawn failures. Evidence 2026-08-09 (partial, pre-auth): all three artifact classes written; MergeSettings preserved 51/11; full pass blocked on CLI auth (see fog).
- [ ] **W6 — Tool-path and Stop events fire.** PreToolUse/PostToolUse/Stop/SessionEnd hooks execute in an authenticated session. Probe: sentinel P1/T1 lines + LifeOS EventLogger/Safety artifacts. Blocked 2026-08-09: CLI OAuth expired (`claude login` required — operator step).
- [ ] **W7 — IntegrityCheck immune to CRLF/BOM** (upstream #1732, open). Probe: fixture tree with CRLF + UTF-8-BOM frontmatter files → zero false findings. First upstream PR slice — scoped, open, goodwill.
- [x] **W8 — Path-form hygiene sweep.** Enumerated: 8 sites / 6 files (ISASync, CheckpointPerISC, change-detection, system-surfaces, subagent, safety-classifier) — all normalised to '/'-form at entry. Evidence: ISASync behavioral A/B (old guard: 0 writes on backslashed file_path; fixed: work.json + work-events.jsonl written) + 5 unit fixtures green (`Probes/windows/w8.pathform.test.ts`). Probe-design gotcha logged: pipe hook stdin from a FILE — PowerShell native-pipe encoding fails the JSON parse and `catch → exit 0` masks it as a guard rejection. Residual (fog): IntegrityCheck's `findFiles` shells to POSIX `find`; System32 find.exe shadows it under cmd spawn.
- [ ] **W9 — Native launcher.** `lifeos.ps1` + `lifeos.cmd` shim spawns claude with `--append-system-prompt-file <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md`, mirroring `Tools/lifeos.ts` behaviour. Probe: `lifeos -p "banner check"` output carries the constitution marker.
- [ ] **W10 — Scheduled components on Task Scheduler.** worksweep/derivedsync/Pulse autostart via `schtasks`, per the #1733 documented pattern. Probe: `schtasks /query` + one observed fire. (Tier 2 — after W1–W9.)
- [ ] **W11 — CI oracle.** `windows-latest` workflow running W1–W5+W7+W8 probes (W6 needs `ANTHROPIC_API_KEY` secret — operator decision). Probe: green Actions run URL on the fork. The loop's independent green.
- Anti: **No PowerShell rewrite of hook scripts** — the substrate is Git Bash; a rewrite forks 90 files from upstream forever.
- Anti: **No fix lands without its probe** — a claim closed on "should work" reopens.
- Anti: **Never run probes against the real `~/.claude`.**

## Not yet specified

- fog: CLI on this machine is 2.1.133 (app: 2.1.226; VM: 2.1.222) — do current-doc hook features (`shell` field, exec form) exist in 2.1.133, and which version is the support floor?
- fog: HOME dual-form inside hooks (sh sees `/c/Users/...`, bun sees `C:\Users\...`) — which specific hooks compare or persist these strings? (Feeds W8 enumeration.)
- fog: Pulse server (`localhost:31337`) on Windows — bun serve + the two `type:http` guard hooks; untested entirely.
- fog: statusline binary on Windows (#1746 closed — verify, don't trust).
- fog: does MergeSettings on a REAL (non-LifeOS-owned) settings.json preserve foreign keys on Windows? (Known design risk from the WSL review; test with fixture before any non-sandbox use.)

## Test Strategy

| claim | type | check | tool |
|---|---|---|---|
| W1 | unit | DetectEnv JSON fields on tool-present PATH | bun test |
| W2 | e2e | LinkUser exit+reparse point, unelevated | bun + PowerShell assert |
| W3 | e2e | Doctor output parse, zero chmod strings | bun |
| W4 | live | sentinel hooklog 6 lines | claude -p (haiku) |
| W5 | live | artifact triple + 51-entry settings survive | claude -p + fs asserts |
| W6 | live | P1/T1 sentinel lines post-auth | claude -p (auth'd) |
| W7 | unit | CRLF/BOM fixture, zero findings | bun test |
| W8 | unit | per-offender dual-form fixtures | bun test |
| W9 | e2e | banner marker in -p output | PowerShell |
| W10 | e2e | schtasks query + fired run | PowerShell |
| W11 | ci | Actions green | windows-latest |

## Ralph protocol (loop contract)

One iteration = (1) pick the topmost unchecked claim, (2) fix the narrowest thing that could close it, (3) run its probe + re-run every previously-green probe, (4) flip the checkbox with a one-line evidence stub (commit hash / probe output ref), (5) commit `W<n>: <what> — probe: <result>`. **Stop when W1–W9 are checked locally and W11 is green.** Escalate instead of iterating when: a probe needs interactive auth, a fix would touch >10 files (class-sweep review first), or two consecutive iterations reopen the same claim.

## Log

- 2026-08-09 · Spike (Windows 11 Pro 26200, bun 1.3.14, git 2.54, claude CLI 2.1.133). Install chain into sandboxed config root: DeployCore ✓ (no blockers), ScaffoldUser ✓ (102 files, honours sandboxed HOME — #1729 fix holds), LinkUser ✗ EPERM (→W2), InstallHooks ✓ (51/11, 90 scripts). Doctor: hook-interpreter false-✗ (→W3). Sentinel session: 4/4 invocation forms fired pre-auth (→W4 ✓). Full-config session: MergeSettings/DriftReminder/AlgorithmNudge artifacts written pre-auth (→W5 partial). CLI OAuth expired → W6 blocked pending `claude login`.
- Decision: Git Bash substrate, not PowerShell rewrite (4/4 forms proven; rewrite = permanent 90-file fork).
- Decision: junction over symlink (unelevated works; upstream precedent #1730).
- Decision: `Bun.which()` over `command -v` (cross-platform, no shell dependency).
