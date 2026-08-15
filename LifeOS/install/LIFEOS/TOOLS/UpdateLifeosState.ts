#!/usr/bin/env bun
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, (process.env.HOME ?? process.env.USERPROFILE) ?? "~");
}

/**
 * UpdateLifeosState — Writes LIFEOS_STATE.json with per-dimension pct scores read by
 * the statusline (LIFEOS/LIFEOS_StatusLine.sh) STATE strip and the Pulse TELOS
 * dashboard rings.
 *
 * Pct semantics:
 *   - If `CURRENT_STATE/<DIM>.md` exists with `status: have|partial|missing`
 *     rows, pct = (have + 0.5 × partial) / total × 100 — real coverage.
 *   - Else falls back to IDEAL_STATE articulation completeness:
 *     `100 - (TBD markers × 10)`, clamped 0..100.
 *
 * The fallback measures whether the principal has articulated what "good"
 * looks like; the primary path measures whether reality matches it.
 *
 * Scope:
 *   `[telos] dimensions` in LIFEOS_CONFIG.toml narrows which dimensions this
 *   install tracks. Omit the key to track all seven — the template default.
 *   Anything left out reports `pct: null` + `scope: "out"`, so the statusline
 *   and Pulse render "no signal" instead of a 0% that reads as a real score.
 *   A dimension the install does not measure is not a dimension scoring zero.
 *
 * Reads:  LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml (scope, optional)
 *         LIFEOS/USER/TELOS/IDEAL_STATE/<DIM>.md (target articulation)
 *         LIFEOS/USER/TELOS/CURRENT_STATE/<DIM>.md (actual coverage, when present)
 * Writes: LIFEOS/USER/TELOS/LIFEOS_STATE.json
 *
 * Template-style: works on any user's LifeOS install — no hardcoded paths,
 * no {{PRINCIPAL_NAME}}-specific names. Fresh installs land all dimensions at 0 until the
 * principal runs the IDEAL_STATE interview.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/UpdateLifeosState.ts
 *   bun ~/.claude/LIFEOS/TOOLS/UpdateLifeosState.ts --json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { loadLifeosConfig } from "./LifeosConfig";
import { homedir } from "node:os";

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, (process.env.HOME ?? process.env.USERPROFILE) ?? "~");
}


const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LIFEOS_DIR = process.env.LIFEOS_DIR || join(HOME, ".claude", "LIFEOS");
const IDEAL_DIR = join(LIFEOS_DIR, "USER", "TELOS", "IDEAL_STATE");
const CURRENT_DIR = join(LIFEOS_DIR, "USER", "TELOS", "CURRENT_STATE");
const STATE_FILE = join(LIFEOS_DIR, "USER", "TELOS", "LIFEOS_STATE.json");

const DIMENSIONS = [
  { id: "health",         file: "HEALTH.md" },
  { id: "money",          file: "MONEY.md" },
  { id: "freedom",        file: "FREEDOM.md" },
  { id: "creative",       file: "CREATIVE.md" },
  { id: "relationships",  file: "RELATIONSHIPS.md" },
  { id: "rhythms",        file: "RHYTHMS.md" },
  { id: "infrastructure", file: "INFRASTRUCTURE.md" },
] as const;

type DimensionId = (typeof DIMENSIONS)[number]["id"];

interface DimensionState {
  pct: number | null;
  tbd_count: number;
  last_updated: string | null;
  source_file: string;
  /** "out" = this install does not track the dimension; pct is null by scope, not by absence of data. */
  scope: "in" | "out";
}

/**
 * Dimensions this install tracks. Missing or unreadable config means all of
 * them — a fresh install with no config must still produce a full state file.
 * An id that is not a real dimension is a typo that would silently zero a
 * dimension, so it fails loud rather than being ignored.
 */
function activeDimensionIds(): Set<DimensionId> {
  const all = new Set(DIMENSIONS.map((d) => d.id));
  let configured: string[] | undefined;
  try {
    configured = loadLifeosConfig().telos.dimensions;
  } catch {
    return all;
  }
  if (!configured) return all;

  const unknown = configured.filter((id) => !all.has(id as DimensionId));
  if (unknown.length > 0) {
    throw new Error(
      `[UpdateLifeosState] [telos] dimensions names unknown dimension(s): ${unknown.join(", ")}. ` +
        `Valid ids: ${[...all].join(", ")}.`,
    );
  }
  return new Set(configured as DimensionId[]);
}

interface LifeosState {
  generated_at: string;
  dimensions: Record<DimensionId, DimensionState>;
}

function readFrontmatterDate(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = content.slice(3, end);
  const m = fm.match(/^last_updated:\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

type DimensionScore = Omit<DimensionState, "scope">;

function computeFromCurrent(file: string): DimensionScore | null {
  const path = join(CURRENT_DIR, file);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const have    = (content.match(/\bstatus:\s*have\b/g)    || []).length;
  const partial = (content.match(/\bstatus:\s*partial\b/g) || []).length;
  const missing = (content.match(/\bstatus:\s*missing\b/g) || []).length;
  // Fail loud on unrecognized status keywords (public issue #1509): a synonym
  // like `status: populated` used to silently count as nothing, so a fully
  // populated file computed as 0% coverage with no signal anything was wrong.
  const RECOGNIZED = new Set(["have", "partial", "missing"]);
  const unrecognized = [...content.matchAll(/\bstatus:\s*([A-Za-z][\w-]*)/g)]
    .map((m) => m[1]!.toLowerCase())
    .filter((kw) => !RECOGNIZED.has(kw));
  if (unrecognized.length > 0) {
    const uniq = [...new Set(unrecognized)].join(", ");
    process.stderr.write(
      `[UpdateLifeosState] WARNING: ${file} has ${unrecognized.length} unrecognized status keyword(s) (${uniq}) — ` +
      `only have/partial/missing count toward coverage, so the reported percentage is wrong until fixed.\n`,
    );
  }
  const total = have + partial + missing;
  if (total === 0) return null;
  const pct = Math.round(((have + 0.5 * partial) / total) * 100);
  return {
    pct,
    tbd_count: missing,
    last_updated: readFrontmatterDate(content),
    source_file: `CURRENT_STATE/${file}`,
  };
}

function computeFromIdeal(file: string): DimensionScore {
  const path = join(IDEAL_DIR, file);
  if (!existsSync(path)) {
    return { pct: null, tbd_count: 0, last_updated: null, source_file: file };
  }
  const content = readFileSync(path, "utf-8");
  const tbd_count = (content.match(/\bTBD\b/g) || []).length;
  const pct = Math.max(0, Math.min(100, 100 - tbd_count * 10));
  return {
    pct,
    tbd_count,
    last_updated: readFrontmatterDate(content),
    source_file: `IDEAL_STATE/${file}`,
  };
}

function computeState(file: string): DimensionState {
  return { ...(computeFromCurrent(file) ?? computeFromIdeal(file)), scope: "in" };
}

// An out-of-scope dimension is reported, not omitted: consumers keep a stable
// key set, and `pct: null` is the value they already render as "no signal".
function outOfScopeState(file: string): DimensionState {
  return { pct: null, tbd_count: 0, last_updated: null, source_file: file, scope: "out" };
}

function build(): LifeosState {
  const active = activeDimensionIds();
  const dimensions = {} as Record<DimensionId, DimensionState>;
  for (const d of DIMENSIONS) {
    dimensions[d.id] = active.has(d.id) ? computeState(d.file) : outOfScopeState(d.file);
  }
  return {
    generated_at: new Date().toISOString(),
    dimensions,
  };
}

function main(): void {
  const state = build();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log(`LIFEOS_STATE.json updated: ${STATE_FILE}`);
    for (const d of DIMENSIONS) {
      const s = state.dimensions[d.id];
      const pctStr = s.pct === null ? "—" : `${s.pct}%`;
      const detail =
        s.scope === "out"
          ? "not tracked — [telos] dimensions"
          : `${s.tbd_count} TBDs, updated ${s.last_updated ?? "unknown"}`;
      console.log(`  ${d.id.padEnd(14)} ${pctStr.padStart(5)}  (${detail})`);
    }
  }
}

main();
