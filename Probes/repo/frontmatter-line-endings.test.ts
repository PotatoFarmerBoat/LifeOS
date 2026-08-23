/**
 * Frontmatter line endings — a project file saved on Windows must still parse.
 *
 * The reader anchored on `^---\n`. Editors on Windows save `\r\n`, so the match
 * failed and parseFrontmatter returned null. Every caller reads null as "this is
 * not a project file" and returns early, so the run never synced to work.json,
 * never coloured a tab and never printed a progress line. Nothing errored and
 * nothing logged. On the machine where this was found, 4 of 7 ISAs were absent
 * from every surface and had been for weeks.
 *
 * A leading UTF-8 byte order mark defeats the same anchor the same way, and is
 * equally invisible in an editor.
 *
 * The static sweep matters as much as the behavioural test: the same LF-only
 * anchor was copied into about forty other readers across TOOLS, PULSE, HERMES
 * and hooks, so fixing one reader fixes one symptom.
 *
 * Runs on any OS.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseFrontmatter, parseCriteriaList, countCriteria } from "../../LifeOS/install/hooks/lib/isa-utils";

const REPO = resolve(import.meta.dir, "..", "..");
const PAYLOAD = join(REPO, "LifeOS", "install");
const BOM = "﻿";

const HEADER = [
  "---",
  "slug: line-ending-probe",
  "title: A project saved by a Windows editor",
  "phase: build",
  "progress: 1/2",
  "---",
  "",
  "## Features",
  "- [x] C1: The first claim is closed.",
  "- [ ] C2: The second claim is open.",
  "",
];
const lf = HEADER.join("\n");
const crlf = HEADER.join("\r\n");

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const p = join(root, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".mts")) out.push(p);
  }
  return out;
}

describe("frontmatter survives the invisible characters editors add", () => {
  test("Unix line endings parse", () => {
    const fm = parseFrontmatter(lf);
    expect(fm).not.toBeNull();
    expect(fm!.slug).toBe("line-ending-probe");
    expect(fm!.progress).toBe("1/2");
  });

  test("Windows line endings parse", () => {
    const fm = parseFrontmatter(crlf);
    expect(fm).not.toBeNull();
    expect(fm!.slug).toBe("line-ending-probe");
    expect(fm!.phase).toBe("build");
    expect(fm!.progress).toBe("1/2");
  });

  test("no carriage return leaks into a parsed key or value", () => {
    const fm = parseFrontmatter(crlf)!;
    for (const [k, v] of Object.entries(fm)) {
      expect(k).not.toContain("\r");
      expect(v).not.toContain("\r");
    }
  });

  test("a byte order mark does not hide the header", () => {
    for (const body of [BOM + lf, BOM + crlf]) {
      const fm = parseFrontmatter(body);
      expect(fm).not.toBeNull();
      expect(fm!.slug).toBe("line-ending-probe");
    }
  });

  test("claims are found and counted the same either way", () => {
    for (const body of [lf, crlf, BOM + crlf]) {
      expect(parseCriteriaList(body).map((c) => c.id)).toEqual(["C1", "C2"]);
      expect(countCriteria(body)).toEqual({ checked: 1, total: 2 });
    }
  });

  test("a file with no header is still rejected", () => {
    expect(parseFrontmatter("# just a heading\n")).toBeNull();
    expect(parseFrontmatter(BOM + "not a project file")).toBeNull();
  });
});

describe("no reader in the payload still assumes Unix line endings", () => {
  test("the LF-only frontmatter anchor appears nowhere", () => {
    // `/^---\n` and `/^(---\n`. Widening to `\r?\n` cannot change how an LF
    // file matches, so there is never a reason to keep the narrow form.
    const offenders: string[] = [];
    for (const file of walk(PAYLOAD)) {
      const src = readFileSync(file, "utf-8");
      for (const lit of src.match(/\/\^\(?---[^/\n]*\//g) ?? []) {
        if (/(?<!\\r\?)\\n/.test(lit)) offenders.push(relative(REPO, file) + "  " + lit);
      }
    }
    expect(offenders).toEqual([]);
  });
});
