/**
 * win-scheduler.ts — run LifeOS background services on Windows Task Scheduler.
 *
 * launchd is the only scheduler Services.ts knew, so on Windows every service
 * reported "✗ missing" and none could be installed: the whole background layer
 * was unreachable on a platform INSTALL.md advertises as fully supported.
 *
 * Rather than duplicate the registry, this translates the launchd plists that
 * already ship with LifeOS. One plist stays the single source of truth for a
 * service's runner, cadence, log path and environment; this file maps that onto
 * `schtasks`. Services with no plist (installed from a private skill or another
 * repo) stay out of scope and are reported as such.
 *
 * Mapping:
 *   ProgramArguments         → the command the wrapper runs
 *   StartInterval <n>        → /SC MINUTE /MO <n/60>  (launchd counts seconds)
 *   StartCalendarInterval    → /SC DAILY /ST <hh:mm>
 *   RunAtLoad + KeepAlive    → /SC ONLOGON with a 5-minute repetition, plus a
 *                              PID-file guard in the wrapper, which is as close
 *                              to KeepAlive as Task Scheduler gets
 *   StandardOut/ErrorPath    → wrapper redirection (schtasks has no equivalent)
 *   WorkingDirectory / env   → set inside the wrapper
 *
 * schtasks /TR has a 261-character limit and mangles nested quotes, so every
 * task points at a generated .cmd wrapper instead of a raw command line.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = (process.env.HOME ?? process.env.USERPROFILE) ?? homedir();
/** Task Scheduler folder that holds every LifeOS task, so they can be listed as a set. */
export const TASK_FOLDER = "LifeOS";
/** Generated wrappers and PID files live here — regenerable, never hand-edited. */
export const WRAPPER_DIR = join(HOME, ".claude", "LIFEOS", "MEMORY", "STATE", "win-services");

export interface PlistSpec {
  label: string;
  argv: string[];
  startIntervalSec?: number;
  calendarHour?: number;
  calendarMinute?: number;
  runAtLoad: boolean;
  keepAlive: boolean;
  /** launchd re-runs the job when these paths change; Task Scheduler cannot. */
  watchPaths: boolean;
  workingDir?: string;
  logPath?: string;
  env: Record<string, string>;
}

/** Substitute both placeholder dialects the shipped plists use. */
function substitute(xml: string, bun: string): string {
  const bunDir = bun.replace(/[\\/][^\\/]+$/, "");
  return xml
    .split("__BUN_PATH__").join(bun)
    .split("{{BUN_DIR}}").join(bunDir)
    .split("{{BUN}}").join(bun)
    .split("__HOME__").join(HOME.split("\\").join("/"))
    .split("{{HOME}}").join(HOME.split("\\").join("/"))
    // Not every plist uses a placeholder for the interpreter: at least one bakes
    // in a Homebrew path, which is simply not where bun lives on Windows.
    .split("/opt/homebrew/bin/bun").join(bun)
    .split("/usr/local/bin/bun").join(bun);
}

/**
 * Why this service cannot become a Windows task, or null if it can.
 *
 * Translating a plist is not the same as the service being portable: some run a
 * macOS .app bundle, and some carry a placeholder for a component installed from
 * another repo. Both would produce a task that fails silently every time it
 * fires, which is worse than not registering it at all.
 */
export function windowsBlocker(spec: PlistSpec): string | null {
  const runner = spec.argv.join(" ");
  if (/\.app[\\/]Contents[\\/]MacOS[\\/]/.test(runner)) return "macOS .app bundle — no Windows equivalent";
  const placeholder = /\{\{([A-Z_]+)\}\}|__([A-Z_]+)__/.exec(runner);
  if (placeholder) return `unresolved ${placeholder[0]} — its component is not installed`;
  // argv[0] is the interpreter; argv[1] is usually the script (or a bun
  // subcommand such as `run`). Pulse names its script relative to
  // WorkingDirectory, so resolve against that before deciding it is missing.
  const script = spec.argv.slice(1).find(a => /\.(ts|js|sh)$/.test(a));
  if (script) {
    const abs = /^([A-Za-z]:|[\\/])/.test(script)
      ? script
      : join(spec.workingDir ?? HOME, script);
    if (!existsSync(abs)) return `runner not present: ${abs}`;
  }
  return null;
}

function firstMatch(xml: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]*)</(?:string|integer)>`);
  return re.exec(xml)?.[1] ?? null;
}

function boolKey(xml: string, key: string): boolean {
  return new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(xml);
}

/** Parse a launchd plist into the subset of facts Task Scheduler needs. */
export function parsePlist(path: string, bun: string): PlistSpec | null {
  let xml: string;
  try { xml = substitute(readFileSync(path, "utf8"), bun); } catch { return null; }

  const label = firstMatch(xml, "Label");
  if (!label) return null;

  const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "";
  const argv = [...argsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
  if (!argv.length) return null;

  const interval = firstMatch(xml, "StartInterval");
  const cal = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1] ?? "";
  const calHour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(cal)?.[1];
  const calMin = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(cal)?.[1];

  // EnvironmentVariables is a flat <key>/<string> dict; PATH is rewritten for
  // Windows below, since the plist value is a POSIX colon-joined list.
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1] ?? "";
  const env: Record<string, string> = {};
  for (const m of envBlock.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) env[m[1]] = m[2];

  return {
    label,
    argv,
    startIntervalSec: interval ? Number(interval) : undefined,
    calendarHour: calHour ? Number(calHour) : undefined,
    calendarMinute: calMin ? Number(calMin) : undefined,
    runAtLoad: boolKey(xml, "RunAtLoad"),
    keepAlive: boolKey(xml, "KeepAlive"),
    watchPaths: /<key>WatchPaths<\/key>/.test(xml),
    workingDir: firstMatch(xml, "WorkingDirectory") ?? undefined,
    logPath: firstMatch(xml, "StandardOutPath") ?? undefined,
    env,
  };
}

const win = (p: string) => p.split("/").join("\\");

/**
 * Write the .cmd the scheduled task actually runs. KeepAlive services get a PID
 * guard so the 5-minute repetition restarts a dead daemon without ever starting
 * a second copy of a healthy one.
 */
export function writeWrapper(spec: PlistSpec, bunDir: string): string {
  mkdirSync(WRAPPER_DIR, { recursive: true });
  const wrapper = join(WRAPPER_DIR, `${spec.label}.cmd`);
  const pidFile = join(WRAPPER_DIR, `${spec.label}.pid`);
  const log = spec.logPath ? win(spec.logPath) : join(WRAPPER_DIR, `${spec.label}.log`);
  mkdirSync(log.replace(/\\[^\\]+$/, ""), { recursive: true });

  const lines = ["@echo off", "setlocal"];
  lines.push(`set "HOME=${win(HOME)}"`);
  lines.push(`set "USERPROFILE=${win(HOME)}"`);
  lines.push(`set "PATH=${win(bunDir)};%PATH%"`);
  for (const [k, v] of Object.entries(spec.env)) {
    if (k === "PATH" || k === "HOME") continue; // set above, in Windows form
    lines.push(`set "${k}=${v}"`);
  }
  if (spec.workingDir) lines.push(`cd /d "${win(spec.workingDir)}"`);

  if (spec.keepAlive) {
    // Already running? Then this repetition tick has nothing to do.
    //
    // This guard used to read the PID file inside an `if exist (...)` block and
    // test %_pid% in the same block. cmd.exe expands the whole block at parse
    // time, so %_pid% was always empty and the guard never fired: every
    // 5-minute tick launched another copy, and dozens of orphaned daemons piled
    // up (all of them then fighting over the same redirected log file).
    // Matching on the live command line instead of a PID file also survives a
    // reboot handing the recorded PID to some unrelated process.
    const scriptArg = spec.argv.slice(1).find(a => /\.(ts|js|sh)$/.test(a)) ?? spec.argv[spec.argv.length - 1];
    const token = (scriptArg.split(/[\\/]/).pop() ?? scriptArg).split("'").join("''");
    const exe = (win(spec.argv[0]).split("\\").pop() ?? "bun.exe").split("'").join("''");
    // Exit 9 means "already running"; anything else (including a PowerShell
    // failure) falls through to the launch, so the daemon can never be kept
    // down by a broken probe.
    lines.push(
      `powershell -NoProfile -Command "$n = @(Get-CimInstance Win32_Process | ` +
      `Where-Object { $_.Name -eq '${exe}' -and $_.CommandLine -like '*${token}*' }).Count; ` +
      `if ($n -gt 0) { exit 9 } else { exit 0 }"`,
      `if errorlevel 9 if not errorlevel 10 exit /b 0`,
    );
  }

  const cmd = spec.argv.map(a => `"${win(a)}"`).join(" ");
  if (spec.keepAlive) {
    // Record the PID so the guard above can see this instance next tick.
    lines.push(
      `powershell -NoProfile -Command "$p = Start-Process -FilePath '${win(spec.argv[0])}' ` +
      `-ArgumentList @(${spec.argv.slice(1).map(a => `'${win(a)}'`).join(",")}) ` +
      `-RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err' ` +
      `-WindowStyle Hidden -PassThru; $p.Id | Set-Content '${pidFile}'"`,
    );
  } else {
    lines.push(`${cmd} >> "${log}" 2>&1`);
  }
  lines.push("endlocal");

  writeFileSync(wrapper, lines.join("\r\n") + "\r\n");
  return wrapper;
}

/** The schtasks schedule flags this service's cadence implies. */
export function scheduleArgs(spec: PlistSpec): string[] {
  // schtasks rejects /RI and /DU outright for ONLOGON, so a repeating logon
  // trigger is not expressible. MINUTE /MO 5 covers both jobs instead: it starts
  // the service shortly after logon and re-checks it every 5 minutes. The
  // wrapper's PID guard is what stops that from launching a second copy.
  if (spec.keepAlive) return ["/SC", "MINUTE", "/MO", "5"];
  // WatchPaths has no Task Scheduler equivalent; polling is the honest
  // approximation, and cadenceOfSpec() labels it as polled rather than watched.
  if (spec.watchPaths && !spec.startIntervalSec) return ["/SC", "MINUTE", "/MO", "5"];
  if (spec.startIntervalSec) {
    const mins = Math.max(1, Math.round(spec.startIntervalSec / 60));
    return mins >= 1440
      ? ["/SC", "DAILY"]
      : ["/SC", "MINUTE", "/MO", String(mins)];
  }
  if (spec.calendarHour !== undefined) {
    const hh = String(spec.calendarHour).padStart(2, "0");
    const mm = String(spec.calendarMinute ?? 0).padStart(2, "0");
    return ["/SC", "DAILY", "/ST", `${hh}:${mm}`];
  }
  return ["/SC", "ONLOGON"];
}

export const taskName = (label: string) => `\\${TASK_FOLDER}\\${label}`;

function schtasks(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["schtasks", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}

/** Labels that currently have a task registered under the LifeOS folder. */
export function registeredLabels(): Set<string> {
  const r = schtasks(["/Query", "/FO", "CSV", "/NH"]);
  const out = new Set<string>();
  if (r.code !== 0) return out;
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^"\\LifeOS\\([^"]+)"/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return out;
}

export function installTask(spec: PlistSpec, bunDir: string): { code: number; out: string } {
  const wrapper = writeWrapper(spec, bunDir);
  return schtasks([
    "/Create", "/F",
    "/TN", taskName(spec.label),
    "/TR", `"${wrapper}"`,
    ...scheduleArgs(spec),
  ]);
}

export function uninstallTask(label: string): { code: number; out: string } {
  return schtasks(["/Delete", "/F", "/TN", taskName(label)]);
}

export function runTaskNow(label: string): { code: number; out: string } {
  return schtasks(["/Run", "/TN", taskName(label)]);
}

/** Human-readable cadence for the status table, from the same plist facts. */
export function cadenceOfSpec(spec: PlistSpec): string {
  if (spec.keepAlive) return "always (5m check)";
  if (spec.watchPaths && !spec.startIntervalSec) return "every 5m (polled)";
  if (spec.startIntervalSec) {
    const s = spec.startIntervalSec;
    return s % 3600 === 0 ? `every ${s / 3600}h` : `every ${Math.round(s / 60)}m`;
  }
  if (spec.calendarHour !== undefined) return "daily/scheduled";
  if (spec.runAtLoad) return "at logon";
  return "—";
}

export const wrapperExists = (label: string) => existsSync(join(WRAPPER_DIR, `${label}.cmd`));
