#!/usr/bin/env python3
"""Your calendars' events into Cairn, so a trip can say what it was for: a conference, a workshop, a defence, a project
meeting abroad. Cairn marks the trips that have such an event (💼) and lists the events on the trip's page.

Reads .ics files: Google Takeout's "Calendar" folder (one .ics per calendar, in the zip as it came), an Outlook or
Apple Calendar export, or any .ics file:

  python imports/calendar_events.py ~/Downloads/takeout-*.zip
  python imports/calendar_events.py ~/Downloads/Calendar/*.ics --send mini:repos/contrail/data/calendar.json

Writes data/calendar.json: [{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "title", "location", "calendar"}]: events
that last a day or more or have a location, each once (a repeating event: its first, as repeats are routine
meetings). Standard library only, no network.
"""
import argparse
import json
import re
import subprocess
import sys
import zipfile
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent


def ics_files(paths):
    for p in map(Path, paths):
        if p.is_dir():
            for f in sorted(p.rglob("*.ics")):
                yield f.stem, f.read_bytes()
        elif zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                for n in z.namelist():
                    if n.lower().endswith(".ics"):
                        yield Path(n).stem, z.read(n)
        elif p.suffix.lower() == ".ics":
            yield p.stem, p.read_bytes()


def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text)


def unescape(v):
    return v.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()


def day_of(prop, value):
    """DTSTART;VALUE=DATE:20190915 or DTSTART;TZID=...:20190915T090000 or ...Z -> (date, all_day)."""
    v = value.strip()
    if re.fullmatch(r"\d{8}", v):
        return date(int(v[:4]), int(v[4:6]), int(v[6:8])), True
    m = re.match(r"(\d{8})T(\d{4,6})", v)
    if m:
        d = m.group(1)
        return date(int(d[:4]), int(d[4:6]), int(d[6:8])), False
    return None, False


def events(name, data):
    text = unfold(data.decode("utf-8", "replace"))
    out = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S):
        props = {}
        for line in block.splitlines():
            m = re.match(r"([A-Z-]+)((?:;[^:]*)?):(.*)", line)
            if m and m.group(1) not in props:
                props[m.group(1)] = (m.group(2), m.group(3))
        if "DTSTART" not in props or "RECURRENCE-ID" in props:  # a moved repeat of a routine event
            continue
        start, all_day = day_of(*props["DTSTART"])
        end, _ = day_of(*props["DTEND"]) if "DTEND" in props else (start, all_day)
        if not start:
            continue
        end = end or start
        if all_day and end > start:
            end -= timedelta(days=1)  # all-day events end the day after (exclusive)
        title, location = unescape(props.get("SUMMARY", ("", ""))[1]), unescape(props.get("LOCATION", ("", ""))[1])
        status = props.get("STATUS", ("", ""))[1].upper()
        if status == "CANCELLED" or (end < start):
            continue
        if not location and (end - start).days < 1 and not all_day:
            continue  # an hour in the day with no place: says nothing about a trip
        out.append({"start": start.isoformat(), "end": end.isoformat(), "title": title, "location": location, "calendar": name})
    return out


def read(paths):
    seen, out = set(), []
    for name, data in ics_files(paths):
        for e in events(name, data):
            key = (e["start"], e["title"].lower(), e["location"].lower())
            if key not in seen:
                seen.add(key)
                out.append(e)
    return sorted(out, key=lambda e: (e["start"], e["title"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help=".ics files, folders of them, or a Takeout zip")
    data_dir = HERE.parent / "data"
    ap.add_argument("--out", default=str(data_dir / "calendar.json" if data_dir.is_dir() else "calendar.json"))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp")
    args = ap.parse_args(argv)
    found = read(args.paths)
    out = Path(args.out)
    out.write_text(json.dumps(found, ensure_ascii=False))
    print(f"{len(found)} events in {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
