#!/usr/bin/env bun
/**
 * @version 1.8.0
 * ISASync.hook.ts — ISA → work.json sync via PostToolUse
 *
 * TRIGGER: PostToolUse (Write, Edit, MultiEdit, Read)
 *
 * v4.1.0 (PRD → ISA rename): the per-session artifact is now ISA.md.
 * Sessions created before v4.1.0 still ship a PRD.md; this hook reads either,
 * preferring ISA.md when both exist (legacy behavior — there should never be
 * both for a single session).
 *
 * v6.9.0 (Resume After Complete): Read events on ISA files now bump
 * lastToolActivity via the slug-keyed path so reading a complete ISA
 * registers as a heartbeat for that ISA's slug. Read NEVER writes back to
 * the file — only Write/Edit/MultiEdit do.
 *
 * - Write/Edit/MultiEdit on ISA.md (or legacy PRD.md) → full sync; auto-rewind fires inside syncToWorkJson
 * - Read on ISA.md → bump lastToolActivity on the slug, rebind sessionUUID, debounced
 *
 * v1.6.0 (the strip carries the claim count): on any write whose DERIVED ascent
 * state OR closed-claim count changed for this session, emit a `<lifeos-ascent-delta>` block carrying the
 * exact response-format phase strip, computed from the same deriveAscent()
 * every dashboard surface reads. The model echoes it verbatim and never
 * computes its own — same contract as the 🧠 MEMORY and ⚙️ SYSTEM lines
 * (SystemChangeSurface: "a model-computed status line failed compliance
 * repeatedly in the 2026-05-28 experiment; never go back"). Found 2026-08-11:
 * the response strip said 🧗 Ascending while the board derived 🥾 Traverse,
 * because the strip was the last derived-state line the model self-computed.
 * No ISA write → no block → no strip: an unregistered run can no longer
 * claim a state the board doesn't show.
 */

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import {
  parseFrontmatter,
  syncToWorkJson,
  readRegistry,
  bumpLastToolActivityBySlug,
  parseCriteriaList,
  ARTIFACT_FILENAME,
  LEGACY_ARTIFACT_FILENAME,
} from './lib/isa-utils';
import { setAscentTab } from './lib/tab-setter';
import { deriveAscent, ascentTag } from '../LIFEOS/TOOLS/ascent';
import { isSubagentContext } from './lib/subagent';

let input: any;
try {
  input = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  process.exit(0);
}

const toolInput = input.tool_input || {};
const toolName = (input.tool_name || '') as string;

async function main(): Promise<string | null> {
  // Trigger for ISA.md (or legacy PRD.md) anywhere — the Algorithm sanctions
  // TWO ISA homes (`MEMORY/WORK/{slug}/ISA.md` for tasks, `<project>/ISA.md`
  // for persistent things), but this hook watched only the first, so every
  // project ISA was invisible to work.json and every run surface reading it
  // (public issue #1807, @mhaisham).
  // (The per-tool-call liveness heartbeat lives in EventLogger.hook.ts, which
  // fires on every PostToolUse — one home, 2026-07-15 consolidation.)
  // win32 file_path arrives backslashed — normalize once so every '/'-built
  // pattern below applies; node fs accepts '/' on Windows (windows-port W8, #1119 class).
  const filePath = (toolInput.file_path || '').replaceAll('\\', '/');
  const isISA = filePath.endsWith('/' + ARTIFACT_FILENAME) || filePath.endsWith(ARTIFACT_FILENAME);
  const isLegacyPRD = filePath.endsWith('/' + LEGACY_ARTIFACT_FILENAME) || filePath.endsWith(LEGACY_ARTIFACT_FILENAME);
  if (!isISA && !isLegacyPRD) return null;
  const isWorkISA = filePath.includes('MEMORY/WORK/');

  // v6.9.0: Read trigger — bump heartbeat on the slug, rebind UUID, debounced.
  // No file write-back, no rewind. Read alone never mutates the ISA.
  if (toolName === 'Read') {
    const slugMatch = filePath.match(/MEMORY\/WORK\/([^/]+)\//);
    if (slugMatch) bumpLastToolActivityBySlug(slugMatch[1], input.session_id);
    return null;
  }

  // Use the actual file path that was just written/edited, not findLatestISA()
  // findLatestISA() scans all artifacts by mtime and can return the wrong file
  // when multiple sessions exist or when a file's mtime is bumped by git ops.
  const isaPath = filePath;
  if (!existsSync(isaPath)) return null;

  const content = readFileSync(isaPath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm) return null;

  // The slug IS the directory name — derive it when frontmatter omits it.
  // syncToWorkJson keys the registry by fm.slug and silently no-ops without
  // one, so every minimal/hand-written ISA (sanctioned by Algorithm claim 2)
  // was invisible to the board: tracked runs rendered as "NO ISA" sessions
  // (found 2026-07-22 — both of this session's ISAs never registered).
  if (!fm.slug) {
    if (isWorkISA) {
      const slugFromPath = filePath.match(/MEMORY\/WORK\/([^/]+)\//);
      if (slugFromPath) fm.slug = slugFromPath[1];
    } else {
      // Project ISA (<project>/ISA.md): the slug is the project directory name,
      // prefixed to avoid colliding with a same-named WORK slug
      // (public issue #1807, @mhaisham).
      const dirMatch = filePath.match(/([^/]+)\/[^/]+$/);
      if (dirMatch) fm.slug = 'project-' + dirMatch[1].toLowerCase();
    }
  }

  // Check existing phase before sync to detect phase changes
  const newPhase = (fm.phase || '').toUpperCase();
  let oldPhase = '';
  if (fm.slug) {
    try {
      const registry = readRegistry();
      const existing = registry.sessions[fm.slug];
      if (existing) oldPhase = (existing.phase || '').toUpperCase();
    } catch { /* silent */ }
  }

  // Sync frontmatter + criteria to work.json (pass session_id for session name lookup)
  syncToWorkJson(fm, isaPath, content, input.session_id);

  // Derive the run's state ONCE from what was just written — the same
  // deriveAscent() the board reads — and reuse it for the tab and the strip,
  // so the two cannot disagree by construction.
  const [doneStr, totalStr] = String(fm.progress || '0/0').split('/');
  const done = parseInt(doneStr, 10) || 0;
  const total = parseInt(totalStr, 10) || 0;
  const state = deriveAscent({
    phase: newPhase,
    tracked: true,
    active: true,
    done,
    total,
  });

  // Repaint the tab when the run's declared phase changes.
  //
  // The old gate was an explicit phase allowlist that had to be extended by hand
  // every time the vocabulary moved — and wasn't, twice (2026-07-22, 2026-07-27),
  // so tab colors silently stopped firing mid-run. `deriveAscent` resolves any
  // phase value, current or retired, through the one table; an unknown value
  // falls back to a real state instead of being dropped on the floor.
  if (input.session_id && newPhase !== oldPhase) {
    try {
      setAscentTab(state, input.session_id);
    } catch (err) {
      console.error('[ISASync] setAscentTab failed:', err);
    }
  }

  // v1.6.0: hook-fed phase strip (see header). Fires on every DERIVED-state
  // OR claim-count change — not per phase change, so progress reaching n/n emits
  // 🪨 Cairn without a phase edit, and each claim closed moves a visible bar. Per-session dedupe file; subagents never emit (their
  // ISA edits would strip-spam their own contexts, which helps nobody).
  let stripDelta: string | null = null;
  if (input.session_id && fm.slug && !isSubagentContext()) {
    try {
      const stripDir = join(homedir(), '.claude/LIFEOS/MEMORY/STATE/ascent-strip');
      const stripFile = join(stripDir, `${String(input.session_id).replace(/[^\w-]/g, '')}.json`);
      let prev: { slug?: string; state?: string; done?: number; total?: number } = {};
      if (existsSync(stripFile)) {
        try { prev = JSON.parse(readFileSync(stripFile, 'utf-8')); } catch { /* corrupt = no prior */ }
      }
      // v1.6.0: fire on a CLAIM-COUNT change too, not only a state change.
      // Most of a climb sits in one state (`ascending`), so the old gate emitted
      // one strip at the top of the hill and then went silent for every claim
      // closed after it. In that silence a per-claim "done" line is the only
      // completion signal on screen, and it reads as the whole run finishing
      // ({{PRINCIPAL_NAME}}, 2026-08-23: "claudes say x task is complete and i mistake it for
      // saying the whole thing is complete... i can't visually see where the
      // climbs are at"). The counts come from the same fm.progress deriveAscent
      // already reads, so the strip and the board still cannot disagree.
      if (prev.slug !== fm.slug || prev.state !== state || prev.done !== done || prev.total !== total) {
        const { mkdirSync, writeFileSync } = require('fs');
        mkdirSync(stripDir, { recursive: true });
        writeFileSync(stripFile, JSON.stringify({ slug: fm.slug, state, done, total, at: new Date().toISOString() }));
        const tag = ascentTag(state);
        // Plain English only. {{PRINCIPAL_NAME}}, 2026-08-23: "C9 or any other titles / nouns
        // that aren't english words are meaningless to me... its not like i have
        // the ISA open on a screen next to me". So the strip names the run by its
        // human title (not the slug) and names the next open claim by its WORDS
        // (not its id). The strip must be readable with nothing else on screen.
        const words = (raw: string, cap: number): string => {
          const t = String(raw)
            .replace(/^Anti:\s*/i, 'guard: ')
            .replace(/`[^`]*`/g, (m) => m.slice(1, -1))  // code spans read as noise
            .replace(/\s+/g, ' ')
            .trim();
          if (t.length <= cap) return t;
          const cut = t.slice(0, cap);
          const sp = cut.lastIndexOf(' ');
          return (sp > cap * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:.\-—]$/, '') + '…';
        };
        // One line, always. A strip that wraps is worse than no strip: the wrap
        // lands it back in the wall of text it exists to escape. So the fields
        // are fitted to a fixed width instead of each being capped in isolation,
        // which is how the first version reached 190 columns.
        // 120 columns is the Windows Terminal default and the narrowest width
        // the strip is allowed to assume. Everything is fitted to that budget
        // together rather than each field being capped on its own, which is how
        // the first version reached 190 columns and wrapped.
        const WIDTH = 120;
        const head = `════ LifeOS | Algorithm | ${tag.icon} ${tag.label}`;
        // The state icon is emoji and occupies two terminal columns, not one.
        let budget = WIDTH - (head.length + 1) - ' ════'.length;

        // Priority when space is short: the count never goes, because it is the
        // field that separates one claim closing from the whole run closing.
        // The run name yields next. The claim text absorbs whatever is left.
        const count = total > 0 ? ` | ${done} of ${total} done` : '';
        budget -= count.length;

        const name = words(fm.title || fm.task || String(fm.slug).replace(/-/g, ' '), 30);
        budget -= name.length + 3;

        let claim = '';
        const nextOpen = total > 0 && done < total
          ? parseCriteriaList(content).find((c) => c.status !== 'completed')
          : undefined;
        // Below about 16 columns a claim is unreadable, so drop it rather than
        // print two words and an ellipsis.
        if (nextOpen && budget >= 16 + ' | now: '.length) {
          claim = ` | now: ${words(nextOpen.description, budget - ' | now: '.length)}`;
        }
        const climb = ` | ${name}${count}${claim}`;
        stripDelta = [
          '<lifeos-ascent-delta>',
          "The run's position on the hill changed, computed by ISASync through the same deriveAscent() every dashboard surface reads. Render this strip VERBATIM, exactly once, on its own line DIRECTLY ABOVE the closer at the very BOTTOM of the response. Never at the top. Never compute a strip yourself. The count is the WHOLE run: never call the run done while it reads below n of n. When a claim closes, say what it was in plain words (\"the charts have labelled axes now\") and never by its id alone (\"C7 closed\"), because the principal does not have the ISA open.",
          `════ LifeOS | Algorithm | ${tag.icon} ${tag.label}${climb} ════`,
          '</lifeos-ascent-delta>',
        ].join('\n');
      }
    } catch { /* the strip is decoration — it must never break sync */ }
  }

  // ─────────── HTML Mirror trigger 1 (v6.5.0 ISA HTML Mirror) ───────────
  // Fire ISARender ONLY on transition to `complete`. Per-phase changes during
  // active work do NOT fire renders — user-stated constraint:
  //   "lots of phase changes as it's being written; we don't want to be
  //    constantly remaking the HTML file."
  if (newPhase === 'COMPLETE' && oldPhase !== 'COMPLETE' && fm.slug) {
    try {
      const isaRender = join(homedir(), '.claude/LIFEOS/TOOLS/ISARender.ts');
      const proc = spawn('bun', [isaRender, isaPath], {
        detached: true, windowsHide: true,
        stdio: 'ignore',
      });
      proc.unref();
    } catch (err) {
      console.error('[ISASync] ISARender spawn failed:', err);
    }
  }

  // ─────────── HTML Mirror trigger 2 — session state tracking ───────────
  // Record this edit so ISARenderOnStop.hook.ts can decide whether to render
  // at end-of-turn. The Stop hook gates on ISA.html already existing, so
  // pre-completion edits never trigger renders even though they show up here.
  if (input.session_id) {
    try {
      const stateDir = join(homedir(), '.claude/LIFEOS/MEMORY/STATE/isa-render-debounce');
      const stateFile = join(stateDir, `${input.session_id}.json`);
      const { mkdirSync, writeFileSync } = require('fs');
      mkdirSync(stateDir, { recursive: true });
      let edited: string[] = [];
      if (existsSync(stateFile)) {
        try { edited = JSON.parse(readFileSync(stateFile, 'utf-8')).edited_isas || []; } catch {}
      }
      if (!edited.includes(isaPath)) edited.push(isaPath);
      writeFileSync(stateFile, JSON.stringify({ session_id: input.session_id, edited_isas: edited, updated: new Date().toISOString() }));
    } catch { /* silent — state-tracking failure must not break sync */ }
  }

  return stripDelta;
}

main()
  .then((additionalContext) => {
    const out: Record<string, unknown> = { continue: true };
    if (additionalContext) {
      out.hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext };
    }
    console.log(JSON.stringify(out));
    process.exit(0);
  })
  .catch(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
