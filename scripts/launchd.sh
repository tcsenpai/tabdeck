#!/bin/sh
# Macro pad as a LaunchAgent: starts at login and launchd restarts it if it dies.
#   scripts/launchd.sh install | uninstall | status
set -eu

LABEL="dev.tabdeck.pad"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/Library/Logs/tabdeck.log"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    # Real path of bun (mise uses symlinks such as "latest": resolve it now).
    BUN="$(readlink -f "$(command -v bun)")"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>server.ts</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <!-- Without this launchd runs the job as background work and throttles its timers: the
       visualizer dropped from 20 to ~7 frames/s. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout is asynchronous: bootstrapping too soon fails with "Input/output error"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
      sleep 0.5
    done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. bun: $BUN  log: $LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>&1 | grep -E "state|pid|last exit|program" || echo "Not loaded."
    ;;
  *)
    echo "usage: $0 install|uninstall|status" >&2
    exit 1
    ;;
esac
