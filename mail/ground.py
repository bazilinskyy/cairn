"""Trains, buses and ferries: legs from booking emails, and station time zones from GeoNames towns.

Operators are recognised by sender (or by schema.org BusReservation / TrainReservation / BoatReservation markup);
each has a small rule. A station's time zone comes from the biggest GeoNames town whose name starts the station
name ("Bruxelles Midi" -> Brussels), else the home time zone.
"""
import csv
import re
import unicodedata
from datetime import datetime, timedelta

from parse import DATE_RX, Leg, TIME_RX, _dates, reservations

MODES = {"BusReservation": "bus", "TrainReservation": "train", "BoatReservation": "ferry"}
SENDERS = {  # sender domain part -> mode
    "nsinternational": "train", "ns.nl": "train", "sncf": "train", "bahn": "train", "eurostar": "train",
    "trainline": "train", "thalys": "train", "renfe": "train", "cp.pt": "train", "oebb": "train", "sbb": "train",
    "flixbus": "bus", "flix.com": "bus", "redbus": "bus", "rnetickets": "bus", "rede-expressos": "bus",
    "alsa": "bus", "blablacar": "bus", "12go": "bus", "nuego": "bus",
    "ferry": "ferry", "directferries": "ferry", "atlanticoline": "ferry", "stenaline": "ferry", "dfds": "ferry",
}
CITIES_URL = "https://download.geonames.org/export/dump/cities1000.zip"


def _norm(s):
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().lower()


def load_cities(path):
    """GeoNames cities1000.txt: normalised town name (and alternate names of towns over 20,000) -> time zone,
    the most populous town winning."""
    best = {}
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(row) < 18 or not row[17]:
                continue
            pop = int(row[14] or 0)
            names = {row[1], row[2]} | (set(row[3].split(",")) if pop >= 20000 else set())
            for n in names:
                k = _norm(n)
                if k and pop > best.get(k, (-1, ""))[0]:
                    best[k] = (pop, row[17])
    return {k: tz for k, (_, tz) in best.items()}


def station_tz(name, cities, home_tz):
    """Time zone of a station: the longest leading run of words that is a known town."""
    for part in re.split(r"\s+-\s+|,|\(", name or ""):
        words = _norm(part).split(" ")
        for n in range(len(words), 0, -1):
            tz = cities.get(" ".join(words[:n]))
            if tz:
                return tz
    return home_tz


def mode_of(sender, html):
    """train / bus / ferry when this email is a ground booking, else None."""
    for r in reservations(html, tuple(MODES)) if html else []:
        return MODES[r["@type"]]
    s = sender.lower()
    return next((m for k, m in SENDERS.items() if k in s), None)


def _clean(name):
    name = re.sub(r",?\s*departure time:[^)]*", "", name or "").strip()
    return re.sub(r"\s*\(\s*\)", "", name).strip()


def _clock(value):
    """Local clock time from an ISO time, ignoring its offset (some operators send a wrong one)."""
    try:
        return datetime.fromisoformat(value.strip()[:19])
    except (AttributeError, ValueError):
        return None


def _leg(mode, service, dep, arr, t0, t1, cities, home_tz, codes=(), dep_place="", arr_place=""):
    guess = t1 is None and t0 is not None
    if guess:
        t1 = t0 + timedelta(hours=1)
    elif t0 and t1 and t1 <= t0:
        t1 += timedelta(days=1)
    return Leg(re.sub(r"\s+", "", service or ""), dep, arr, t0, t1, tuple(codes), "", t0.date() if t0 else None, mode,
               station_tz(dep_place or dep, cities, home_tz), station_tz(arr_place or arr, cities, home_tz), guess)


def _markup(html, mode, cities, home_tz):
    out = []
    for r in reservations(html, tuple(MODES)):
        f = r.get("reservationFor") or {}
        m = MODES.get(r.get("@type"), mode)
        stops = {"bus": ("departureBusStop", "arrivalBusStop"), "train": ("departureStation", "arrivalStation"),
                 "ferry": ("departureBoatTerminal", "arrivalBoatTerminal")}[m]
        dep, arr = (f.get(k) or {} for k in stops)
        service = str(f.get("trainNumber") or "") if m == "train" else ""
        code = str(r.get("reservationNumber") or "").strip()
        out.append(_leg(m, service, _clean(dep.get("name")), _clean(arr.get("name")), _clock(f.get("departureTime")),
                        _clock(f.get("arrivalTime")), cities, home_tz, (code,) if code else (),
                        (dep.get("address") or {}).get("addressLocality", ""), (arr.get("address") or {}).get("addressLocality", "")))
    return out


def _ns(lines, year_hint, cities, home_tz):
    """NS International: per journey a date, then time / station / (track) / train number / time / station."""
    if any(re.match(r"(?i)^departure:.*\bat \d{1,2}:\d{2}$", l) for l in lines):
        return _ns_tables(lines, year_hint, cities, home_tz)
    out, day, stops, service = [], None, [], ""
    for line in lines + ["Outward journey"]:
        if re.match(r"(?i)^(outward|return) journey$", line):
            if day and len(stops) >= 2:
                out.append(_leg("train", service, stops[0][1], stops[-1][1], stops[0][0], stops[-1][0], cities, home_tz))
            day, stops, service = None, [], ""
            continue
        d = _dates(line, year_hint)
        if d and day is None:
            day = d[0][1]
        elif day and re.fullmatch(r"\d{1,2}:\d{2}", line):
            h, m = map(int, line.split(":"))
            stops.append([day.replace(hour=h, minute=m), None])
        elif stops and stops[-1][1] is None and not line.lower().startswith(("track", "platform", "spoor")):
            stops[-1][1] = line
        elif re.fullmatch(r"[A-Z]{1,4} ?\d{2,5}", line) and not service:
            service = line
    return out


def _ns_tables(lines, year_hint, cities, home_tz):
    """NS International's layout until 2023: per journey 'Outward' or 'Return', the route 'A - B', then 'Departure:
    <date> at HH:MM' and 'Arrival: …' (the payment date and the travel time are not the journey's)."""
    out, route, times = [], None, {}

    def flush():
        if route and "departure" in times:
            out.append(_leg("train", "", route[0], route[1], times["departure"], times.get("arrival"), cities, home_tz))

    for line in lines:
        if re.fullmatch(r"(?i)outward|return", line):
            flush()
            route, times = None, {}
        elif route is None and " - " in line and not re.search(r"\d", line):
            a, b = (x.strip() for x in line.split(" - ", 1))
            route = (a, b)
        else:
            m = re.match(r"(?i)^(departure|arrival):[\s|]*(.+?)\s+at\s+(\d{1,2}):(\d{2})$", line)
            dates = _dates(m.group(2), year_hint) if m else []
            if dates and m.group(1).lower() not in times:
                times[m.group(1).lower()] = dates[0][1].replace(hour=int(m.group(3)), minute=int(m.group(4)))
    flush()
    return out


def _sncf(html, lines, year_hint, cities, home_tz):
    """SNCF Connect: origin and destination in data-select attributes, 'Outbound: <date> at HH:MM'."""
    tag = lambda k: re.search(rf'data-select="travel-summary-{k}"[^>]*>([^<]+)<', html)
    o, d = tag("origin"), tag("destination")
    if not (o and d):
        return []
    codes, out = [], []
    for i, line in enumerate(lines):
        if line.lower() == "references" and i + 1 < len(lines):
            codes = [c.strip() for c in lines[i + 1].split(",") if c.strip()]
    for line in lines:
        m = re.match(r"(?i)^(outbound|return):\s*(.+?)\s+at\s+(\d{1,2}):(\d{2})", line)
        dates = _dates(m.group(2), year_hint) if m else []
        if dates:
            t = dates[0][1].replace(hour=int(m.group(3)), minute=int(m.group(4)))
            a, b = (o.group(1).strip(), d.group(1).strip())
            out.append(_leg("train", "", *((a, b) if m.group(1).lower() == "outbound" else (b, a)), t, None, cities, home_tz, codes))
    return out


TWELVE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)", re.I)


def _redbus(lines, cities, home_tz):
    """redBus: route 'A-B', then 'dd/mm/yyyy, hh:mm AM' for boarding and dropping."""
    route = next((m for m in (re.fullmatch(r"([^\d|:-][^|:-]*?)\s*-\s*([^|:-]+)", l) for l in lines) if m), None)
    times = []
    for line in lines:
        for m in TWELVE.finditer(line):
            d, mo, y, h, mi, ap = m.groups()
            h = int(h) % 12 + (12 if ap.upper() == "PM" else 0)
            times.append(datetime(int(y), int(mo), int(d), h, int(mi)))
    if not route or not times:
        return []
    return [_leg("bus", "", route.group(1).strip(), route.group(2).strip(), times[0], times[1] if len(times) > 1 else None,
                 cities, home_tz)]


def _rne(lines, cities, home_tz):
    """Rede Expressos: 'Departure: HH:MM, YYYY-MM-DD' and 'Arrival: …', each followed by the place."""
    found, code = {}, ""
    for i, line in enumerate(lines):
        m = re.match(r"(?i)^(departure|arrival):\s*(\d{1,2}):(\d{2}),\s*(\d{4})-(\d{2})-(\d{2})", line)
        if m and i + 1 < len(lines):
            h, mi, y, mo, d = map(int, m.groups()[1:])
            found[m.group(1).lower()] = (datetime(y, mo, d, h, mi), lines[i + 1])
        if re.match(r"(?i)^book\w* details:?$", line) and i + 1 < len(lines):
            code = lines[i + 1]
    if "departure" not in found:
        return []
    (t0, a), (t1, b) = found["departure"], found.get("arrival", (None, ""))
    return [_leg("bus", "", a, b, t0, t1, cities, home_tz, (code,) if code else ())]


def legs(sender, subject, html, lines, year_hint, cities, home_tz, mode):
    """Legs of a ground booking, each journey once (some emails repeat their markup)."""
    seen, out = set(), []
    for leg in _legs(sender, subject, html, lines, year_hint, cities, home_tz, mode):
        if (leg.key, leg.dep_local) not in seen:
            seen.add((leg.key, leg.dep_local))
            out.append(leg)
    return out


def _legs(sender, subject, html, lines, year_hint, cities, home_tz, mode):
    s = sender.lower()
    if html and reservations(html, tuple(MODES)):
        return _markup(html, mode, cities, home_tz)
    if "nsinternational" in s:
        return _ns(lines, year_hint, cities, home_tz)
    if "sncf" in s:
        return _sncf(html, lines, year_hint, cities, home_tz)
    if "redbus" in s:
        return _redbus(lines, cities, home_tz)
    if "rnetickets" in s or "rede-expressos" in s:
        return _rne(lines, cities, home_tz)
    return []
