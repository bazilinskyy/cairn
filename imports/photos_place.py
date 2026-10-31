#!/usr/bin/env python3
"""The places you gave photos by hand in Cairn (#place-photos, data/photo_places.json) into the Apple Photos library
itself, so the library stays the one place that knows where each photo was taken. Cairn runs it after you place photos:

  uv run --with osxphotos --with 'pyobjc<13' python imports/photos_place.py data/photo_places.json

Reads {file path: {"lat", "lon", "written"?}} and sets the location of each photo not written yet (its library id is in
its file name). Prints one JSON line per photo set, {"path", "ok"}, for Cairn to mark it written; changes nothing else.
Waits for nothing: when another job drives Photos (an import), it prints {"busy": true} and stops, and Cairn tries
again later.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

LIBRARY = re.compile(r"\.photoslibrary/originals/[0-9A-F]/([0-9A-F-]{36})\.[^/]+$", re.I)


def busy():
    """Another job driving Photos: two at once make AppleScript hang."""
    r = subprocess.run(["pgrep", "-f", "osxphotos import|photos-after.py|photos-laptop-import"], capture_output=True, text=True)
    return bool(r.stdout.strip())


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    places = json.loads(Path(args[0]).read_text())
    todo = [(p, v) for p, v in places.items() if not v.get("written") and LIBRARY.search(p)]
    if not todo:
        return 0
    if busy():
        print(json.dumps({"busy": True}), flush=True)
        return 0
    import photoscript
    for path, v in todo:
        uuid = LIBRARY.search(path).group(1)
        try:
            photoscript.Photo(uuid).location = (float(v["lat"]), float(v["lon"]))
            print(json.dumps({"path": path, "ok": True}), flush=True)
        except Exception as e:  # a photo deleted since, or Photos not answering: tried again next time
            print(json.dumps({"path": path, "ok": False, "error": str(e)[:200]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
