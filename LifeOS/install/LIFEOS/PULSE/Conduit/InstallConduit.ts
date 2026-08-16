#!/usr/bin/env bun
/**
 * Conduit launchd installer. Registers `com.lifeos.conduit` to run `conduit capture`
 * on a fixed interval — the stable pattern (stateless one-shot polls restarted by
 * launchd, no long-lived daemon). Mirrors InstallWorkSweep / InstallDerivedSync.
 *
 *   bun InstallConduit.ts            install + load
 *   bun InstallConduit.ts --uninstall  unload + remove
 *   bun InstallConduit.ts --status     show launchd state
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { DATA_ROOT } from "./paths.ts"
import * as systemd from "../../TOOLS/lib/SystemdUser"
import * as win from "../../TOOLS/lib/win-scheduler"

const LABEL = "com.lifeos.conduit"
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const CONDUIT = join(import.meta.dir, "conduit.ts")
const LOG_DIR = join(DATA_ROOT, "logs")
const BUN = process.execPath // the bun binary currently running

/** Escape a string for safe interpolation into a plist XML <string> value. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function plistBody(intervalSec: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(BUN)}</string>
    <string>${escapeXml(CONDUIT)}</string>
    <string>capture</string>
  </array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(join(LOG_DIR, "conduit.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(LOG_DIR, "conduit.err.log"))}</string>
</dict>
</plist>
`
}

function install(): void {
  mkdirSync(LOG_DIR, { recursive: true })
  const intervalSec = loadConfig().pollIntervalSec
  writeFileSync(PLIST, plistBody(intervalSec))
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" })
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["load", PLIST], { stdio: "inherit" })
  console.log(`Installed ${LABEL} → polls every ${intervalSec}s`)
  console.log(`  plist: ${PLIST}`)
  console.log(`  logs:  ${LOG_DIR}`)
}

function uninstall(): void {
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" })
  } catch {
    /* ignore */
  }
  if (existsSync(PLIST)) rmSync(PLIST)
  console.log(`Uninstalled ${LABEL}`)
}

function status(): void {
  try {
    const out = execFileSync("launchctl", ["list"], { encoding: "utf8" })
    const line = out.split("\n").find((l) => l.includes(LABEL))
    console.log(line ? `loaded: ${line.trim()}` : `${LABEL} not loaded`)
  } catch {
    console.log("launchctl unavailable")
  }
}

/* ── systemd --user backend (Linux only) ────────────────────────────────────
 * Strictly additive: every line above is the launchd path and is unchanged.
 * launchd keeps owning the job on darwin and systemd owns it on linux, so no
 * install ever has two schedulers for one job.
 * Translation rules live in ../../TOOLS/lib/SystemdUser.ts.
 * ported from public PR #1698, @elhoim
 * ------------------------------------------------------------------------- */

async function linuxSpec(): Promise<systemd.UnitSpec> {
  return {
    label: LABEL,
    description: "LifeOS Conduit capture",
    // BUN is process.execPath, already absolute — no `which` lookup needed.
    exec: [BUN, CONDUIT, "capture"],
    logPath: join(LOG_DIR, "conduit.out.log"),
    errLogPath: join(LOG_DIR, "conduit.err.log"),
    // Reads the same config key the plist does, so one setting drives both.
    schedule: { kind: "interval", seconds: loadConfig().pollIntervalSec },
  }
}

async function linuxMain(a: string | undefined): Promise<void> {
  const spec = await linuxSpec()
  const log = (m: string) => console.log(`[InstallConduit] ${m}`)
  if (a === "--uninstall") { await systemd.uninstall(spec, log); return }
  if (a === "--status") { if (!(await systemd.status(spec, log))) process.exit(1); return }
  if (!(await systemd.install(spec, log))) process.exit(1)
}

/* ── Windows Task Scheduler backend ─────────────────────────────────────────
 * Strictly additive, same shape as the systemd backend above: launchd owns the
 * job on darwin, systemd on linux, Task Scheduler on win32, and no install ever
 * has two schedulers for one job.
 *
 * Without this, `bun InstallConduit.ts` on Windows wrote a plist into a
 * ~/Library/LaunchAgents path that does not exist and then shelled out to a
 * `launchctl` that is not installed. Conduit was consequently never registered
 * here, while the Services.ts registry went on asserting it was a CORE service
 * in the `running` state — the exact silent-failure class this repair exists to
 * remove. Translation rules live in ../../TOOLS/lib/win-scheduler.ts.
 * ------------------------------------------------------------------------- */

const IS_WIN = process.platform === "win32"

function winSpec(): win.PlistSpec {
  return {
    label: LABEL,
    argv: [BUN, CONDUIT, "capture"],
    startIntervalSec: loadConfig().pollIntervalSec,
    runAtLoad: true,
    // One-shot poll on a timer, not a daemon: keepAlive would make the wrapper
    // guard suppress every tick after the first.
    keepAlive: false,
    watchPaths: false,
    logPath: join(LOG_DIR, "conduit.out.log"),
    env: {},
  }
}

function winMain(a: string | undefined): void {
  if (a === "--uninstall") {
    const r = win.uninstallTask(LABEL)
    console.log(r.code === 0 ? `Uninstalled ${LABEL}` : `Uninstall failed: ${r.out}`)
    if (r.code !== 0) process.exit(1)
    return
  }
  if (a === "--status") {
    const registered = win.registeredLabels().has(LABEL)
    console.log(registered ? `${LABEL} registered as a scheduled task` : `${LABEL} not registered`)
    if (!registered) process.exit(1)
    return
  }
  mkdirSync(LOG_DIR, { recursive: true })
  const spec = winSpec()
  const bunDir = BUN.replace(/[\\/][^\\/]+$/, "")
  const r = win.installTask(spec, bunDir)
  if (r.code !== 0) {
    console.error(`Install FAILED for ${LABEL}: ${r.out}`)
    process.exit(1)
  }
  console.log(`Installed ${LABEL} → polls every ${spec.startIntervalSec}s`)
  console.log(`  task: \\LifeOS\\${LABEL}`)
  console.log(`  logs: ${LOG_DIR}`)
}

const arg = process.argv[2]
if (IS_WIN) winMain(arg)
else if (systemd.isLinux()) await linuxMain(arg)
else if (arg === "--uninstall") uninstall()
else if (arg === "--status") status()
else install()
