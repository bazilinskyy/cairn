#!/bin/sh
# The hourly Garmin Connect sync on this Mac (run it on mini, from the checkout), after signing in once with
#   ~/.local/bin/uv run --with garminconnect python imports/garmin.py login
# LaunchAgent nl.tue.contrail-garmin runs imports/garmin.py sync every hour; log ~/Library/Logs/contrail-garmin.log.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UV="${UV:-$HOME/.local/bin/uv}"
LABEL=nl.tue.contrail-garmin
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/contrail-garmin.log"
[ -x "$UV" ] || { echo "uv not found at $UV (set UV=...)"; exit 1; }
[ -d "$HOME/.garminconnect" ] || echo "Not signed in yet: run  $UV run --with garminconnect python imports/garmin.py login"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$UV</string><string>run</string><string>-q</string><string>--with</string><string>garminconnect</string>
    <string>--with</string><string>fitdecode</string><string>python</string><string>$ROOT/imports/garmin.py</string><string>sync</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Garmin sync runs every hour. Log: $LOG"
echo "Run it now:  launchctl kickstart gui/$(id -u)/$LABEL"
