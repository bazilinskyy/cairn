#!/bin/sh
# Cairn's nightly update on the always-on Mac (the LaunchAgent nl.tue.cairn-nightly, at 03:30): the photo index from the
# Photos library (where and when each photo was taken, the albums, the photos with no place), then the calendars'
# events. Only tripmail's app may read the Calendar app (macOS asks once per app), so the events are written out by
# it, one calendar at a time, and read into Cairn from there. Cairn reads the new files by itself. A photo index that
# fails shows on + Add → 🩺 Fix (data/photo_index_status.json); the rest is in the log.
#   CAIRN_CALENDARS   the calendars, by title ("Work Life Sports")
#   TRIPMAIL_APP      tripmail's app (~/.flightmail/flightmail.app)
cd "$(dirname "$0")/.." || exit 1
UV=${UV:-$HOME/.local/bin/uv}
PY=${PY:-$HOME/micromamba/envs/contrail/bin/python}
APP=${TRIPMAIL_APP:-$HOME/.flightmail/flightmail.app}
CALENDARS=${CAIRN_CALENDARS:-Work Life Sports}
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

say "photo index"
"$UV" run -q --with osxphotos --with 'pyobjc<13' python imports/photos.py \
  --points data/photo_points.json --albums data/photo_albums.json --unplaced data/photo_unplaced.json || say "photo index FAILED"

say "calendars: $CALENDARS"
files=""
for c in $CALENDARS; do
  before=$(stat -f %m "$HOME/.flightmail/events-$c.json" 2>/dev/null || echo 0)
  open -W -g -a "$APP" --env "FLIGHTMAIL_ARGS=events --calendar $c"
  after=$(stat -f %m "$HOME/.flightmail/events-$c.json" 2>/dev/null || echo 0)
  [ "$after" -gt "$before" ] || say "calendar $c: not written again (see ~/.flightmail/run.log)"
  [ -f "$HOME/.flightmail/events-$c.json" ] && files="$files $HOME/.flightmail/events-$c.json"
done
# shellcheck disable=SC2086
[ -n "$files" ] && { "$PY" imports/calendar_events.py $files || say "calendars FAILED"; }
say "done"
