/**
 * Doctrine loading — a rule that reaches no session is not a rule.
 *
 * The constitutional layer was attached only by `LIFEOS/TOOLS/lifeos.ts`, which
 * passes --append-system-prompt-file. That covers sessions started by the
 * `lifeos` command and nothing else. Where `lifeos` is not on PATH, and in any
 * client that cannot take a launch flag, the file reached no session at all.
 *
 * The failure is silent by construction. A session with no rules and a session
 * whose rules happen to permit what it did look identical from the outside, so
 * nothing anywhere could report it. It was found by asking a fresh session to
 * name a rule and watching it fail, weeks after the fact.
 *
 * The fix is an `@`-import in CLAUDE.template.md, which every session reads.
 * The general assertion below is the valuable one: every `@`-import must point
 * at a file the payload actually ships. A typo fails the same silent way.
 *
 * Runs on any OS.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const PAYLOAD = join(REPO, "LifeOS", "install");
const TEMPLATE = join(PAYLOAD, "CLAUDE.template.md");
const DOCTRINE = "LIFEOS/LIFEOS_SYSTEM_PROMPT.md";

/** Active imports only. A commented line is a setup step, not a load. */
const imports = (): string[] =>
  readFileSync(TEMPLATE, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("@"))
    .map((l) => l.slice(1).trim());

describe("the rules reach every session, not just launcher sessions", () => {
  test("CLAUDE.template.md imports the constitutional layer", () => {
    expect(imports()).toContain(DOCTRINE);
  });

  test("every active import points at a file the payload ships", () => {
    const missing = imports().filter((rel) => !existsSync(join(PAYLOAD, rel)));
    expect(missing).toEqual([]);
  });

  test("no import is listed twice", () => {
    const all = imports();
    expect(all.length).toBe(new Set(all).size);
  });

  test("the constitutional layer still carries its five numbered rules", () => {
    const text = readFileSync(join(PAYLOAD, DOCTRINE), "utf-8");
    for (const n of ["№1", "№2", "№3", "№4", "№5"]) expect(text).toContain(n);
  });
});

describe("the launcher does not load the same file a second time", () => {
  const launcher = () => readFileSync(join(PAYLOAD, "LIFEOS", "TOOLS", "lifeos.ts"), "utf-8");

  test("it checks the import before passing its own flag", () => {
    const src = launcher();
    expect(src).toContain("export function claudeMdImportsSystemPrompt");
    // Both launch paths, interactive and one-shot, must consult it. Missing one
    // means that path silently loads roughly 7.4k tokens twice.
    const flagSites = src.match(/--append-system-prompt-file/g) ?? [];
    const guardSites = src.match(/claudeMdImportsSystemPrompt\(\)/g) ?? [];
    expect(flagSites.length).toBeGreaterThan(0);
    expect(guardSites.length).toBeGreaterThanOrEqual(flagSites.length);
  });

  test("an explicitly requested system prompt still wins", () => {
    // -s/--system-prompt is the principal naming a file. The guard is for the
    // default only, or the flag becomes impossible to use.
    expect(launcher()).toContain("!options.systemPrompt && claudeMdImportsSystemPrompt()");
  });
});
