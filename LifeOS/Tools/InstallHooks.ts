#!/usr/bin/env bun
/**
 * InstallHooks — Setup step 7 (trust-gated). Additively merges the payload's
 * `install/hooks/hooks.json` into the harness `settings.json`: per matcher
 * bucket, idempotent by normalized command (and url for http entries), never
 * touching foreign entries. Backs up settings.json before writing. REFUSES on a
 * dev tree (the author's live source) unless --allow-dev.
 *
 * The skill's Setup workflow shows the user the exact change (from the dry-run
 * counts) and gets explicit permission BEFORE calling this with --apply.
 *
 * Usage:
 *   bun InstallHooks.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev]
 *   (dry-run by default — reports added/skipped without writing)
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectDevTree, mergeHooks } from "./InstallEngine";
import { atomicWriteText } from "./lib/atomic-write";
// Hook commands must not depend on the launcher's PATH. Claude Code runs from
// several hosts on Windows — the CLI, the VS Code extension, and the MSIX-packaged
// desktop app — and a bare `bun` resolves only if that host happened to inherit
// ~/.bun/bin. Both resolvers live in ./lib/windows-interp so DeployComponents can
// wire the statusline through exactly the same interpreter this file gives hooks.
import { resolveBash, resolveBun } from "./lib/windows-interp";

/**
 * Windows portability pass over the payload hook commands.
 *
 * hooks.json ships POSIX invocations — `$HOME/.claude/hooks/X.hook.ts` — which
 * rely on the shell to expand $HOME and on the `#!/usr/bin/env bun` shebang to
 * select an interpreter. Windows does neither: cmd.exe leaves `$HOME` literal
 * and cannot execute a .ts file directly, so every hook fails at spawn and the
 * whole enforcement layer is silently dead on a Windows install. Rewrite each
 * command to an explicit `<interpreter> "<absolute path>"` form.
 *
 * Also splits `;`-chained commands into separate entries: cmd.exe does not treat
 * `;` as a command separator, so a chain runs only its first segment (with the
 * remainder mangled into its arguments).
 */
function portCommandForWindows(command: string): string[] {
  const home = homedir().split("\\").join("/");
  const out: string[] = [];
  for (const raw of command.split(";")) {
    let c = raw.trim();
    if (!c) continue;
    let interp: string | null = null;
    const m = /^(bun|bash|sh|node)\s+/.exec(c);
    if (m) {
      interp = m[1] === "sh" ? "bash" : m[1];
      c = c.slice(m[0].length).trim();
    }
    if (!c.includes("$HOME")) { out.push(raw.trim()); continue; }
    c = c.replace(/\$HOME/g, home);
    const sp = c.indexOf(" ");
    const script = sp === -1 ? c : c.slice(0, sp);
    const args = sp === -1 ? "" : c.slice(sp + 1).trim();
    if (!interp) interp = script.endsWith(".sh") ? "bash" : "bun";
    if (interp === "bash") interp = resolveBash();
    else if (interp === "bun") interp = resolveBun();
    out.push(`${interp} "${script}"${args ? " " + args : ""}`);
  }
  return out.length ? out : [command];
}

function portHooksForWindows(hooks: Record<string, unknown>): Record<string, unknown> {
  if (process.platform !== "win32") return hooks;
  for (const matchers of Object.values(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const group of matchers) {
      const entries = (group as { hooks?: unknown[] })?.hooks;
      if (!Array.isArray(entries)) continue;
      const next: unknown[] = [];
      for (const entry of entries) {
        const cmd = (entry as { command?: unknown })?.command;
        if (typeof cmd !== "string") { next.push(entry); continue; }
        for (const ported of portCommandForWindows(cmd)) {
          next.push({ ...(entry as object), command: ported });
        }
      }
      (group as { hooks?: unknown[] }).hooks = next;
    }
  }
  return hooks;
}


interface Args { configRoot: string; skillRoot: string; apply: boolean; allowDev: boolean; omits: string[]; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  // USERPROFILE fallback: Windows does not set HOME, so a bare process.env.HOME
  // resolved the config root to a bare ".claude" relative path.
  const home = (process.env.HOME ?? process.env.USERPROFILE) || "";
  // --omit <substring> (repeatable): drop payload entries whose command/url
  // contains the substring BEFORE merging — e.g. --omit MergeSettings.ts keeps
  // settings.json ownership with the user on installs where settings.json
  // predates LifeOS; --omit 31337 skips the Pulse http guards on machines that
  // will not run the Pulse server (windows-port install hardening).
  const omits: string[] = [];
  a.forEach((v, i) => { if (v === "--omit" && a[i + 1] && !a[i + 1].startsWith("--")) omits.push(a[i + 1]); });
  return {
    configRoot: get("--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    skillRoot: get("--skill-root") || join(import.meta.dir, ".."),
    apply: a.includes("--apply"),
    allowDev: a.includes("--allow-dev"),
    omits,
  };
}

function countFilesRec(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) n += countFilesRec(p);
    else n += 1;
  }
  return n;
}

function main(): void {
  const { configRoot, skillRoot, apply, allowDev, omits } = parseArgs();

  if (detectDevTree(configRoot) && !allowDev) {
    console.log(JSON.stringify({ ok: false, refused: "dev-tree", detail: `${configRoot} is a LifeOS source tree (dev-tree marker present) — refusing to mutate. Use --allow-dev only in a sandbox.` }, null, 2));
    process.exit(2);
  }

  const hooksJsonPath = join(skillRoot, "install", "hooks", "hooks.json");
  if (!existsSync(hooksJsonPath)) {
    console.log(JSON.stringify({ ok: false, error: `payload hooks.json not found at ${hooksJsonPath}` }, null, 2));
    process.exit(1);
  }
  const incoming = portHooksForWindows(JSON.parse(readFileSync(hooksJsonPath, "utf-8"))?.hooks ?? {});

  // Apply --omit filters to the payload before the merge sees it. Buckets that
  // empty out are dropped whole; the count is reported so a dry run shows
  // exactly what an omit costs.
  let omitted = 0;
  if (omits.length) {
    for (const event of Object.keys(incoming)) {
      const buckets = incoming[event] as Array<{ hooks?: Array<{ command?: string; url?: string }> }>;
      for (const bucket of buckets) {
        if (!bucket.hooks) continue;
        const before = bucket.hooks.length;
        bucket.hooks = bucket.hooks.filter(
          (h) => !omits.some((o) => (h.command ?? h.url ?? "").includes(o)),
        );
        omitted += before - bucket.hooks.length;
      }
      incoming[event] = buckets.filter((b) => (b.hooks?.length ?? 0) > 0);
      if (!incoming[event].length) delete incoming[event];
    }
  }

  // The hook SCRIPTS (*.hook.ts|sh + lib/**) live beside hooks.json in the payload.
  // Merging hooks.json into settings.json wires commands that point at these files,
  // so they MUST be copied onto disk too — else every hook resolves to a nonexistent
  // file (audit 20260702, RC2). Kept atomic with the settings merge (same opt-in +
  // trust-gate): decline hooks → neither scripts nor settings entries land.
  const hooksPayloadDir = join(skillRoot, "install", "hooks");
  const hooksDestDir = join(configRoot, "hooks");
  const hookFiles = countFilesRec(hooksPayloadDir);

  const settingsPath = join(configRoot, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  const existingHooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, never>;

  const { merged, added, skipped } = mergeHooks(existingHooks as never, incoming);

  const report = { ok: true, apply, settingsPath, added, skipped, omitted, events: Object.keys(merged).length, hooksDestDir, hookFiles };

  if (!apply) {
    console.log(JSON.stringify({ ...report, dryRun: true, note: "no changes written; re-run with --apply after permission" }, null, 2));
    process.exit(0);
  }

  // Back up settings.json before writing (only if it exists).
  let backup: string | undefined;
  if (existsSync(settingsPath)) {
    backup = `${settingsPath}.lifeos-backup-${Date.now()}`;
    copyFileSync(settingsPath, backup);
  }
  settings.hooks = merged;
  // Atomic — a kill mid-write would leave the user with no settings.json at all
  // (public PR #1643, @elhoim)
  atomicWriteText(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // Deploy the hook scripts next to the merged settings (RC2): recursive copy of
  // the whole payload hooks/ tree (*.hook.ts|sh + lib/**) into <configRoot>/hooks/.
  // ADDITIVE, never clobbering (public issue #1491, @donovan-sec): `force: false`
  // skips any file that already exists on disk — a pre-existing user hook with a
  // colliding name is theirs, not ours. cpSync's default (force: true) silently
  // overwrote every collision, contradicting the documented contract.
  mkdirSync(hooksDestDir, { recursive: true });
  const preExisting = countFilesRec(hooksDestDir);
  cpSync(hooksPayloadDir, hooksDestDir, { recursive: true, force: false, errorOnExist: false });
  const hookFilesCopied = countFilesRec(hooksDestDir) - preExisting;
  const skippedExisting = hookFiles - hookFilesCopied;

  // Copying hook scripts and merging the manifest are two independent operations;
  // a hook can land on disk without any settings entry naming it. Ask the shipped
  // reconciler whether every copied hook is actually reachable, so an unwired hook
  // is loud at install time rather than silent until someone runs Doctor by hand.
  // (public PR #1540 + issue #1539, @tzioup)
  const doctorPath = join(configRoot, "LIFEOS", "TOOLS", "Doctor.ts");
  let unwired: string[] | undefined;
  let reconcile: string | undefined;
  if (existsSync(doctorPath)) {
    try {
      const out = execFileSync("bun", [doctorPath, "--reconcile"], {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      });
      unwired = JSON.parse(out).unwired ?? [];
    } catch (err) {
      reconcile = `reconciler failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    reconcile = `Doctor.ts not found at ${doctorPath} — hooks copied but not reconciled`;
  }

  console.log(JSON.stringify({ ...report, written: true, backup, hookFilesCopied, skippedExisting, unwired, reconcile }, null, 2));
  process.exit(0);
}

main();
