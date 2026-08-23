/**
 * Pair-sync — the installer Tools directory exists twice in this repo, and the
 * two copies must stay byte-identical.
 *
 *   LifeOS/Tools/**                        the shipped skill (what a new install gets)
 *   LifeOS/install/skills/LifeOS/Tools/**  the installer payload (what lands in
 *                                          ~/.claude/skills/LifeOS/Tools/)
 *
 * Both are hand-maintained; nothing generates one from the other. When they drift,
 * a fresh install and an already-installed system run different code, and the
 * symptom appears at install time on someone else's machine.
 *
 * This has already happened three times in the PotatoFarmerBoat fork:
 *   7ae10f4c  cross-platform tool detection      touched LifeOS/Tools only
 *   df474bba  --omit flag for InstallHooks       touched LifeOS/Tools only
 *   21fc71fd  Windows statusline + services      touched install/skills only
 *
 * Runs on any OS. Compares bytes, not text, so line-ending drift fails too.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const A = join(REPO, "LifeOS", "Tools");
const B = join(REPO, "LifeOS", "install", "skills", "LifeOS", "Tools");

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) rec(p);
      else if (entry.isFile()) out.push(relative(root, p).replaceAll("\\", "/"));
    }
  };
  rec(root);
  return out.sort();
}

const filesA = walk(A);
const filesB = walk(B);

describe("installer Tools copies stay in sync", () => {
  test("both directories exist and are non-empty", () => {
    expect(existsSync(A)).toBe(true);
    expect(existsSync(B)).toBe(true);
    expect(filesA.length).toBeGreaterThan(0);
  });

  test("neither copy has a file the other lacks", () => {
    const onlyA = filesA.filter((f) => !filesB.includes(f));
    const onlyB = filesB.filter((f) => !filesA.includes(f));
    expect({ onlyInShippedSkill: onlyA, onlyInInstallerPayload: onlyB }).toEqual({
      onlyInShippedSkill: [],
      onlyInInstallerPayload: [],
    });
  });

  test("every shared file is byte-identical", () => {
    const shared = filesA.filter((f) => filesB.includes(f));
    const differing = shared.filter((f) => !readFileSync(join(A, f)).equals(readFileSync(join(B, f))));
    expect(differing).toEqual([]);
  });

  test("no shared file differs in size", () => {
    const shared = filesA.filter((f) => filesB.includes(f));
    const mismatched = shared
      .map((f) => ({ f, a: statSync(join(A, f)).size, b: statSync(join(B, f)).size }))
      .filter((r) => r.a !== r.b)
      .map((r) => `${r.f} (${r.a} vs ${r.b} bytes)`);
    expect(mismatched).toEqual([]);
  });
});
