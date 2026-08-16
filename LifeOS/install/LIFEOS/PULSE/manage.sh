#!/bin/bash
# LifeOS Pulse — Process Management
# Usage: manage.sh {start|stop|restart|status|install|uninstall}

PULSE_DIR="$HOME/.claude/LIFEOS/PULSE"
PLIST_NAME="com.lifeos.pulse"
PLIST_SRC="$PULSE_DIR/$PLIST_NAME.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
PID_FILE="$PULSE_DIR/state/pulse.pid"
STATE_FILE="$PULSE_DIR/state/state.json"

# Resolve bun's actual location for the launchd job. The public plist
# template ships with `__BUN_PATH__` so the job works for both brew users
# (/opt/homebrew/bin/bun) and curl-installer users (~/.bun/bin/bun).
#
# Order matters. `command -v bun` can resolve to a temporary helper shim
# inside `/private/tmp/bun-node-*/bun` when this script runs inside `bun
# install` (the child shell has its own PATH). That path is ephemeral and
# the launchd job would fail on next boot. Prefer the canonical install
# locations and fall back to `command -v bun` only if neither exists.
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_PATH="$HOME/.bun/bin/bun"
elif [ -x "/opt/homebrew/bin/bun" ]; then
  BUN_PATH="/opt/homebrew/bin/bun"
elif [ -x "/usr/local/bin/bun" ]; then
  BUN_PATH="/usr/local/bin/bun"
else
  BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"
fi

# OS detection — Linux uses systemd --user, macOS uses launchctl, Windows uses
# Task Scheduler. Without the Windows case, git-bash (uname reports
# MINGW64_NT-10.0-*) fell through to the macOS branch and ran `launchctl`, which
# does not exist there. stderr was already redirected to /dev/null, so every
# start/stop printed its success line while doing absolutely nothing, and
# `status` read PULSE/state/pulse.pid — a file the Windows path never writes —
# and reported NOT RUNNING even when Pulse was up.
OS=$(uname -s)
SERVICE_SRC="$PULSE_DIR/$PLIST_NAME.service"
SYSTEMD_SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DST="$SYSTEMD_SERVICE_DIR/$PLIST_NAME.service"

case "$OS" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
  *)                    IS_WINDOWS=0 ;;
esac

# The Windows service layer is owned by LIFEOS/TOOLS/lib/win-scheduler.ts: it
# generates a .cmd wrapper per label and registers it as a scheduled task under
# the \LifeOS\ folder. The wrapper records its daemon's PID here.
WIN_SERVICES="$HOME/.claude/LIFEOS/MEMORY/STATE/win-services"
WIN_PID_FILE="$WIN_SERVICES/$PLIST_NAME.pid"

# Everything Windows-side goes through PowerShell rather than cmd or schtasks.
# Under git-bash a leading `/` in an argument is path-mangled into `C:/...`, so
# `schtasks /Run /TN ...` needs `//Run //TN` to survive — a trap worth avoiding
# entirely rather than encoding.
psrun() { powershell -NoProfile -NonInteractive -Command "$1"; }

# Count live Pulse daemons by command line. A recorded PID is not trustworthy on
# its own: a reboot can hand that number to an unrelated process.
win_pulse_count() {
  psrun "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'bun.exe' -and \$_.CommandLine -like '*pulse.ts*' }).Count" 2>/dev/null | tr -d '\r\n '
}

case "$1" in
  start)
    if [ "$IS_WINDOWS" = "1" ]; then
      # Start via the registered task so the daemon is launched exactly the way
      # Task Scheduler will launch it, wrapper guard included.
      psrun "Start-ScheduledTask -TaskPath '\\LifeOS\\' -TaskName '$PLIST_NAME'" >/dev/null 2>&1
      for _ in $(seq 1 20); do
        sleep 0.5
        if [ "$(win_pulse_count)" != "0" ]; then
          echo "LifeOS Pulse started (PID $(cat "$WIN_PID_FILE" 2>/dev/null | tr -d '\r\n'))"
          exit 0
        fi
      done
      echo "ERROR: LifeOS Pulse did not come up within 10s." >&2
      echo "  Check: tail -50 $WIN_SERVICES/$PLIST_NAME.log" >&2
      exit 1
    elif [ "$OS" = "Linux" ]; then
      systemctl --user start "$PLIST_NAME"
      echo "LifeOS Pulse started"
    else
      if [ ! -f "$PLIST_DST" ]; then
        # Substitute __HOME__ + __BUN_PATH__ placeholders (public template);
        # no-op on plists that already have literal paths.
        sed -e "s|__HOME__|$HOME|g" -e "s|__BUN_PATH__|$BUN_PATH|g" "$PLIST_SRC" > "$PLIST_DST"
      fi
      launchctl load "$PLIST_DST" 2>/dev/null
      echo "LifeOS Pulse started"
    fi
    ;;

  stop)
    if [ "$IS_WINDOWS" = "1" ]; then
      # Match on the command line, not the recorded PID: the wrapper's PID file
      # goes stale across reboots, and killing a recycled PID would take out an
      # unrelated process.
      psrun "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'bun.exe' -and \$_.CommandLine -like '*pulse.ts*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
      rm -f "$WIN_PID_FILE"
      echo "LifeOS Pulse stopped"
      exit 0
    fi
    if [ "$OS" = "Linux" ]; then
      systemctl --user stop "$PLIST_NAME" 2>/dev/null
    else
      launchctl unload "$PLIST_DST" 2>/dev/null
    fi
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      kill "$PID" 2>/dev/null
      echo "LifeOS Pulse stopped (PID $PID)"
    else
      echo "LifeOS Pulse stopped"
    fi
    ;;

  restart)
    # Use the resolved script path, not bare "$0" — when invoked as `bash manage.sh
    # restart` (no leading path) "$0" is just `manage.sh` and the self-reinvoke fails
    # with "command not found".
    bash "$PULSE_DIR/manage.sh" stop
    sleep 2
    bash "$PULSE_DIR/manage.sh" start
    ;;

  status)
    if [ "$IS_WINDOWS" = "1" ]; then
      WIN_COUNT="$(win_pulse_count)"
      WIN_PID="$(cat "$WIN_PID_FILE" 2>/dev/null | tr -d '\r\n')"
      if [ "$WIN_COUNT" = "0" ] || [ -z "$WIN_COUNT" ]; then
        if [ -n "$WIN_PID" ]; then
          echo "LifeOS Pulse: DEAD (stale PID $WIN_PID)"
        else
          echo "LifeOS Pulse: NOT RUNNING (no daemon, no PID file)"
        fi
      else
        # More than one is the EADDRINUSE pile-up the keepAlive wrapper guard
        # exists to prevent; say so rather than reporting a healthy single.
        if [ "$WIN_COUNT" = "1" ]; then
          echo "LifeOS Pulse: RUNNING (PID ${WIN_PID:-unknown})"
        else
          echo "LifeOS Pulse: DEGRADED ($WIN_COUNT daemons alive — duplicates fight over :31337)"
        fi
      fi
    elif [ "$OS" = "Linux" ]; then
      systemctl --user status "$PLIST_NAME"
    else
      if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
          UPTIME=$(ps -p "$PID" -o etime= | xargs)
          echo "LifeOS Pulse: RUNNING (PID $PID, uptime $UPTIME)"
        else
          echo "LifeOS Pulse: DEAD (stale PID $PID)"
        fi
      else
        echo "LifeOS Pulse: NOT RUNNING (no PID file)"
      fi
    fi

    if [ -f "$STATE_FILE" ]; then
      echo ""
      echo "Last job runs:"
      bun -e "
        const state = JSON.parse(require('fs').readFileSync('$STATE_FILE', 'utf-8'));
        for (const [name, info] of Object.entries(state.jobs)) {
          const ago = Math.round((Date.now() - info.lastRun) / 60000);
          const status = info.consecutiveFailures > 0 ? ' [FAILING x' + info.consecutiveFailures + ']' : '';
          console.log('  ' + name + ': ' + ago + ' min ago (' + info.lastResult + ')' + status);
        }
      " 2>/dev/null
    fi
    ;;

  install)
    mkdir -p "$PULSE_DIR/state" "$PULSE_DIR/logs"

    # Windows registration is owned by the task installer, not by this script.
    # Refuse loudly rather than falling through to launchctl and reporting a
    # success that registered nothing.
    if [ "$IS_WINDOWS" = "1" ]; then
      echo "ERROR: on Windows, Pulse is installed as a scheduled task, not from this script." >&2
      echo "  Run: bun ~/.claude/LIFEOS/TOOLS/Services.ts install --only pulse --yes" >&2
      exit 1
    fi

    if [ "$OS" = "Linux" ]; then
      mkdir -p "$SYSTEMD_SERVICE_DIR"
      # Kill any prior pulse before installing fresh — prevents the stale-PID
      # / unbound-port half-dead state where a previous service-managed pulse
      # is alive with open fds but never bound :31337.
      systemctl --user stop "$PLIST_NAME" 2>/dev/null || true
      pkill -9 -f "bun.*pulse.ts" 2>/dev/null || true
      sleep 1
      # Substitute __HOME__ + __BUN_PATH__ placeholders (public template);
      # no-op on service files that already have literal paths.
      sed -e "s|__HOME__|$HOME|g" -e "s|__BUN_PATH__|$BUN_PATH|g" "$SERVICE_SRC" > "$SERVICE_DST"
      # Ensure user services survive logout/reboot (no-op if already enabled)
      loginctl enable-linger "$USER" 2>/dev/null || true
      systemctl --user daemon-reload
      systemctl --user enable "$PLIST_NAME"
      systemctl --user start "$PLIST_NAME"
    else
      # Cleanup any prior pulse before installing fresh — prevents the stale-PID
      # / unbound-port half-dead state where a previous launchd-managed pulse is
      # alive with open fds but never bound :31337.
      if [ -f "$PLIST_DST" ]; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
      fi
      pkill -9 -f "bun.*pulse.ts" 2>/dev/null || true
      sleep 1

      # Substitute __HOME__ + __BUN_PATH__ placeholders (public template);
      # no-op on plists that already have literal paths.
      sed -e "s|__HOME__|$HOME|g" -e "s|__BUN_PATH__|$BUN_PATH|g" "$PLIST_SRC" > "$PLIST_DST"
      launchctl load "$PLIST_DST"
    fi

    # Verify pulse actually binds :31337 within 10s. Fail loud if not — prior
    # behavior was silent success even when the daemon never came up.
    for _ in $(seq 1 20); do
      sleep 0.5
      if curl -sS --max-time 1 -o /dev/null -X POST http://localhost:31337/notify \
           -H "Content-Type: application/json" \
           -d '{"message":"","voice_enabled":false}' 2>/dev/null; then
        echo "LifeOS Pulse installed and verified on port 31337 (bun: $BUN_PATH)"
        exit 0
      fi
    done

    echo "ERROR: LifeOS Pulse installed but port 31337 did not bind within 10s." >&2
    echo "  Check: tail -50 $PULSE_DIR/logs/pulse-stderr.log" >&2
    exit 1
    ;;

  uninstall)
    if [ "$IS_WINDOWS" = "1" ]; then
      echo "ERROR: on Windows, remove the scheduled task instead of using this script." >&2
      echo "  Run: bun ~/.claude/LIFEOS/TOOLS/Services.ts uninstall --only pulse" >&2
      exit 1
    fi
    if [ "$OS" = "Linux" ]; then
      systemctl --user disable --now "$PLIST_NAME" 2>/dev/null
      rm -f "$SERVICE_DST"
    else
      launchctl unload "$PLIST_DST" 2>/dev/null
      rm -f "$PLIST_DST"
    fi
    echo "LifeOS Pulse uninstalled"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|install|uninstall}"
    exit 1
    ;;
esac
