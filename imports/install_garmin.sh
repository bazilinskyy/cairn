#!/bin/sh
# The nightly Garmin Connect sync on this Mac (run it on mini, from the checkout), after signing in once with
#   ~/.local/bin/uv run --with garminconnect python imports/garmin.py login
# LaunchAgent nl.tue.contrail-garmin runs imports/garmin.py sync every night at 02:30 (new activities, the whole list,
# FTP, weight; HOUR and MINUTE change the time); log ~/Library/Logs/contrail-garmin.log. On mini 02:30 sits between the
# 01:30 backup and the jobs from 04:00 (dataset page, short videos, Claude's lessons).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UV="${UV:-$HOME/.local/bin/uv}"
LABEL=nl.tue.contrail-garmin
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/contrail-garmin.log"
HOUR="${HOUR:-2}"
MINUTE="${MINUTE:-30}"
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
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Garmin sync runs every night at $HOUR:$(printf %02d "$MINUTE"). Log: $LOG"
echo "Run it now:  launchctl kickstart gui/$(id -u)/$LABEL"
