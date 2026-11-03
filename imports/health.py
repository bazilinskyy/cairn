#!/usr/bin/env python3
"""Workouts and daily steps from Apple Health's export (Health app → your picture → Export All Health Data: export.zip).

Its workouts are those of the iPhone and the Apple Watch, and of every app that writes to Health (running apps,
Komoot, Nike Run Club, ...), with the route where one was recorded (workout-routes/*.gpx); its steps and floors
climbed go back to the first iPhone that counted them. Cairn adds the workouts to the Sports tab and the map, each
once (one Garmin or Strava has too is left to them, and so is every workout Garmin Connect wrote to Health: Garmin's
own data has them, a multisport as one), and the steps to the days Garmin has none.

  python imports/health.py ~/Downloads/export.zip --send mini:repos/contrail/data/health.json

Writes data/health.json: {"activities": [as Cairn's activities], "days": {"YYYY-MM-DD": {"steps", "floors"}}}.
Replaces what was there. Standard library only; reads export.xml as it goes (it can be gigabytes).
"""
import argparse
import io
import json
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from garmin import tiles_of, EPS  # noqa: E402
from timeline import encode, simplify  # noqa: E402

ID_BASE = 900_000_000_000  # an activity's id: this plus its start (Garmin's and Strava's ids are far below)

# HKWorkoutActivityType… -> Strava's names, which Cairn groups by
SPORTS = {
    "Running": "Run", "Walking": "Walk", "Hiking": "Hike", "Cycling": "Ride", "HandCycling": "Handcycle",
    "Swimming": "Swim", "DownhillSkiing": "AlpineSki", "Snowboarding": "Snowboard", "CrossCountrySkiing": "NordicSki",
    "Rowing": "Rowing", "PaddleSports": "Kayaking", "Paddling": "Kayaking", "Climbing": "RockClimbing",
    "Elliptical": "Elliptical", "Yoga": "Yoga", "TraditionalStrengthTraining": "WeightTraining",
    "FunctionalStrengthTraining": "WeightTraining", "WheelchairWalkPace": "Wheelchair", "WheelchairRunPace": "Wheelchair",
}
DAY_TYPES = {"HKQuantityTypeIdentifierStepCount": "steps", "HKQuantityTypeIdentifierFlightsClimbed": "floors"}


def parse_time(s):
    """Health's "2019-05-01 08:51:22 +0200": (unix time, local "2019-05-01 08:51:22")."""
    d = datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
    return int(d.timestamp()), d.strftime("%Y-%m-%d %H:%M:%S")


def to_km(value, unit):
    v = float(value or 0)
    return v * {"km": 1, "m": 0.001, "mi": 1.609344, "yd": 0.0009144, "ft": 0.0003048}.get(unit or "km", 1)


def read_gpx(data):
    """[(lat, lon), ...] of a route file."""
    pts = []
    for _, el in ET.iterparse(io.BytesIO(data)):
        if el.tag.endswith("trkpt"):
            try:
                pts.append((float(el.get("lat")), float(el.get("lon"))))
            except (TypeError, ValueError):
                pass
            el.clear()
    return pts


class Export:
    """export.xml and the route files, from the zip or the unpacked folder."""

    def __init__(self, path):
        p = Path(path)
        self.zip = zipfile.ZipFile(p) if zipfile.is_zipfile(p) else None
        if self.zip:
            names = self.zip.namelist()
            xml = [n for n in names if re.search(r"(^|/)(export|Export)\.xml$", n)]
            if not xml:
                raise SystemExit(f"{p.name}: no export.xml in it")
            self.root = xml[0].rsplit("/", 1)[0] + "/" if "/" in xml[0] else ""
            self.xml = xml[0]
        else:
            folder = p if p.is_dir() else p.parent
            self.folder = folder
            self.xml = str(p if p.is_file() else folder / "export.xml")

    def open_xml(self):
        return self.zip.open(self.xml) if self.zip else open(self.xml, "rb")

    def route(self, ref):
        ref = ref.lstrip("/")
        try:
            if self.zip:
                return read_gpx(self.zip.read(self.root + ref))
            return read_gpx((self.folder / ref).read_bytes())
        except (KeyError, OSError, ET.ParseError):
            return []


def load(path):
    ex = Export(path)
    acts, per_source = [], {}  # per_source: (day, kind, source) -> sum
    root = None
    for ev, el in ET.iterparse(ex.open_xml(), events=("start", "end")):
        if root is None:
            root = el
        if ev == "start":
            continue
        if el.tag == "Record":
            kind = DAY_TYPES.get(el.get("type"))
            if kind:
                day = (el.get("startDate") or "")[:10]
                k = (day, kind, el.get("sourceName") or "")
                per_source[k] = per_source.get(k, 0) + float(el.get("value") or 0)
            root.clear()  # millions of records: none kept once counted
        elif el.tag == "Workout":
            acts.append(workout(el, ex))
            root.clear()
    # the iPhone and the Watch both count the same steps: the day's count is its biggest source's
    days = {}
    for (day, kind, _), v in per_source.items():
        d = days.setdefault(day, {})
        d[kind] = max(d.get(kind, 0), round(v))
    return {"activities": sorted((a for a in acts if a), key=lambda a: -a["start"]), "days": dict(sorted(days.items()))}


def workout(el, ex):
    try:
        start, local = parse_time(el.get("startDate"))
        end, _ = parse_time(el.get("endDate"))
    except (TypeError, ValueError):
        return None
    raw = re.sub(r"^HKWorkoutActivityType", "", el.get("workoutActivityType") or "")
    sport = SPORTS.get(raw, raw or "Workout")
    meta = {m.get("key"): m.get("value") for m in el.findall("MetadataEntry")}
    km = to_km(el.get("totalDistance"), el.get("totalDistanceUnit")) if el.get("totalDistance") else 0
    hr = None
    for s in el.findall("WorkoutStatistics"):
        t = s.get("type") or ""
        if not km and re.search(r"Distance", t) and s.get("sum"):
            km = to_km(s.get("sum"), s.get("unit"))
        if t.endswith("HeartRate") and s.get("average"):
            hr = round(float(s.get("average")))
    climb = 0
    m = re.match(r"([\d.]+)\s*(cm|m|ft)?", meta.get("HKElevationAscended") or "")
    if m:
        climb = float(m.group(1)) * {"cm": 0.01, "m": 1, "ft": 0.3048}.get(m.group(2) or "m", 1)
    pts = []
    for r in el.iter("FileReference"):
        pts += ex.route(r.get("path") or "")
    indoor = meta.get("HKIndoorWorkout") == "1"
    if indoor:
        pts = []
    simple = simplify(pts, EPS) if len(pts) > 2 else pts
    dur = float(el.get("duration") or 0) * {"min": 60, "s": 1, "h": 3600}.get(el.get("durationUnit") or "min", 60)
    by = el.get("sourceName") or "Apple Health"
    return {
        "id": ID_BASE + start, "name": f"{sport} ({by})", "sport": sport, "source": "health", "app": by,
        "date": local, "start": start, "distance": round(km, 1), "moving_time": round(dur or end - start), "elapsed_time": round(end - start),
        "elevation": round(climb), "heartrate": hr, "prs": 0, "kudos": 0, "commute": False, "trainer": indoor or not pts,
        "path": encode(simple) if len(simple) > 1 else "",
        "at": [round(pts[0][0], 5), round(pts[0][1], 5)] if pts else None, "tiles": tiles_of(pts) if len(pts) > 1 else [],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="export.zip, its unpacked folder, or its export.xml")
    ap.add_argument("--out", default=str(HERE.parent / "data" / "health.json"))
    ap.add_argument("--send", help="also copy the result there with scp (host:path)")
    a = ap.parse_args(argv)
    doc = load(a.path)
    Path(a.out).write_text(json.dumps(doc, separators=(",", ":")))
    if a.send:
        subprocess.run(["scp", a.out, a.send], check=True)
    routes = sum(1 for x in doc["activities"] if x["path"])
    print(f"{len(doc['activities'])} workouts ({routes} with a route), steps on {sum(1 for d in doc['days'].values() if d.get('steps'))} days")


if __name__ == "__main__":
    main()
