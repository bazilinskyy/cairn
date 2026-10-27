#!/usr/bin/env python3
"""Your Garmin activities in Cairn (the map's activities and explored tiles, the Sports tab), free of charge:

  export   your whole history, from Garmin's data export (garmin.com > Account > Data Management > Export Your Data:
           a zip, emailed within a few days); give the zip as it came, or its unpacked folder:
             uv run --with fitdecode python imports/garmin.py export ~/Downloads/<export>.zip
  login    sign in to Garmin Connect once (email, password, and the code if you use two-step verification); the
           token goes to ~/.garminconnect (readable by you only) and lasts about a year; the password is not kept:
             uv run --with garminconnect python imports/garmin.py login
  profile  your cycling FTP and weight from Garmin Connect, for the climbs (every sync does this too; each change
           is kept, as Garmin keeps no history of the cycling FTP)
  sync     new activities from Garmin Connect, with the sign-in token (run nightly by its LaunchAgent, see
           imports/install_garmin.sh); once a day it also lists everything again, so renamed, retyped and deleted
           activities follow. --all fetches every activity, a history without the export (slow: one file a second):
             uv run --with garminconnect --with fitdecode python imports/garmin.py sync

The sync uses the unofficial login (the python-garminconnect library), which Garmin does not sanction and which stops
working for a while when Garmin changes its sign-in; the export then still brings everything.
Writes data/garmin.json: {"activities": [...], "last_sync", "last_full"}, each activity as Cairn keeps Strava's
(id, name, sport, date, start, distance km, moving_time, elapsed_time, elevation, heartrate, trainer, path, at, tiles),
its route from the activity's own file, simplified to about 20 m, its explored tiles from the full track; "profile"
(FTP, weight). Every day's sleep, resting heart rate, steps, stress and Body Battery go to data/wellness.json
({"days": {"YYYY-MM-DD": {"rhr", "steps", "stress", "bb_max", "bb_min", "sleep" s, "deep", "light", "rem", "awake",
"bed", "wake" (UTC), "score"}}, "last_sync"}): the export brings them all, each sync the last days. Outdoor rides also get a timed track, data/tracks/<id>.json.gz (a point every 5 s with time, height,
power and heart rate), from which Cairn times the climbs you rode.
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

# Garmin's activity types (typeKey, or a FIT file's sport/sub_sport) -> (Strava's names, which Cairn groups by;
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


MAX_CLIMB_M_PER_KM = 250  # more climbing than this per km is a wrong unit, not a route (the steepest roads are 30-40%)


def tile_of(lat, lon):
    r = math.radians(lat)
    return math.floor((lon + 180) / 360 * TILES) * TILES + math.floor((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * TILES)


def tiles_of(pts):
    """Zoom-14 tiles a route passes through, as Cairn counts them (strava.js tilesOf): a point every ~200 m."""
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
    "ascent" m, "hr", "pts" [(lat, lon)], "track" [(time UTC, lat, lon, height m, power W, heart rate)]} or None when it
    is not an activity."""
    import fitdecode
    pts, track = [], []
    out = {"pts": pts, "track": track}
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.DISABLED) as fit:
        for frame in fit:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            get = lambda f: frame.get_value(f, fallback=None)  # noqa: E731
            if frame.name == "record":
                lat, lon = get("position_lat"), get("position_long")
                if lat is not None and lon is not None and (lat or lon):
                    pts.append((lat * SEMI, lon * SEMI))
                    alt = get("enhanced_altitude")
                    track.append((get("timestamp"), lat * SEMI, lon * SEMI, alt if alt is not None else get("altitude"),
                                  get("power"), get("heart_rate")))
            elif frame.name == "session" and "start" not in out:
                out.update(start=get("start_time"), sport=str(get("sport") or ""), sub_sport=str(get("sub_sport") or ""),
                           distance=get("total_distance"), moving=get("total_timer_time"), elapsed=get("total_elapsed_time"),
                           ascent=get("total_ascent"), hr=get("avg_heart_rate"))
            elif frame.name == "activity":
                ts, local = get("timestamp"), get("local_timestamp")
                if ts and local:
                    if isinstance(local, (int, float)):  # seconds since the FIT epoch, 1989-12-31
                        local = datetime(1989, 12, 31) + timedelta(seconds=local)
                    offset = local.replace(tzinfo=None) - ts.replace(tzinfo=None)
                    if abs(offset) <= timedelta(hours=14):  # Zwift and the like write a made-up local clock (1989, 2046)
                        out["local"] = offset
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


# --- one activity as Cairn keeps it ---

def ftp_of(summary):
    """The FTP set when the activity was done: Garmin's intensity factor is normalized power over it."""
    np_, if_ = (summary or {}).get("normPower"), (summary or {}).get("intensityFactor")
    return round(np_ / if_) if np_ and if_ and 0.2 < if_ < 2 else None


def to_activity(aid, name, type_key, start_utc, local_offset, distance_m, moving_s, elapsed_s, ascent_m, hr, pts, sub_sport="",
                ftp=None, vehicle=None):
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
        **({"ftp": ftp} if ftp else {}),
        **({"vehicle": vehicle} if vehicle and not indoor else {}),
    }


# --- a stop pressed too late: the end of a run, walk, hike or ride recorded in a car ---

VEHICLE = {"foot": (22, 120), "ride": (55, 300)}  # km/h held over each minute, for this many seconds, means a vehicle


def vehicle_part(f, sport):
    """The part of an activity done in a car, bus or train, if any: {"from_km", "from_time" (UTC ISO), "km", "minutes",
    "to_end"}. On foot: a minute-long average over 22 km/h for 2 minutes; on a bike: over 55 km/h for 5 minutes on a
    road that is not going down (a fast descent is not a car)."""
    kind = "ride" if re.search(r"Ride|Velomobile", sport or "") else "foot" if re.search(r"Run|Walk|Hike", sport or "") else None
    track = [p for p in (f or {}).get("track") or [] if p[0] is not None]
    if not kind or len(track) < 10:
        return None
    fast_kmh, hold = VEHICLE[kind]
    t = [(p[0] - track[0][0]).total_seconds() for p in track]
    d = [0.0]
    for a, b in zip(track, track[1:]):
        d.append(d[-1] + 6371000 * math.hypot(math.radians(b[1] - a[1]), math.radians(b[2] - a[2]) * math.cos(math.radians(a[1]))))
    fast, j = [False] * len(track), 0
    for i in range(len(track)):  # the minute starting at each point
        while j < len(track) - 1 and t[j] - t[i] < 60:
            j += 1
        if t[j] - t[i] >= 45:
            kmh = (d[j] - d[i]) / (t[j] - t[i]) * 3.6
            down = kind == "ride" and track[i][3] is not None and track[j][3] is not None and (track[j][3] - track[i][3]) / max(1, d[j] - d[i]) < -0.02
            fast[i] = kmh > fast_kmh and not down
    i = 0
    while i < len(track):  # the first run of fast minutes long enough
        if not fast[i]:
            i += 1
            continue
        k = i
        while k + 1 < len(track) and (fast[k + 1] or t[k + 1] - t[k] < 30):
            k += 1
        if t[k] - t[i] >= hold:
            rest = t[-1] - t[i]
            moving = sum(t[x + 1] - t[x] for x in range(i, len(track) - 1) if fast[x])
            return {"from_km": round(d[i] / 1000, 1), "from_time": track[i][0].astimezone(timezone.utc).isoformat()[:19] + "Z",
                    "km": round((d[-1] - d[i]) / 1000, 1), "minutes": round(rest / 60), "to_end": moving > 0.6 * rest}
        i = k + 1
    return None


def send_discord(text):
    """A message to the alerts channel (flightmail's Discord webhook, in secret)."""
    import urllib.request
    try:
        url = json.loads((HERE.parent / "secret").read_text()).get("flightmail", {}).get("discord_webhook")
    except (OSError, ValueError):
        url = None
    if url:
        req = urllib.request.Request(url, json.dumps({"content": text[:1900]}).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "cairn-garmin"})
        urllib.request.urlopen(req, timeout=20).close()


def vehicle_alert(act):
    v = act.get("vehicle")
    when = act["date"][:16].replace("T", " ")
    return (f"**{act['name']}** ({act['sport']}, {when}) looks like it went on in a car: from {v['from_km']} km on, "
            f"{v['km']} km in {v['minutes']} min at car speed{' until the end' if v['to_end'] else ''}. Forgot to press stop? "
            f"Trim it in Garmin Connect: https://connect.garmin.com/modern/activity/{act['id']}")


# --- timed tracks of rides: when you passed where, for climbs (Cairn's climbs.js times each way up you rode) ---

TRACK_STEP = 5  # seconds between the points kept


def write_track(folder, aid, f):
    """An outdoor ride's track into folder/<id>.json.gz: {"start": UTC seconds, "t": [s after start], "path": encoded
    positions, "alt": [m], "pw": [W], "hr": [bpm]}, a point every 5 s. Other activities: nothing."""
    import gzip
    track = (f or {}).get("track") or []
    if not folder or len(track) < 2 or "cycling" not in (f.get("sport") or "") or re.search(r"virtual|indoor|trainer", f.get("sub_sport") or ""):
        return
    t0, kept, last = track[0][0], [], None
    for p in track:
        if p[0] is None:
            continue
        s = (p[0] - t0).total_seconds()
        if last is None or s - last >= TRACK_STEP or p is track[-1]:
            kept.append((s, *p[1:]))
            last = s
    num = lambda v: None if v is None else round(v)  # noqa: E731
    doc = {"start": int(t0.replace(tzinfo=timezone.utc).timestamp()), "t": [round(p[0]) for p in kept],
           "path": encode([(p[1], p[2]) for p in kept]), "alt": [num(p[3]) for p in kept], "pw": [num(p[4]) for p in kept],
           "hr": [num(p[5]) for p in kept]}
    Path(folder).mkdir(parents=True, exist_ok=True)
    with gzip.open(Path(folder) / f"{int(aid)}.json.gz", "wt") as out:
        json.dump(doc, out, separators=(",", ":"))


def ms_time(v):
    """A summary's time: ms since 1970 (or an ISO string) -> naive datetime."""
    if isinstance(v, (int, float)):
        return datetime(1970, 1, 1) + timedelta(milliseconds=v)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "")[:19].replace(" ", "T"))
    except ValueError:
        return None


def from_export(paths, log=print, tracks=None):
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
        key = aid or -int(start.replace(tzinfo=timezone.utc).timestamp())
        a = sums.get(aid, {})
        type_key = (a.get("activityType") or {}).get("typeKey") if isinstance(a.get("activityType"), dict) else a.get("activityType")
        f["vehicle"] = vehicle_part(f, sport_of(type_key or f.get("sport"), f.get("sub_sport"))[0])
        write_track(tracks, abs(key), f)
        f.pop("track", None)  # written: thousands of them would not fit in memory
        fits[key] = f
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
        ascent = val("ascent", "elevationGain")
        km = (val("distance", "distance") or 0) / 1000
        if ascent and km > 1 and ascent / km > MAX_CLIMB_M_PER_KM:  # some files give it in centimetres: 41,737 m on a 149 km ride
            ascent = a["elevationGain"] * med["elevationGain"] if a.get("elevationGain") and a["elevationGain"] * med["elevationGain"] / km <= MAX_CLIMB_M_PER_KM else ascent / 100
        out.append(to_activity(aid if aid > 0 else -aid, a.get("name"), type_key or f.get("sport"), start, local,
                                val("distance", "distance"), moving or val("elapsed", "duration"), val("elapsed", "duration"),
                                ascent, f.get("hr") or a.get("avgHr"), f.get("pts", []), f.get("sub_sport", ""),
                                ftp_of(a), f.get("vehicle")))
    return out


# --- Garmin Connect ---

def connect():
    from garminconnect import Garmin
    g = Garmin()
    g.login(tokenstore=str(TOKENS))
    return g


def from_connect_item(g, item, fetch_file=True, tracks=None):
    """An activity of Garmin Connect's list, its route from its original file."""
    f = {}
    if fetch_file:
        try:  # an activity entered by hand has no file (Garmin answers 404): kept without a route
            raw = g.download_activity(str(item["activityId"]), dl_fmt=g.ActivityDownloadFormat.ORIGINAL)
        except Exception as e:
            if "404" not in str(e):
                raise
            raw = b""
        time.sleep(PAUSE)
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                name = next((n for n in z.namelist() if n.lower().endswith(".fit")), None)
                f = read_fit(z.read(name)) or {} if name else {}
        except zipfile.BadZipFile:
            f = (read_fit(raw) or {}) if raw else {}
        write_track(tracks, item["activityId"], f)
    start = datetime.fromisoformat(item["startTimeGMT"].replace(" ", "T"))
    local = datetime.fromisoformat(item["startTimeLocal"].replace(" ", "T")) - start
    t = item.get("activityType") or {}
    vehicle = vehicle_part(f, sport_of(t.get("typeKey"), f.get("sub_sport", ""))[0]) if f else None
    return to_activity(item["activityId"], item.get("activityName"), t.get("typeKey"), start, local, item.get("distance"),
                       item.get("movingDuration") or item.get("duration"), item.get("elapsedDuration") or item.get("duration"),
                       item.get("elevationGain"), item.get("averageHR"), f.get("pts", []), f.get("sub_sport", ""), ftp_of(item), vehicle)


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


def sync(data, everything=False, log=print, save=None, tracks=None):
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
        acts[aid] = from_connect_item(g, item, tracks=tracks)
        added += 1
        if acts[aid].get("vehicle"):  # a stop pressed too late: to the alerts channel
            log(vehicle_alert(acts[aid]))
            try:
                send_discord(vehicle_alert(acts[aid]))
            except Exception as e:
                log(f"alert not sent: {e.__class__.__name__}: {e}")
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
        try:  # once a day: every weigh-in, for your weight on the day of a climb
            data.setdefault("profile", {})["weights"] = weights(g)
        except Exception as e:
            log(f"weights not read: {e.__class__.__name__}: {e}")

    try:  # every sync: FTP and weight (two small requests), for the climbs
        data["profile"] = profile(g, data.get("profile"))
    except Exception as e:  # nice to have: the activities matter more
        log(f"profile not read: {e.__class__.__name__}: {e}")
    data["activities"] = sorted(acts.values(), key=lambda a: -a["start"])
    data["last_sync"] = now.isoformat()
    log(f"{added} new activities, {len(acts)} in all")
    return data


def profile(g, before=None):
    """Your cycling FTP and weight as Garmin Connect knows them now, for the climbs: {"ftp" W, "ftp_date", "weight" kg,
    "weight_date", "history": [["YYYY-MM-DD", FTP W, weight kg], ...]}. Garmin keeps no history of the cycling FTP (only
    the running one), so each change seen here is added to the history kept from before."""
    out = dict(before or {})
    f = g.get_cycling_ftp() or {}
    f = f[0] if isinstance(f, list) and f else f
    if f.get("functionalThresholdPower"):
        out.update(ftp=f["functionalThresholdPower"], ftp_date=str(f.get("calendarDate", ""))[:10])
    w = g.get_latest_weight() or {}
    if w.get("weight"):
        out.update(weight=round(w["weight"] / 1000, 1),
                   weight_date=datetime.fromtimestamp(w["date"] / 1000, timezone.utc).strftime("%Y-%m-%d") if w.get("date") else "")
    hist = [h for h in out.get("history", []) if isinstance(h, list)]
    now = [out.get("ftp_date") or datetime.now().strftime("%Y-%m-%d"), out.get("ftp"), out.get("weight")]
    if out.get("ftp") and (not hist or hist[-1][1:] != now[1:]):
        hist.append(now)
    out["history"] = hist
    out.pop("ftp_history", None)
    return out


def weights(g, since="2000-01-01"):
    """Every weigh-in Garmin Connect has: [["YYYY-MM-DD", kg], ...], oldest first."""
    r = g.get_body_composition(since, datetime.now().strftime("%Y-%m-%d")) or {}
    days = {}
    for w in (r.get("dateWeightList") if isinstance(r, dict) else r) or []:
        if w.get("weight") and w.get("calendarDate"):
            days[str(w["calendarDate"])[:10]] = round(w["weight"] / 1000, 1)
    return sorted([d, kg] for d, kg in days.items())


# --- days: sleep, resting heart rate, steps, stress and Body Battery (data/wellness.json) ---

def _day(uds=None, sleep=None):
    """One day as Cairn keeps it, from Garmin's daily summary (export UDSFile or Connect's user summary) and sleep."""
    out = {}
    if uds:
        stress = uds.get("allDayStress") or {}
        total = next((a for a in stress.get("aggregatorList", []) if a.get("type") == "TOTAL"), {}) if isinstance(stress, dict) else {}
        bb = {b.get("bodyBatteryStatType"): b.get("statsValue") for b in ((uds.get("bodyBattery") or {}).get("bodyBatteryStatList") or [])}
        out.update(rhr=uds.get("restingHeartRate"), steps=uds.get("totalSteps"),
                   stress=total.get("averageStressLevel", uds.get("averageStressLevel")),
                   bb_max=bb.get("HIGHEST", uds.get("bodyBatteryHighestValue")), bb_min=bb.get("LOWEST", uds.get("bodyBatteryLowestValue")))
    if sleep and (sleep.get("sleepStartTimestampGMT") or sleep.get("sleepTimeSeconds")):
        stages = {k: sleep.get(f"{k}SleepSeconds") for k in ("deep", "light", "rem", "awake")}
        asleep = sleep.get("sleepTimeSeconds") or sum(v or 0 for k, v in stages.items() if k != "awake")
        score = sleep.get("sleepScores") or {}
        score = score.get("overallScore") or (score.get("overall") or {}).get("value")
        gmt = lambda v: (datetime.fromtimestamp(v / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M") if isinstance(v, (int, float))  # noqa: E731
                         else str(v)[:16]) if v else None
        out.update(sleep=asleep or None, deep=stages["deep"], light=stages["light"], rem=stages["rem"], awake=stages["awake"],
                   bed=gmt(sleep.get("sleepStartTimestampGMT")), wake=gmt(sleep.get("sleepEndTimestampGMT")), score=score)
    return {k: v for k, v in out.items() if v is not None}


def wellness_from_export(paths):
    """{"YYYY-MM-DD": day} from the export's daily summaries (DI-Connect-Aggregator/UDSFile_*.json) and sleep
    (DI-Connect-Wellness/*_sleepData.json)."""
    uds, sleep = {}, {}

    def take(name, data):
        rows = json.loads(data)
        if "UDSFile_" in name:
            uds.update({r["calendarDate"]: r for r in rows if r.get("calendarDate")})
        elif name.endswith("_sleepData.json"):
            sleep.update({r["calendarDate"]: r for r in rows if r.get("calendarDate")})
    wanted = lambda n: "UDSFile_" in n or n.endswith("_sleepData.json")  # noqa: E731
    for p in map(Path, paths):
        if p.is_dir():
            for f in p.rglob("*.json"):
                if wanted(f.name):
                    take(f.name, f.read_bytes())
        elif zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                for n in z.namelist():
                    if wanted(n):
                        take(n, z.read(n))
    days = {d: _day(uds.get(d), sleep.get(d)) for d in set(uds) | set(sleep)}
    return {d: v for d, v in days.items() if v}


def wellness_from_connect(g, known, log=print, most=14):
    """The days since the last one known (at most `most`, today included) from Garmin Connect: two requests a day."""
    today = datetime.now().date()
    last = max(known, default=None)
    start = max(today - timedelta(days=most - 1), (datetime.strptime(last, "%Y-%m-%d").date() - timedelta(days=1)) if last else today - timedelta(days=most - 1))
    out, d = {}, start
    while d <= today:
        day = d.isoformat()
        try:
            summary = g.get_user_summary(day) or {}
            sleep = (g.get_sleep_data(day) or {}).get("dailySleepDTO") or {}
            got = _day(summary, sleep)
            if got:
                out[day] = got
        except Exception as e:  # one day missing is no reason to lose the others
            log(f"wellness {day} not read: {e.__class__.__name__}: {e}")
        d += timedelta(days=1)
    return out


def save_wellness(file, days, synced=False):
    data = json.loads(file.read_text()) if file.exists() else {"days": {}}
    data["days"].update(days)
    data["days"] = dict(sorted(data["days"].items()))
    if synced:
        data["last_sync"] = datetime.now(timezone.utc).isoformat()
    tmp = file.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    tmp.replace(file)
    return len(data["days"])


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
    ap.add_argument("command", choices=["export", "login", "sync", "profile"])
    ap.add_argument("paths", nargs="*", help="export: the export zip(s) or folder")
    ap.add_argument("--all", action="store_true", help="sync: fetch every activity, not only new ones")
    data_dir = HERE.parent / "data"
    ap.add_argument("--out", default=str(data_dir / "garmin.json" if data_dir.is_dir() else Path("garmin.json")))
    args = ap.parse_args(argv)
    if args.command == "login":
        return login()
    out = Path(args.out)
    tracks = out.parent / "tracks"  # timed tracks of rides, for climbs
    wellness = out.parent / "wellness.json"  # sleep, resting heart rate, steps, stress, Body Battery per day
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
        fresh = from_export(args.paths, log, tracks)
        lock = open(out.with_suffix(".lock"), "w")
        fcntl.flock(lock, fcntl.LOCK_EX)  # read the file again after a sync ends, so what it saved meanwhile stays
        data = json.loads(out.read_text()) if out.exists() else {"activities": []}
        acts = {a["id"]: a for a in data.get("activities", [])}
        acts.update({a["id"]: a for a in fresh})
        data["activities"] = sorted(acts.values(), key=lambda a: -a["start"])
        log(f"{len(fresh)} activities from the export, {len(acts)} in all")
        days = wellness_from_export(args.paths)
        if days:
            log(f"{len(days)} days of sleep and resting heart rate from the export, {save_wellness(wellness, days)} in all")
    else:
        # one sync at a time: a nightly run that meets a long --all one (or the reverse) leaves it be
        lock = open(out.with_suffix(".lock"), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another sync is running; skipped")
            return 0
        try:
            if args.command == "profile":
                g = connect()
                data["profile"] = profile(g, data.get("profile"))
                data["profile"]["weights"] = weights(g)
                log(f"profile: {data['profile'].get('ftp')} W, {data['profile'].get('weight')} kg")
            else:
                data = sync(data, args.all, log, save, tracks)
                try:  # the last days' sleep and resting heart rate (nice to have: the activities matter more)
                    known = json.loads(wellness.read_text()).get("days", {}) if wellness.exists() else {}
                    days = wellness_from_connect(connect(), known, log)
                    log(f"{len(days)} days of sleep and resting heart rate, {save_wellness(wellness, days, synced=True)} in all")
                except Exception as e:
                    log(f"wellness not read: {e.__class__.__name__}: {e}")
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
