# UpdatePatterns Workflow

Update Fabric patterns from the upstream repository, **without destroying patterns that only exist locally.**

---

## Two rules this workflow must not break

1. **Never delete a local-only pattern.** The skill ships patterns that do not exist upstream, including the `arbiter-*` family and `create_threat_model`. An earlier version of this workflow used `rsync --delete`, which removed them, and then Step 6 verified `create_threat_model` was present — a pattern Step 4 had just deleted. The sync is **additive and overwriting, never deleting**.
2. **Do not depend on `rsync`.** It is absent from Git Bash on Windows, so an `rsync` step fails outright on that platform. Use POSIX `cp` in a loop, which works everywhere.

---

## Prerequisites

Either the fabric CLI, or `git`. Neither is required if `~/.config/fabric/patterns` is already populated.

- fabric via winget: `winget install danielmiessler.Fabric`
- fabric via Go: `go install github.com/danielmiessler/fabric@latest`

The CLI's first-run setup insists on configuring at least one AI provider before it exits successfully. That does **not** matter here: it downloads the patterns before reaching the provider prompt, and this skill runs patterns natively through Claude rather than through fabric's model config.

---

## Workflow Steps

### Step 1: Send Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Updating Fabric patterns from upstream repository"}' \
  > /dev/null 2>&1 &
```

### Step 2: Record the starting state

```bash
DEST=~/.claude/skills/Fabric/Patterns
BEFORE=$(find "$DEST" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
echo "Current patterns: $BEFORE"
```

### Step 3: Refresh the upstream copy

```bash
SRC=~/.config/fabric/patterns

if command -v fabric >/dev/null 2>&1; then
  fabric -U            # refreshes ~/.config/fabric/patterns
elif [ ! -d "$SRC" ]; then
  # No CLI: clone straight to a temp dir and point SRC at it.
  TMP=$(mktemp -d)
  git clone --depth 1 https://github.com/danielmiessler/fabric.git "$TMP/fabric"
  SRC="$TMP/fabric/data/patterns"
fi

[ -d "$SRC" ] || { echo "No pattern source found at $SRC — aborting."; exit 1; }
```

Note the upstream path is `data/patterns`, not `patterns`.

### Step 4: Back up before touching anything

```bash
cp -r "$DEST" "$DEST.bak-$(date +%Y-%m-%d)"
echo "Backup: $DEST.bak-$(date +%Y-%m-%d)"
```

### Step 5: Additive sync

New patterns are added, existing ones are refreshed from upstream, local-only ones are left alone.

```bash
ADDED=0; UPDATED=0
for dir in "$SRC"/*/; do
  name=$(basename "$dir")
  if [ -d "$DEST/$name" ]; then
    cp -r "$dir." "$DEST/$name/" && UPDATED=$((UPDATED+1))
  else
    cp -r "$dir" "$DEST/$name" && ADDED=$((ADDED+1))
  fi
done
echo "Added: $ADDED   Refreshed: $UPDATED"
```

### Step 6: Report and verify

```bash
AFTER=$(find "$DEST" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
echo "Patterns: $BEFORE -> $AFTER"

# These include local-only patterns. A miss here means the sync deleted
# something it should not have — restore from the Step 4 backup.
for pattern in extract_wisdom summarize analyze_claims create_threat_model arbiter-run-prompt; do
  [ -d "$DEST/$pattern" ] && echo "OK $pattern" || echo "MISSING $pattern"
done

# Every pattern must carry a system.md or it will not execute.
find "$DEST" -maxdepth 1 -mindepth 1 -type d ! -exec test -f {}/system.md \; -print
```

The last command prints nothing when healthy. Any path it prints is a pattern directory with no `system.md`.

---

## Output

Report to user:

- Pattern count before and after
- How many were added versus refreshed
- Any `MISSING` line from Step 6, which means restore the backup
- Any directory listed as lacking `system.md`
