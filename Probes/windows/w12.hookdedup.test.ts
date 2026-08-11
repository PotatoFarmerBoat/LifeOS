/**
 * W12 — InstallHooks must stay idempotent on Windows.
 *
 * portHooksForWindows rewrites each payload command into `"<abs bun>" "<abs script>"`
 * before mergeHooks runs. If normalizeCommand does not fold that spelling back to the
 * `$HOME/.claude/...` form already sitting in settings.json, every entry keys
 * differently, dedup misses, and a second InstallHooks run appends a duplicate of the
 * whole hook set — each hook then fires twice per event.
 *
 * Caught on a live Windows install: dry run reported added=52 skipped=0 against a
 * settings.json that already held 48 working LifeOS hooks.
 */
import { describe, expect, test } from "bun:test";
import { mergeHooks } from "../../LifeOS/Tools/InstallEngine";

const HOME = (process.env.HOME ?? process.env.USERPROFILE ?? "").split("\\").join("/").replace(/\/+$/, "");

const posix = (cmd: string) => ({ PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd }] }] });

describe("mergeHooks dedup across POSIX and Windows-ported spellings", () => {
  test("pinned interpreter + absolute root dedupes against the $HOME form", () => {
    const existing = posix("$HOME/.claude/hooks/Safety.hook.ts");
    const incoming = posix(`"C:/Users/x/.bun/bin/bun.exe" "${HOME}/.claude/hooks/Safety.hook.ts"`);
    const { added, skipped } = mergeHooks(existing as never, incoming as never);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  test("bare `bun` prefix dedupes against the pinned form", () => {
    const existing = posix("bun $HOME/.claude/hooks/HookHealer.hook.ts");
    const incoming = posix(`"C:/Users/x/.bun/bin/bun.exe" "${HOME}/.claude/hooks/HookHealer.hook.ts"`);
    const { added, skipped } = mergeHooks(existing as never, incoming as never);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  test("bash hooks dedupe across the Git Bash pin", () => {
    const existing = posix("$HOME/.claude/hooks/Statusline.sh");
    const incoming = posix(`"C:/Program Files/Git/bin/bash.exe" "${HOME}/.claude/hooks/Statusline.sh"`);
    const { added, skipped } = mergeHooks(existing as never, incoming as never);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  test("arguments still distinguish otherwise-identical scripts", () => {
    const existing = posix("bun $HOME/.claude/LIFEOS/TOOLS/FreshnessCache.ts --quiet");
    const incoming = posix(`"C:/bun.exe" "${HOME}/.claude/LIFEOS/TOOLS/FreshnessCache.ts" --verbose`);
    const { added, skipped } = mergeHooks(existing as never, incoming as never);
    expect(added).toBe(1);
    expect(skipped).toBe(0);
  });

  test("a genuinely new hook is still added", () => {
    const existing = posix("$HOME/.claude/hooks/Safety.hook.ts");
    const incoming = posix(`"C:/bun.exe" "${HOME}/.claude/hooks/BrandNew.hook.ts"`);
    const { added, skipped } = mergeHooks(existing as never, incoming as never);
    expect(added).toBe(1);
    expect(skipped).toBe(0);
  });

  test("`bunx` is not mistaken for a `bun` interpreter prefix", () => {
    const existing = posix("bunx some-tool $HOME/.claude/hooks/X.hook.ts");
    const incoming = posix("bunx some-tool $HOME/.claude/hooks/X.hook.ts");
    const { added, skipped } = mergeHooks(existing as never, incoming as never);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });
});
