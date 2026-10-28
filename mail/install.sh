#!/bin/sh
# Installs tripmail and the Cairn service on this Mac (run it on mini, from the checkout):
#   ~/.tripmail/tripmail.app   small AppleScript app that holds the Calendar permission and runs tripmail.py
#   nl.tue.tripmail            launchd job: the app every 60 minutes (log ~/.tripmail/run.log)
#   nl.tue.cairn               launchd service: the Cairn server, kept running (log ~/.tripmail/cairn.log)
# An install from before tripmail was renamed (it was flightmail) keeps ~/.flightmail and its flightmail.app, which
# holds the permissions already; only the launchd job is renamed.
# PYTHON and NODE default to the micromamba env "contrail".
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-$HOME/micromamba/envs/contrail/bin/python}"
NODE="${NODE:-$HOME/micromamba/envs/contrail/bin/node}"
AGENTS="$HOME/Library/LaunchAgents"
if [ -d "$HOME/.flightmail/flightmail.app" ]; then
  DIR="$HOME/.flightmail"; APP="$DIR/flightmail.app"
else
  DIR="$HOME/.tripmail"; APP="$DIR/tripmail.app"
fi
mkdir -p "$DIR" "$AGENTS"
[ -f "$ROOT/config" ] || cp "$ROOT/default.config" "$ROOT/config"
[ -f "$ROOT/secret" ] || cp "$ROOT/default.secret" "$ROOT/secret"
chmod 600 "$ROOT/config" "$ROOT/secret"

# Calendar access is granted per app, and macOS refuses it silently to a bare python started by launchd.
# Built once: rebuilding changes its signature and macOS would ask again.
if [ ! -d "$APP" ]; then
  osacompile -o "$APP" -e "do shell script \"\\\"$PY\\\" \\\"$ROOT/mail/tripmail.py\\\" \${TRIPMAIL_ARGS:-} >> \\\"$DIR/run.log\\\" 2>&1\""
  PB=/usr/libexec/PlistBuddy; INFO="$APP/Contents/Info.plist"
  $PB -c "Add :CFBundleIdentifier string nl.tue.tripmail" "$INFO"
  $PB -c "Add :LSUIElement bool true" "$INFO"
  $PB -c "Add :NSCalendarsFullAccessUsageDescription string tripmail adds the trips from your booking emails to the Travel calendar." "$INFO"
  codesign -f -s - "$APP" 2>/dev/null
fi

LABEL=nl.tue.tripmail
if [ -f "$AGENTS/nl.tue.flightmail.plist" ]; then  # the job by its older name
  launchctl bootout "gui/$(id -u)/nl.tue.flightmail" 2>/dev/null || true
  rm "$AGENTS/nl.tue.flightmail.plist"
fi
cat > "$AGENTS/$LABEL.plist" <<PLIST
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
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL.plist"

if [ ! -f "$AGENTS/nl.tue.cairn.plist" ]; then
  sed -e "s#__REPO__#$ROOT#g" -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" "$ROOT/mail/cairn.plist.template" > "$AGENTS/nl.tue.cairn.plist"
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/nl.tue.cairn.plist"
fi

echo "tripmail runs every 60 minutes. Log: $DIR/run.log"
echo "Fill the \"tripmail\" sections of $ROOT/config and $ROOT/secret, then, with the screen unlocked,"
echo "run a dry run once and click Allow on the Calendar prompt:"
echo "  open -W --env TRIPMAIL_ARGS=--dry-run $APP; tail $DIR/run.log"
