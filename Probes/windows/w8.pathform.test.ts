/**
 * W8 — path-form hygiene (#1119 class). Every '/'-built comparison in the hook
 * layer must hold when inputs arrive in win32 backslash form. Runs on any OS —
 * the backslash inputs are literals, so these guard macOS/Linux CI too.
 *
 * ISASync itself is covered behaviorally (A/B via PostToolUse envelope:
 * old guard 0 writes, fixed guard work.json + work-events.jsonl — 2026-08-09).
 */
import { describe, expect, test } from "bun:test";

const HOME_WIN = "C:\\Users\\probe";
process.env.HOME = HOME_WIN;
process.env.USERPROFILE = HOME_WIN;
process.env.CLAUDE_CONFIG_DIR = `${HOME_WIN}\\.claude`;

const surfaces = await import("../../LifeOS/install/hooks/lib/system-surfaces");
const subagent = await import("../../LifeOS/install/hooks/lib/subagent");
const changes = await import("../../LifeOS/install/hooks/lib/change-detection");

describe("system-surfaces.classifySurface", () => {
  test("backslashed CLAUDE.md classifies as doctrine", () => {
    const s = surfaces.classifySurface(
      "C:\\Users\\probe\\.claude\\CLAUDE.md",
      "C:\\Users\\probe\\.claude",
    );
    expect(s?.tier).toBe("doctrine");
  });
  test("backslashed memory tree returns null (autonomic line)", () => {
    const s = surfaces.classifySurface(
      "C:\\Users\\probe\\.claude\\LIFEOS\\MEMORY\\STATE\\work.json",
      "C:\\Users\\probe\\.claude",
    );
    expect(s).toBeNull();
  });
});

describe("subagent.isSubagentContext", () => {
  test("backslashed CLAUDE_PROJECT_DIR under .claude\\Agents detects", () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "C:\\Users\\probe\\.claude\\Agents\\researcher";
    try {
      expect(subagent.isSubagentContext()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });
});

describe("change-detection.categorizeChange", () => {
  test("backslashed hook path categorizes as hook", () => {
    expect(changes.categorizeChange("C:\\Users\\probe\\.claude\\hooks\\Safety.hook.ts")).toBe("hook");
  });
  test("backslashed MEMORY path categorizes as memory-system", () => {
    expect(changes.categorizeChange("C:\\Users\\probe\\.claude\\LIFEOS\\MEMORY\\notes.md")).toBe("memory-system");
  });
});
