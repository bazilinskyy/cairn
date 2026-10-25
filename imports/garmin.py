#!/usr/bin/env python3
"""Your Garmin activities in Contrail (the map's activities and explored tiles, the Sports tab), free of charge:

  export   your whole history, from Garmin's data export (garmin.com > Account > Data Management > Export Your Data:
           a zip, emailed within a few days); give the zip as it came, or its unpacked folder:
             uv run --with fitdecode python imports/garmin.py export ~/Downloads/<export>.zip
  login    sign in to Garmin Connect once (email, password, and the code if you use two-step verification); the
           token goes to ~/.garminconnect (readable by you only) and lasts about a year; the password is not kept:
             uv run --with garminconnect python imports/garmin.py login
  sync     new activities from Garmin Connect, with the sign-in token (run hourly by its LaunchAgent, see
           imports/install_garmin.sh); once a day it also lists everything again, so renamed, retyped and deleted
           activities follow. --all fetches every activity, a history without the export (slow: one file a second):
             uv run --with garminconnect --with fitdecode python imports/garmin.py sync

The sync uses the unofficial login (the python-garminconnect library), which Garmin does not sanction and which stops
working for a while when Garmin changes its sign-in; the export then still brings everything.
Writes data/garmin.json: {"activities": [...], "last_sync", "last_full"}, each activity as Contrail keeps Strava's
(id, name, sport, date, start, distance km, moving_time, elapsed_time, elevation, heartrate, trainer, path, at, tiles),
its route from the activity's own file, simplified to about 20 m, its explored tiles from the full track.
"""
import argparse
import fcntl
import io
import json
import math
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from timeline import encode, simplify  # noqa: E402

TOKENS = Path(os.environ.get("GARMINTOKENS", "~/.garminconnect")).expanduser()
TILES = 2 ** 14
SEMI = 180 / 2 ** 31   # FIT positions are in semicircles
EPS = 0.0002           # route simplification, degrees: about 20 m
FULL_EVERY = timedelta(days=1)
RECENT = timedelta(days=30)  # a plain sync fetches the files of unknown activities this far back from the newest known
PAUSE = 1.0            # seconds between Garmin Connect requests

# Garmin's activity types (typeKey, or a FIT file's sport/sub_sport) -> (Strava's names, which Contrail groups by;
# indoor: no route to expect)
SPORTS = [
    (r"virtual|indoor_cycling|spin", "VirtualRide", True), (r"gravel", "GravelRide", False),
    (r"mountain", "MountainBikeRide", False), (r"e_bike|ebike|e_mountain", "EBikeRide", False),
    (r"cycl|biking|bike|road", "Ride", False),
    (r"treadmill|indoor_running", "Run", True), (r"trail", "TrailRun", False), (r"run", "Run", False),
    (r"hik", "Hike", False), (r"walk", "Walk", False),
    (r"lap_swim|pool", "Swim", True), (r"swim", "Swim", False),
    (r"ski", "AlpineSki", False), (r"row", "Rowing", False), (r"kayak|canoe|paddl|sup", "Kayaking", False),
]


def sport_of(*keys):
    """Strava's sport name and indoor flag for Garmin's type keys, the most specific first."""
    text = " ".join(k for k in keys if k).lower()
    for rx, name, indoor in SPORTS:
        if re.search(rx, text):
            return name, indoor
    return (keys[0] or "Workout").replace("_", " ").title().replace(" ", ""), False


def tile_of(lat, lon):
    r = math.radians(lat)
    return math.floor((lon + 180) / 360 * TILES) * TILES + math.floor((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * TILES)


def tiles_of(pts):
    """Zoom-14 tiles a route passes through, as Contrail counts them (strava.js tilesOf): a point every ~200 m."""
    out = set()
    for i, b in enumerate(pts):
        a = pts[max(0, i - 1)]
        steps = max(1, math.ceil(math.hypot(b[0] - a[0], (b[1] - a[1]) * math.cos(math.radians(a[0]))) / 0.002))
        for s in range(1, steps + 1):
            out.add(tile_of(a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps))
    return sorted(out)


# --- activity files (FIT) ---

def read_fit(data):
    """A FIT activity file: {"start" (UTC), "local" (offset), "sport", "sub_sport", "distance" m, "moving" s, "elapsed" s,
    "ascent" m, "hr", "pts" [(lat, lon)]} or None when it is not an activity."""
    import fitdecode
    pts = []
    out = {"pts": pts}
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.DISABLED) as fit:
        for frame in fit:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            get = lambda f: frame.get_value(f, fallback=None)  # noqa: E731
            if frame.name == "record":
                lat, lon = get("position_lat"), get("position_long")
                if lat is not None and lon is not None and (lat or lon):
                    pts.append((lat * SEMI, lon * SEMI))
            elif frame.name == "session" and "start" not in out:
                out.update(start=get("start_time"), sport=str(get("sport") or ""), sub_sport=str(get("sub_sport") or ""),
                           distance=get("total_distance"), moving=get("total_timer_time"), elapsed=get("total_elapsed_time"),
                           ascent=get("total_ascent"), hr=get("avg_heart_rate"))
            elif frame.name == "activity":
                ts, local = get("timestamp"), get("local_timestamp")
                if ts and local:
                    if isinstance(local, (int, float)):  # seconds since the FIT epoch, 1989-12-31
                        local = datetime(1989, 12, 31) + timedelta(seconds=local)
                    out["local"] = local.replace(tzinfo=None) - ts.replace(tzinfo=None)
    return out if out.get("start") else None


def fit_files(paths):
    """(file name, bytes) of every .fit file in these zips (also in zips inside them) and folders."""
    def walk_zip(z):
        for name in z.namelist():
            low = name.lower()
            if low.endswith(".fit"):
                yield name, z.read(name)
            elif low.endswith(".zip"):
                with zipfile.ZipFile(io.BytesIO(z.read(name))) as inner:
                    yield from walk_zip(inner)
    for p in map(Path, paths):
        if p.is_dir():
            for f in p.rglob("*"):
                if f.suffix.lower() == ".fit":
                    yield f.name, f.read_bytes()
                elif f.suffix.lower() == ".zip":
                    with zipfile.ZipFile(f) as z:
                        yield from walk_zip(z)
        elif zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                yield from walk_zip(z)
        elif p.suffix.lower() == ".fit":
            yield p.name, p.read_bytes()


def summaries(paths):
    """Garmin's activity summaries in the export (DI-Connect-Fitness/*summarizedActivities*.json): their dicts."""
    def docs():
        for p in map(Path, paths):
            if p.is_dir():
                for f in p.rglob("*ummarizedActivities*.json"):
                    yield f.read_bytes()
            elif zipfile.is_zipfile(p):
                with zipfile.ZipFile(p) as z:
                    for name in z.namelist():
                        if "ummarizedactivities" in name.lower() and name.lower().endswith(".json"):
                            yield z.read(name)
    for raw in docs():
        doc = json.loads(raw)
        for part in doc if isinstance(doc, list) else [doc]:
            items = part.get("summarizedActivitiesExport", []) if isinstance(part, dict) else [part]
            for a in items:
                if isinstance(a, dict) and a.get("activityId"):
                    yield a


# --- one activity as Contrail keeps it ---

def to_activity(aid, name, type_key, start_utc, local_offset, distance_m, moving_s, elapsed_s, ascent_m, hr, pts, sub_sport=""):
    sport, indoor = sport_of(type_key, sub_sport)
    if indoor:  # a trainer, a treadmill, or Zwift's made-up world: no route, tiles or place of its own
        pts = []
    local = start_utc + (local_offset or timedelta(0))
    simple = simplify(pts, EPS) if len(pts) > 2 else pts
    return {
        "id": int(aid), "name": name or f"{sport} {local:%Y-%m-%d}", "sport": sport, "source": "garmin",
        "date": f"{local:%Y-%m-%d %H:%M:%S}", "start": int(start_utc.replace(tzinfo=timezone.utc).timestamp()),
        "distance": round((distance_m or 0) / 1000, 1), "moving_time": round(moving_s or 0), "elapsed_time": round(elapsed_s or moving_s or 0),
        "elevation": round(ascent_m or 0), "heartrate": round(hr) if hr else None, "prs": 0, "kudos": 0, "commute": False,
        "trainer": indoor or not pts, "path": encode(simple) if len(simple) > 1 else "",
        "at": [round(pts[0][0], 5), round(pts[0][1], 5)] if pts else None, "tiles": tiles_of(pts) if len(pts) > 1 else [],
    }


def ms_time(v):
    """A summary's time: ms since 1970 (or an ISO string) -> naive datetime."""
    if isinstance(v, (int, float)):
        return datetime(1970, 1, 1) + timedelta(milliseconds=v)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "")[:19].replace(" ", "T"))
    except ValueError:
        return None


def from_export(paths, log=print):
    """Every activity of a Garmin export: the summaries for name and type, each activity's file for its route and
    numbers. Summaries count distance and time in their own units (cm, ms in exports seen so far): the factors are
    measured against the files of activities that have both."""
    sums = {int(a["activityId"]): a for a in summaries(paths)}
    by_start = {}
    for aid, a in sums.items():
        t = ms_time(a.get("startTimeGmt") or a.get("beginTimestamp"))
        if t:
            by_start[t.replace(second=0, microsecond=0)] = aid
    fits, n = {}, 0
    for name, data in fit_files(paths):
        n += 1
        try:
            f = read_fit(data)
        except Exception as e:  # a file of another kind (settings, monitoring) or a broken one
            log(f"skipped {name}: {e.__class__.__name__}")
            continue
        if not f:
            continue
        start = f["start"].replace(tzinfo=None)
        ids = [int(x) for x in re.findall(r"\d{8,}", name) if int(x) in sums]
        aid = ids[0] if ids else next((by_start[k] for k in (start.replace(second=0, microsecond=0) + timedelta(minutes=d) for d in (0, -1, 1))
                                       if k in by_start), None)
        fits[aid or -int(start.replace(tzinfo=timezone.utc).timestamp())] = f
    log(f"{len(sums)} activity summaries, {n} activity files ({len(fits)} read)")
    factor = {"distance": [], "duration": [], "elevationGain": []}
    for aid, f in fits.items():
        a = sums.get(aid)
        for key, fit_key in (("distance", "distance"), ("duration", "elapsed"), ("elevationGain", "ascent")):
            if a and a.get(key) and f.get(fit_key):
                factor[key].append(f[fit_key] / a[key])
    med = {k: sorted(v)[len(v) // 2] if v else d for (k, v), d in zip(factor.items(), (0.01, 0.001, 0.01))}
    out = []
    for aid in set(sums) | set(fits):  # a file matched to no summary has a negative key: minus its start time
        a, f = sums.get(aid, {}), fits.get(aid, {})
        type_key = (a.get("activityType") or {}).get("typeKey") if isinstance(a.get("activityType"), dict) else a.get("activityType") or a.get("sportType")
        start = f.get("start").replace(tzinfo=None) if f.get("start") else ms_time(a.get("startTimeGmt") or a.get("beginTimestamp"))
        if not start:
            continue
        local = f.get("local") or ((ms_time(a["startTimeLocal"]) - start) if a.get("startTimeLocal") else None)
        val = lambda fk, sk: f.get(fk) if f.get(fk) is not None else (a[sk] * med[sk] if a.get(sk) is not None else None)  # noqa: E731
        moving = f.get("moving") if f.get("moving") is not None else (a["movingDuration"] * med["duration"] if a.get("movingDuration") else None)
        out.append(to_activity(aid if aid > 0 else -aid, a.get("name"), type_key or f.get("sport"), start, local,
                                val("distance", "distance"), moving or val("elapsed", "duration"), val("elapsed", "duration"),
                                val("ascent", "elevationGain"), f.get("hr") or a.get("avgHr"), f.get("pts", []), f.get("sub_sport", "")))
    return out


# --- Garmin Connect ---

def connect():
    from garminconnect import Garmin
    g = Garmin()
    g.login(tokenstore=str(TOKENS))
    return g


def from_connect_item(g, item, fetch_file=True):
    """An activity of Garmin Connect's list, its route from its original file."""
    f = {}
    if fetch_file:
        raw = g.download_activity(str(item["activityId"]), dl_fmt=g.ActivityDownloadFormat.ORIGINAL)
        time.sleep(PAUSE)
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                name = next((n for n in z.namelist() if n.lower().endswith(".fit")), None)
                f = read_fit(z.read(name)) or {} if name else {}
        except zipfile.BadZipFile:
            f = read_fit(raw) or {}
    start = datetime.fromisoformat(item["startTimeGMT"].replace(" ", "T"))
    local = datetime.fromisoformat(item["startTimeLocal"].replace(" ", "T")) - start
    t = item.get("activityType") or {}
    return to_activity(item["activityId"], item.get("activityName"), t.get("typeKey"), start, local, item.get("distance"),
                       item.get("movingDuration") or item.get("duration"), item.get("elapsedDuration") or item.get("duration"),
                       item.get("elevationGain"), item.get("averageHR"), f.get("pts", []), f.get("sub_sport", ""))


def listing(g, stop_at=None):
    """Garmin Connect's activities, newest first, page by page; stops at the first one already known (stop_at)."""
    start = 0
    while True:
        page = g.get_activities(start, 100)
        time.sleep(PAUSE)
        if not page:
            return
        for item in page:
            if stop_at and item["activityId"] in stop_at:
                return
            yield item
        start += len(page)


def sync(data, everything=False, log=print, save=None):
    """New activities into data; once a day (and with everything, which also fetches every activity not yet known) the
    whole list, for renamed, retyped and deleted ones."""
    g = connect()
    acts = {a["id"]: a for a in data.get("activities", [])}
    now = datetime.now(timezone.utc)
    full = everything or not data.get("last_full") or now - datetime.fromisoformat(data["last_full"]) > FULL_EVERY
    # older unknown activities are the export's (or --all's) to bring: a first sync does not download a whole history
    newest = max((a["start"] for a in acts.values()), default=now.timestamp())
    cutoff = 0 if everything else newest - RECENT.total_seconds()
    seen, added = set(), 0
    for item in listing(g, None if full else set(acts)):
        aid = item["activityId"]
        seen.add(aid)
        known = acts.get(aid)
        if known:  # met again in a full listing: only its name and type can have changed
            known.update({k: v for k, v in from_connect_item(g, item, fetch_file=False).items() if k in ("name", "sport")})
            continue
        if datetime.fromisoformat(item["startTimeGMT"].replace(" ", "T")).replace(tzinfo=timezone.utc).timestamp() < cutoff:
            continue
        acts[aid] = from_connect_item(g, item)
        added += 1
        if save and added % 20 == 0:  # a long first sync keeps what it has
            data["activities"] = sorted(acts.values(), key=lambda a: -a["start"])
            save(data)
    if full:
        log(f"{len(seen)} activities on Garmin Connect")
        gone = [aid for aid, a in acts.items() if a.get("source") == "garmin" and aid not in seen]  # only what was listed
        if gone and len(gone) <= max(10, len(seen) // 10):  # an answer with half the list missing is not a reason to delete
            for aid in gone:
                del acts[aid]
            log(f"{len(gone)} deleted on Garmin Connect")
        data["last_full"] = now.isoformat()
    data["activities"] = sorted(acts.values(), key=lambda a: -a["start"])
    data["last_sync"] = now.isoformat()
    log(f"{added} new activities, {len(acts)} in all")
    return data


def login():
    import getpass
    from garminconnect import Garmin
    email = input("Garmin Connect email: ").strip()
    g = Garmin(email, getpass.getpass("Password (not stored): "), prompt_mfa=lambda: input("Two-step verification code: ").strip())
    TOKENS.mkdir(mode=0o700, parents=True, exist_ok=True)
    g.login(tokenstore=str(TOKENS))
    for f in TOKENS.iterdir():
        f.chmod(0o600)
    print(f"Signed in as {g.get_full_name() or email}; token in {TOKENS}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["export", "login", "sync"])
    ap.add_argument("paths", nargs="*", help="export: the export zip(s) or folder")
    ap.add_argument("--all", action="store_true", help="sync: fetch every activity, not only new ones")
    data_dir = HERE.parent / "data"
    ap.add_argument("--out", default=str(data_dir / "garmin.json" if data_dir.is_dir() else Path("garmin.json")))
    args = ap.parse_args(argv)
    if args.command == "login":
        return login()
    out = Path(args.out)
    data = json.loads(out.read_text()) if out.exists() else {"activities": []}
    stamp = lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S")  # noqa: E731
    log = lambda m: print(f"{stamp()} {m}", flush=True)  # noqa: E731

    def save(d):
        tmp = out.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, separators=(",", ":")))
        tmp.replace(out)

    if args.command == "export":
        if not args.paths:
            ap.error("export: give the export zip or folder")
        acts = {a["id"]: a for a in data.get("activities", [])}
        fresh = from_export(args.paths, log)
        acts.update({a["id"]: a for a in fresh})
        data["activities"] = sorted(acts.values(), key=lambda a: -a["start"])
        log(f"{len(fresh)} activities from the export, {len(acts)} in all")
    else:
        # one sync at a time: an hourly run that meets a long --all one (or the reverse) leaves it be
        lock = open(out.with_suffix(".lock"), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another sync is running; skipped")
            return 0
        try:
            data = sync(data, args.all, log, save)
        except Exception as e:  # signed out, Garmin's sign-in changed, rate limit: logged; the next hour tries again
            log(f"sync failed: {e.__class__.__name__}: {e}")
            data["error"] = f"{e.__class__.__name__}: {e}"[:300]
            data["error_at"] = datetime.now(timezone.utc).isoformat()
            save(data)
            return 1
        data.pop("error", None)
        data.pop("error_at", None)
    save(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
