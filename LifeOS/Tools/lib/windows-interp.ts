/**
 * windows-interp.ts — resolve the interpreters that settings.json commands need.
 *
 * Windows hosts do not run a `.ts` or `.sh` path directly the way a POSIX shell
 * does, and they may not carry `~/.bun/bin` or Git's `bin` on PATH, so every
 * command written into settings.json has to name its interpreter by absolute
 * path. InstallHooks.ts learned this for hook commands; the statusline needs the
 * identical treatment, so the resolvers live here rather than in either caller.
 *
 * Returned paths are QUOTED and forward-slashed, ready to concatenate into a
 * settings.json command string. Doctor's hook-interpreter check parses that
 * quoting back out, so the two must stay in step.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Quote + normalise a Windows path for embedding in a command string. */
export function quoteCmdPath(p: string): string {
  return `"${p.split("\\").join("/")}"`;
}

/** Absolute bun, preferring the interpreter currently running this installer. */
export function resolveBun(): string {
  const exec = process.execPath;
  if (exec && /bun(\.exe)?$/i.test(exec)) return quoteCmdPath(exec);
  const home = homedir().split("\\").join("/");
  for (const c of [`${home}/.bun/bin/bun.exe`, `${home}/.bun/bin/bun`]) {
    if (existsSync(c)) return quoteCmdPath(c);
  }
  return "bun";
}

/**
 * Absolute bash. On Windows that means Git Bash, which is what ships with the
 * `git` every LifeOS install already requires. On POSIX the bare name is right —
 * bash is on PATH and quoting an absolute path would only add noise to the diff.
 */
export function resolveBash(): string {
  if (process.platform !== "win32") return "bash";
  for (const p of [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    `${homedir().split("\\").join("/")}/AppData/Local/Programs/Git/bin/bash.exe`,
  ]) {
    if (existsSync(p)) return quoteCmdPath(p);
  }
  return "bash"; // last resort — Doctor's hook-interpreter check reports it if absent
}
