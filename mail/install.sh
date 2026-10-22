#!/bin/sh
# Installs flightmail and the Contrail service on this Mac (run it on mini, from the checkout):
#   ~/.flightmail/flightmail.app   small AppleScript app that holds the Calendar permission and runs flightmail.py
#   nl.tue.flightmail              launchd job: the app every 60 minutes (log ~/.flightmail/run.log)
#   nl.tue.contrail                launchd service: the Contrail server, kept running (log ~/.flightmail/contrail.log)
# PYTHON and NODE default to the micromamba env "contrail".
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/.flightmail"
PY="${PYTHON:-$HOME/micromamba/envs/contrail/bin/python}"
NODE="${NODE:-$HOME/micromamba/envs/contrail/bin/node}"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$DIR" "$AGENTS"
[ -f "$ROOT/config" ] || cp "$ROOT/default.config" "$ROOT/config"
[ -f "$ROOT/secret" ] || cp "$ROOT/default.secret" "$ROOT/secret"
chmod 600 "$ROOT/config" "$ROOT/secret"

# Calendar access is granted per app, and macOS refuses it silently to a bare python started by launchd.
# Built once: rebuilding changes its signature and macOS would ask again.
APP="$DIR/flightmail.app"
if [ ! -d "$APP" ]; then
  osacompile -o "$APP" -e "do shell script \"\\\"$PY\\\" \\\"$ROOT/mail/flightmail.py\\\" \${FLIGHTMAIL_ARGS:-} >> \\\"$DIR/run.log\\\" 2>&1\""
  PB=/usr/libexec/PlistBuddy; INFO="$APP/Contents/Info.plist"
  $PB -c "Add :CFBundleIdentifier string nl.tue.flightmail" "$INFO"
  $PB -c "Add :LSUIElement bool true" "$INFO"
  $PB -c "Add :NSCalendarsFullAccessUsageDescription string flightmail adds the flights from your booking emails to the Travel calendar." "$INFO"
  codesign -f -s - "$APP" 2>/dev/null
fi

LABEL=nl.tue.flightmail
cat > "$AGENTS/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP/Contents/MacOS/applet</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL.plist"

if [ ! -f "$AGENTS/nl.tue.contrail.plist" ]; then
  sed -e "s#__REPO__#$ROOT#g" -e "s#__NODE__#$NODE#g" -e "s#__HOME__#$HOME#g" "$ROOT/mail/contrail.plist.template" > "$AGENTS/nl.tue.contrail.plist"
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/nl.tue.contrail.plist"
fi

echo "flightmail runs every 60 minutes. Log: $DIR/run.log"
echo "Fill the \"flightmail\" sections of $ROOT/config and $ROOT/secret, then, with the screen unlocked,"
echo "run a dry run once and click Allow on the Calendar prompt:"
echo "  open -W --env FLIGHTMAIL_ARGS=--dry-run $APP; tail $DIR/run.log"
