#!/usr/bin/env python3
"""Google Maps Timeline into Contrail's map: the places you stayed at and the paths you travelled, per day.

Reads any of Google's exports (no network, standard library only):
  - Timeline.json from the phone (Settings > Location > Timeline > Export), Android or iOS layout
  - Takeout's "Semantic Location History" folder (one JSON file per month) or one of its files
  - Takeout's Records.json (raw location points)
and writes data/timeline.json:
  {"visits": [{"lat", "lon", "start", "end", "name"}], "paths": [{"date", "path"}]}
with times as "YYYY-MM-DD HH:MM" in the export's own local time (UTC where the export gives no offset) and each path
an encoded polyline (6 decimals), simplified to about 50 m and cut where it jumps (flights are on the map already).

  python imports/timeline.py ~/Downloads/Timeline.json
  python imports/timeline.py ~/Downloads/Takeout/Location\\ History --send mini:repos/contrail/data/timeline.json
"""
import argparse
import json
import math
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

JUMP_KM = 100   # a path is cut where two points are further apart than this (a flight)
GAP_H = 2       # or further apart in time than this (raw points)
EPS = 0.0005    # simplification tolerance in degrees, about 50 m


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def encode(pts, precision=6):
    out, plat, plon, f = [], 0, 0, 10 ** precision
    for lat, lon in pts:
        a, b = round(lat * f), round(lon * f)
        for v in (a - plat, b - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = a, b
    return "".join(out)


def simplify(pts, eps=EPS):
    """Ramer-Douglas-Peucker in degrees."""
    if len(pts) < 3:
        return pts
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop()
        (y1, x1), (y2, x2) = pts[s], pts[e]
        length = math.hypot(x2 - x1, y2 - y1)
        best, far = None, eps
        for i in range(s + 1, e):
            y, x = pts[i]
            d = abs((x2 - x1) * (y1 - y) - (x1 - x) * (y2 - y1)) / length if length else math.hypot(x - x1, y - y1)
            if d > far:
                best, far = i, d
        if best is not None:
            keep.add(best)
            stack += [(s, best), (best, e)]
    return [p for i, p in enumerate(pts) if i in keep]


def latlng(v):
    """A point in any of the exports' spellings: "51.44°, 5.47°", "geo:51.44,5.47", {"latitudeE7": .., "longitudeE7": ..}
    or {"latE7": .., "lngE7": ..}; None when there is none."""
    if isinstance(v, str):
        m = re.search(r"(-?\d+(?:\.\d+)?)°?,\s*(-?\d+(?:\.\d+)?)", v)
        return (float(m.group(1)), float(m.group(2))) if m else None
    if isinstance(v, dict):
        lat = v.get("latitudeE7", v.get("latE7"))
        lon = v.get("longitudeE7", v.get("lngE7"))
        if lat is not None and lon is not None:
            return lat / 1e7, lon / 1e7
        for k in ("latLng", "placeLocation", "point", "location"):
            if k in v:
                return latlng(v[k])
    return None


def when(v):
    """(local "YYYY-MM-DD HH:MM", datetime) of an ISO time or a timestampMs; None when unreadable."""
    if v is None:
        return None
    try:
        if isinstance(v, (int, float)) or str(v).isdigit():
            t = datetime.fromtimestamp(int(v) / 1000, timezone.utc)
        else:
            t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return f"{t:%Y-%m-%d %H:%M}", t


class Collector:
    def __init__(self):
        self.visits, self.points = [], []  # points: (datetime or None, day, (lat, lon), segment id)
        self.segment = 0

    def visit(self, at, start, end, name=""):
        s, e = when(start), when(end)
        if at and s:
            self.visits.append({"lat": round(at[0], 5), "lon": round(at[1], 5), "start": s[0], "end": e[0] if e else s[0],
                                "name": name or ""})

    def path(self, pts, start=None):
        """One stretch of travel: points as (lat, lon) or ((lat, lon), time)."""
        self.segment += 1
        s = when(start)
        for p in pts:
            at, t = p if isinstance(p[0], tuple) else (p, None)
            t = when(t) if t is not None else s
            if at and t:
                self.points.append((t[1], t[0][:10], at, self.segment))

    def raw(self, at, t):
        t = when(t)
        if at and t:
            self.points.append((t[1], t[0][:10], at, 0))

    def result(self):
        paths = []
        by_day = defaultdict(list)
        for t, day, at, seg in self.points:
            by_day[day].append((t, seg, at))
        for day in sorted(by_day):
            pts, line, last = sorted(by_day[day], key=lambda x: (x[0], x[1])), [], None
            for t, seg, at in pts:
                if last and (km(last[2], at) > JUMP_KM or (seg == 0 and (t - last[0]).total_seconds() > GAP_H * 3600)):
                    paths.append(line)
                    line = []
                line.append((day, at))
                last = (t, seg, at)
            paths.append(line)
        out = [{"date": line[0][0], "path": encode(simplify([at for _, at in line]))} for line in paths if len(line) > 1]
        visits = sorted({(v["start"], v["lat"], v["lon"]): v for v in self.visits}.values(), key=lambda v: v["start"])
        return {"visits": visits, "paths": out}


def read(doc, c):
    """Add one parsed export file to the collector."""
    if isinstance(doc, dict) and "locations" in doc:  # Records.json
        for p in doc["locations"]:
            c.raw(latlng(p), p.get("timestamp") or p.get("timestampMs"))
        return
    if isinstance(doc, dict) and "timelineObjects" in doc:  # Takeout, one month
        for o in doc["timelineObjects"]:
            if "placeVisit" in o:
                v = o["placeVisit"]
                d = v.get("duration", {})
                c.visit(latlng(v.get("location", {})), d.get("startTimestamp") or d.get("startTimestampMs"),
                        d.get("endTimestamp") or d.get("endTimestampMs"), v.get("location", {}).get("name", ""))
            elif "activitySegment" in o:
                a = o["activitySegment"]
                d = a.get("duration", {})
                start = d.get("startTimestamp") or d.get("startTimestampMs")
                raw = [(latlng(p), p.get("timestamp") or p.get("timestampMs")) for p in a.get("simplifiedRawPath", {}).get("points", [])]
                if raw:
                    c.path([(at, t) for at, t in raw if at], start)
                else:
                    pts = [latlng(a.get("startLocation", {}))] + [latlng(w) for w in a.get("waypointPath", {}).get("waypoints", [])] \
                        + [latlng(a.get("endLocation", {}))]
                    c.path([p for p in pts if p], start)
        return
    segments = doc.get("semanticSegments", []) if isinstance(doc, dict) else doc  # phone export: Android / iOS
    for s in segments or []:
        if not isinstance(s, dict):
            continue
        if "visit" in s:
            top = s["visit"].get("topCandidate", {})
            c.visit(latlng(top), s.get("startTime"), s.get("endTime"), top.get("semanticType", "").title().replace("_", " ")
                    if top.get("semanticType") not in (None, "UNKNOWN", "Unknown") else "")
        elif "timelinePath" in s:
            start = when(s.get("startTime"))
            pts = []
            for p in s["timelinePath"]:
                t = p.get("time")
                if t is None and start and "durationMinutesOffsetFromStartTime" in p:
                    t = (start[1].timestamp() + 60 * float(p["durationMinutesOffsetFromStartTime"])) * 1000
                pts.append((latlng(p), t))
            c.path([(at, t) for at, t in pts if at], s.get("startTime"))
        elif "activity" in s:
            a = s["activity"]
            c.path([p for p in (latlng(a.get("start")), latlng(a.get("end"))) if p], s.get("startTime"))


def load(paths):
    c = Collector()
    files = []
    for p in map(Path, paths):
        files += sorted(p.rglob("*.json")) if p.is_dir() else [p]
    for f in files:
        try:
            read(json.loads(f.read_text(encoding="utf-8")), c)
        except (ValueError, OSError) as e:
            print(f"skipped {f}: {e}", file=sys.stderr)
    return c.result()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", nargs="+", help="Timeline.json, Records.json, or a folder of Takeout files")
    data = Path(__file__).resolve().parent.parent / "data"  # Contrail's data folder in a checkout, else here
    ap.add_argument("--out", default=str(data / "timeline.json" if data.is_dir() else Path("timeline.json")))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp, e.g. mini:repos/contrail/data/timeline.json")
    args = ap.parse_args(argv)
    result = load(args.export)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, separators=(",", ":")))
    print(f"{len(result['visits'])} visits and {len(result['paths'])} paths written to {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
        print(f"sent to {args.send}")


if __name__ == "__main__":
    main()
