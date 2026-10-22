#!/usr/bin/env python3
"""flightmail: read new Gmail messages, put the owner's flights into the Travel calendar and Contrail.

Run hourly on mini through ~/.flightmail/flightmail.app (see mail/install.sh), which holds the Calendar permission.
  flightmail.py              read new mail and apply it
  flightmail.py --dry-run    read and log what would change; writes nothing, state untouched
  flightmail.py calendars    list the calendars EventKit can see
Never exits non-zero: failures are logged and posted to Discord (an applet that fails shows a blocking dialog).
"""
import argparse
import email
import io
import zipfile
import imaplib
import json
import os
import re
import subprocess
import sys
import threading
import traceback
import urllib.request
from datetime import datetime, timedelta
from email import policy
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse import Leg, load_airlines, load_airports, parse_email  # noqa: E402
import sync  # noqa: E402
import ground  # noqa: E402
import plan  # noqa: E402
import stays  # noqa: E402
import tripdocs  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"
GMAIL_QUERY = ("flight OR flights OR vlucht OR vluchten OR flug OR vol OR vuelo OR voo OR boarding OR itinerary OR "
               "reisoverzicht OR reisplan OR PNR OR boekingscode OR \"booking reference\" OR reserveringsnummer OR "
               "e-ticket OR geannuleerd OR cancelled OR rebooked OR omgeboekt OR category:reservations OR "
               "train OR trein OR treinreis OR bus OR busreis OR coach OR ferry OR veerboot OR bilhete OR billet OR "
               "flixbus OR sncf OR nsinternational OR redbus OR 12go OR rnetickets OR "
               "from:booking.com OR from:airbnb.com OR from:discovercars.com OR from:vipcars.com")


def home():
    return Path(os.environ.get("FLIGHTMAIL_HOME", "~/.flightmail")).expanduser()


def now():
    return datetime.now()


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def load_config():
    """The "flightmail" sections of default.config + config, and of secret."""
    def read(name):
        p = REPO / name
        return json.loads(p.read_text()) if p.exists() else {}
    cfg = {**read("default.config").get("flightmail", {}), **read("config").get("flightmail", {})}
    cfg["airports_file"] = read("config").get("airports_file") or read("default.config").get("airports_file", "data/airports.dat")
    return cfg, read("secret").get("flightmail", {})


def load_reference(cfg):
    """Airports, airlines and GeoNames towns (for station time zones), downloaded into data/ when missing."""
    data = REPO / "data"
    airlines, towns = data / "airlines.dat", data / "cities1000.txt"
    if not airlines.exists():
        urllib.request.urlretrieve(AIRLINES_URL, airlines)
    if not towns.exists():
        with urllib.request.urlopen(ground.CITIES_URL, timeout=120) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extract("cities1000.txt", data)
    return load_airports(REPO / cfg["airports_file"]), load_airlines(airlines), ground.load_cities(towns)


def load_state():
    p = home() / "state.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save_state(state):
    p = home() / "state.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(p)


def send_discord(text, sec):
    url = sec.get("discord_webhook")
    if not url:
        return
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)] or [""]:
        req = urllib.request.Request(url, json.dumps({"content": chunk}).encode(), method="POST", headers={
            "Content-Type": "application/json", "User-Agent": "flightmail"})  # Discord refuses urllib's default agent
        urllib.request.urlopen(req, timeout=20).close()


# --- Gmail (read only) ---

def fetch_new(cfg, sec, state, since_days=None):
    """(uid, message) for new messages in All Mail that match the travel query, oldest first; with since_days, all
    matching messages of that many days instead (a rescan). Never changes the mailbox."""
    imap = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    try:
        imap.login(cfg["gmail_user"], sec["gmail_app_password"])
        _, boxes = imap.list()
        box = next(b.decode().rsplit(' "/" ', 1)[-1] for b in boxes if b"\\All" in b)
        imap.select(box, readonly=True)  # EXAMINE
        validity = imap.response("UIDVALIDITY")[1][0].decode()
        if state.get("uidvalidity") not in (None, validity):
            state.pop("last_uid", None)
        state["uidvalidity"] = validity
        if state.get("last_uid") and not since_days:
            criteria = ["UID", f"{state['last_uid'] + 1}:*"]
        else:
            since = (now() - timedelta(days=int(since_days or cfg.get("lookback_days", 365)))).strftime("%d-%b-%Y")
            criteria = ["SINCE", since]
        query = cfg.get("gmail_query") or GMAIL_QUERY
        _, data = imap.uid("SEARCH", "X-GM-RAW", '"' + query.replace('"', '\\"') + '"', *criteria)
        uids = sorted(int(u) for u in data[0].split() if since_days or int(u) > state.get("last_uid", 0))
        out = []
        for uid in uids:
            _, parts = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
            raw = next(p[1] for p in parts if isinstance(p, tuple))
            msg = email.message_from_bytes(raw, policy=policy.compat32)
            if parseaddr(msg.get("From", ""))[1].lower() != cfg["gmail_user"].lower():  # skip sent mail
                out.append((uid, msg))
            else:
                out.append((uid, None))  # keeps last_uid moving past sent mail
        return out
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# --- Travel calendar (EventKit) ---

EMOJI = {"flight": "✈️", "train": "🚆", "bus": "🚌", "ferry": "⛴️"}


def event_title(leg, airports):
    """The owner's style: "✈️ KL1234: Amsterdam - Lisbon" (airport cities from airports.dat); trains, buses and
    ferries use station names, and the service number when there is one: "🚆 EC9236: Breda - Bruxelles Midi"."""
    if leg.mode != "flight":
        return f"{EMOJI.get(leg.mode, '🚌')} {leg.flight + ': ' if leg.flight else ''}{leg.dep} - {leg.arr}"
    city = lambda code: airports[code].city if code in airports else code
    return f"✈️ {leg.flight}: {city(leg.dep)} - {city(leg.arr)}"


def title_has_flight(title, flight):
    """True when the title holds this flight number with any airline prefix: EJU7883, U27883, U2 7883."""
    return bool(re.search(rf"(?<![A-Za-z0-9])[A-Z0-9]{{2,3}}\s?{flight[2:]}(?!\d)", title or ""))


def event_notes(leg, notes):
    pnr = next((c for c in leg.codes if not re.fullmatch(r"[\d-]+", c)), None)
    if not pnr and leg.mode != "flight" and leg.codes:  # bus and train bookings are often just numbers
        pnr = leg.codes[0]
    lines = ([f"Confirmation Code: {pnr}"] if pnr else []) + ([f"Booking: {leg.agency}"] if leg.agency else [])
    lines.append(f"flightmail {leg.codes[0] if leg.codes else '-'} {leg.key}")
    if leg.arr_guess:
        lines.append("Arrival time not in the email: the end time is a guess.")
    return "\n".join(lines + list(notes))


class EventKitCalendar:
    def __init__(self, account, title, airports):
        import EventKit
        self.EK, self.airports = EventKit, airports
        store = EventKit.EKEventStore.alloc().init()
        done, result = threading.Event(), {}

        def handler(granted, error):
            result["granted"] = bool(granted)
            done.set()

        if hasattr(store, "requestFullAccessToEventsWithCompletion_"):  # macOS 14+
            store.requestFullAccessToEventsWithCompletion_(handler)
        else:
            store.requestAccessToEntityType_completion_(EventKit.EKEntityTypeEvent, handler)
        done.wait(120)
        if not result.get("granted"):
            raise RuntimeError("No calendar access: allow flightmail in System Settings > Privacy & Security > Calendars")
        self.store = EventKit.EKEventStore.alloc().init()
        self.cal = self.calendar(account, title)

    def calendar(self, account, title):
        cals = [c for c in self.store.calendarsForEntityType_(self.EK.EKEntityTypeEvent)
                if c.title() == title and c.source().title() == account]
        if len(cals) != 1:
            raise RuntimeError(f"Expected one calendar {title!r} in account {account!r}, found {len(cals)}")
        return cals[0]

    @staticmethod
    def _ns(dt):
        from Foundation import NSDate
        return NSDate.dateWithTimeIntervalSince1970_(dt.timestamp())

    def has_flight(self, flight, day):
        start = datetime(day.year, day.month, day.day)
        pred = self.store.predicateForEventsWithStartDate_endDate_calendars_(
            self._ns(start), self._ns(start + timedelta(days=1)), [self.cal])
        return any(title_has_flight(ev.title(), flight) for ev in self.store.eventsMatchingPredicate_(pred) or [])

    def has_event_at(self, start):
        """Any event in the calendar starting within five minutes of this moment."""
        pred = self.store.predicateForEventsWithStartDate_endDate_calendars_(
            self._ns(start - timedelta(minutes=5)), self._ns(start + timedelta(minutes=5)), [self.cal])
        t = start.timestamp()
        return any(not ev.isAllDay() and abs(ev.startDate().timeIntervalSince1970() - t) <= 300
                   for ev in self.store.eventsMatchingPredicate_(pred) or [])

    def _fill(self, ev, leg):
        from Foundation import NSTimeZone
        dep, arr = leg.instants(self.airports)
        ev.setTitle_(event_title(leg, self.airports))
        ev.setStartDate_(self._ns(dep))
        ev.setEndDate_(self._ns(arr))
        ev.setTimeZone_(NSTimeZone.timeZoneWithName_(leg.tz(self.airports)[0]))
        a = self.airports.get(leg.dep) if leg.mode == "flight" else None
        ev.setLocation_(f"{a.name}, {a.city}" if a else leg.dep)

    def _save(self, ev):
        ok, err = self.store.saveEvent_span_commit_error_(ev, self.EK.EKSpanThisEvent, True, None)
        if not ok:
            raise RuntimeError(f"Could not save event {ev.title()}: {err}")

    def create(self, leg, notes):
        ev = self.EK.EKEvent.eventWithEventStore_(self.store)
        ev.setCalendar_(self.cal)
        self._fill(ev, leg)
        ev.setNotes_(event_notes(leg, notes))
        ev.addAlarm_(self.EK.EKAlarm.alarmWithRelativeOffset_(-15 * 60))
        self._save(ev)
        return ev.eventIdentifier()

    def update(self, event_id, leg, note):
        ev = self.store.eventWithIdentifier_(event_id)
        if ev is None:
            log(f"event {event_id} for {leg.flight} is gone, not updated")
            return
        self._fill(ev, leg)
        ev.setNotes_(((ev.notes() or "") + "\n" + note).strip())
        self._save(ev)

    def delete(self, event_id):
        """Delete an event (from any calendar)."""
        ev = self.store.eventWithIdentifier_(event_id)
        if ev is not None:
            ok, err = self.store.removeEvent_span_commit_error_(ev, self.EK.EKSpanThisEvent, True, None)
            if not ok:
                raise RuntimeError(f"Could not delete event {event_id}: {err}")


# --- check-in to-dos, busy blocks, trip banners ---

THINGS_CREATE = """on run argv
  set {theTitle, theNotes, y, m, d, proj} to argv
  set dt to current date
  set day of dt to 1
  set year of dt to (y as integer)
  set month of dt to (m as integer)
  set day of dt to (d as integer)
  tell application "Things3"
    set td to make new to do with properties {name:theTitle, notes:theNotes}
    set project of td to project proj
    schedule td for dt
    set due date of td to dt
    return id of td
  end tell
end run"""
THINGS_UPDATE = """on run argv
  set {theId, theTitle, theNotes, y, m, d, proj} to argv
  set dt to current date
  set day of dt to 1
  set year of dt to (y as integer)
  set month of dt to (m as integer)
  set day of dt to (d as integer)
  tell application "Things3"
    try
      set td to to do id theId
      if status of td is open then
        set name of td to theTitle
        set notes of td to theNotes
        set project of td to project proj
        schedule td for dt
        set due date of td to dt
      end if
    end try
  end tell
end run"""
THINGS_CANCEL = """on run argv
  tell application "Things3"
    try
      set td to to do id (item 1 of argv)
      if status of td is open then set status of td to canceled
    end try
  end tell
end run"""


class ThingsTodos:
    """Check-in to-dos in a Things project, through AppleScript (flightmail.app holds the Automation permission)."""

    def __init__(self, project):
        self.project = project

    def args(self, spec):
        y, m, d = spec["when"].split("-")
        return [spec["title"], spec["notes"], y, str(int(m)), str(int(d)), self.project]

    def _osa(self, script, args):
        r = subprocess.run(["osascript", "-e", script, *args], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise RuntimeError(f"Things: {r.stderr.strip()}")
        return r.stdout.strip()

    def create(self, spec):
        return self._osa(THINGS_CREATE, self.args(spec))

    def update(self, ref, spec):
        self._osa(THINGS_UPDATE, [ref] + self.args(spec))

    def remove(self, ref):  # cancel, so it stays visible in the logbook
        self._osa(THINGS_CANCEL, [ref])


class WorkBlocks:
    """Busy blocks in the work calendar, in calsplit's style so its nightly cleanup deletes them once past."""
    TITLE, MARKER = "🛑 Vibe-busy", "[auto-split]"

    def __init__(self, ek, account, title):
        self.ek, self.cal = ek, ek.calendar(account, title)

    def _fill(self, ev, spec):
        start, end = (datetime.fromisoformat(t) for t in spec)
        ev.setTitle_(self.TITLE)
        ev.setStartDate_(self.ek._ns(start))
        ev.setEndDate_(self.ek._ns(end))
        ev.setNotes_(f"{self.MARKER}\nflightmail: travelling")
        ev.setAvailability_(self.ek.EK.EKEventAvailabilityBusy)
        for alarm in list(ev.alarms() or []):  # no alerts, also none the calendar adds by default
            ev.removeAlarm_(alarm)

    def create(self, spec):
        ev = self.ek.EK.EKEvent.eventWithEventStore_(self.ek.store)
        ev.setCalendar_(self.cal)
        self._fill(ev, spec)
        self.ek._save(ev)
        return ev.eventIdentifier()

    def update(self, ref, spec):
        ev = self.ek.store.eventWithIdentifier_(ref)
        if ev is not None:
            self._fill(ev, spec)
            self.ek._save(ev)

    def remove(self, ref):
        self.ek.delete(ref)


class Banners:
    """All-day trip banners in the travel calendar, free time, with the owner's usual alerts (15:00 the day before
    and 09:00 on the day); none when an all-day event of the owner already covers the trip."""
    MARK = "flightmail trip"

    def __init__(self, ek):
        self.ek = ek

    def _days(self, spec):
        start, end = (datetime.fromisoformat(spec[k]) for k in ("start", "end"))
        return start, end

    def _fill(self, ev, spec):
        start, end = self._days(spec)
        ev.setTitle_(spec["name"])
        ev.setAllDay_(True)
        ev.setStartDate_(self.ek._ns(start))
        ev.setEndDate_(self.ek._ns(end))
        ev.setAvailability_(self.ek.EK.EKEventAvailabilityFree)
        ev.setNotes_(self.MARK)

    def create(self, spec):
        start, end = self._days(spec)
        pred = self.ek.store.predicateForEventsWithStartDate_endDate_calendars_(
            self.ek._ns(start), self.ek._ns(end + timedelta(days=1)), [self.ek.cal])
        if any(ev.isAllDay() and self.MARK not in (ev.notes() or "") for ev in self.ek.store.eventsMatchingPredicate_(pred) or []):
            log(f"banner {spec['name']} {spec['start']}: an all-day event already covers it, left alone")
            return None
        ev = self.ek.EK.EKEvent.eventWithEventStore_(self.ek.store)
        ev.setCalendar_(self.ek.cal)
        self._fill(ev, spec)
        for minutes in (-15 * 60, 9 * 60):
            ev.addAlarm_(self.ek.EK.EKAlarm.alarmWithRelativeOffset_(minutes * 60))
        self.ek._save(ev)
        return ev.eventIdentifier()

    def update(self, ref, spec):
        ev = self.ek.store.eventWithIdentifier_(ref)
        if ev is not None:
            self._fill(ev, spec)
            self.ek._save(ev)

    def remove(self, ref):
        self.ek.delete(ref)


def open_extras(cfg, cal):
    """Things, work-calendar blocks and banners; cal is the EventKitCalendar of the travel calendar."""
    return (ThingsTodos(cfg.get("things_project", "✈️ Travel")),
            WorkBlocks(cal, cfg.get("work_calendar_account", "TUe"), cfg.get("work_calendar_title", "Calendar")),
            Banners(cal))


def open_docs(cfg, dry):
    """The trip docs in Google Drive, when a folder is configured and flightmail is signed in to Google."""
    token, client = home() / "google_token.json", home() / "google_client.json"
    if not cfg.get("trip_docs_folder") or not token.exists():
        return None
    return tripdocs.TripDocs(tripdocs.Google(client, token), cfg["trip_docs_folder"], log, dry)


def note_stay(state, s, now):
    """Keep a booking (or mark it cancelled) in state["stays"]; bookings over for a month are forgotten."""
    reg = state.setdefault("stays", {})
    if s.kind == "booking":
        reg[s.code] = {k: v.isoformat() if hasattr(v, "isoformat") else v for k, v in s.__dict__.items() if k != "kind"}
    elif s.code in reg:
        reg[s.code]["cancelled"] = True
    oldest = (now.date() - timedelta(days=30)).isoformat()
    for code in [c for c, r in reg.items() if (r.get("end") or "9999") < oldest]:
        del reg[code]


def _ahead(kind, spec, now):
    if kind == "todos":
        return spec["when"] >= now.date().isoformat()
    if kind == "blocks":
        return datetime.fromisoformat(spec[0]) > now.astimezone()
    return spec["end"] >= now.date().isoformat()


def run_extras(state, todos, blocks, banners, airports, now, home, work_tz="Europe/Amsterdam"):
    """Keep a check-in to-do per booking (before its first flight) in state["seen"], a busy block per future flight or ground leg
    (state["ground"]) in working hours, and a banner per trip, in step. Items that are past are forgotten, never changed."""
    seen, ground = state.setdefault("seen", {}), state.setdefault("ground", {})
    oldest = (now.date() - timedelta(days=30)).isoformat()
    for reg in (seen, ground):
        for k in [k for k, r in reg.items() if r["arr_local"][:10] < oldest]:
            del reg[k]
    known = {k: r for k, r in seen.items() if r["dep"] in airports and r["arr"] in airports}
    future = {k: r for k, r in known.items() if datetime.fromisoformat(r["dep_local"]) > now}
    rides = {**future, **{"ground:" + k: r for k, r in ground.items() if datetime.fromisoformat(r["dep_local"]) > now}}
    want = {"todos": {k: plan.todo(r, airports, now) for k, r in plan.first_of_bookings(known).items() if k in future},
            "blocks": {k: [t.isoformat() for t in b] for k, r in rides.items()
                       for b in [plan.block(r, airports)] if plan.in_work_hours(*b, work_tz)},
            "banners": {t["id"]: t for t in plan.trips(list(known.values()), home, airports)
                        if t["end"] >= now.date().isoformat()}}
    for kind, store in (("todos", todos), ("blocks", blocks), ("banners", banners)):
        owned, desired = state.setdefault(kind, {}), want[kind]
        steps = plan.reconcile(desired, owned)
        for i in steps["create"]:
            owned[i] = {"ref": store.create(desired[i]), "spec": desired[i]}
        for i in steps["update"]:
            if owned[i]["ref"]:
                store.update(owned[i]["ref"], desired[i])
            owned[i]["spec"] = desired[i]
        for i in steps["remove"]:
            if owned[i]["ref"] and _ahead(kind, owned[i]["spec"], now):
                store.remove(owned[i]["ref"])
            del owned[i]


# --- Contrail (HTTP API on mini) ---

class ContrailHTTP:
    def __init__(self, url, airports, airlines):
        self.url, self.airports, self.airlines, self._flights = url.rstrip("/"), airports, airlines, None

    def _call(self, method, path, body=None):
        req = urllib.request.Request(self.url + path, json.dumps(body).encode() if body is not None else None,
                                     method=method, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"null")

    def _payload(self, leg):
        dep, arr = leg.instants(self.airports)
        minutes = int((arr - dep).total_seconds() // 60)
        return {"date": f"{leg.dep_local:%Y-%m-%d %H:%M:%S}", "from": leg.dep, "to": leg.arr, "flight_number": leg.flight,
                "airline": (self.airlines.get(leg.flight[:2]) or ("", ""))[1], "duration": f"{minutes // 60:02d}:{minutes % 60:02d}",
                "seat": "", "seat_type": "", "class": "", "reason": "", "plane": "", "registration": "", "trip": "", "note": ""}

    def has_flight(self, flight, dep, arr, day):
        """Same day and same route, or same day and same flight number: older imports spell numbers differently."""
        if self._flights is None:
            self._flights = self._call("GET", "/api/flights")
        return any((f.get("date") or "")[:10] == day.isoformat()
                   and ((f.get("from"), f.get("to")) == (dep, arr) or f.get("flight_number") == flight) for f in self._flights)

    def lookup(self, flight, day):
        """Airports and scheduled local times from AeroDataBox through Contrail; None when unknown or unavailable."""
        try:
            r = self._call("POST", "/api/flights/lookup", {"flight_number": flight, "date": day.isoformat()})
            dep = datetime.fromisoformat(r["departure_time"]).replace(tzinfo=None)
            arr = datetime.fromisoformat(r["arrival_time"]).replace(tzinfo=None)
        except (urllib.error.URLError, KeyError, TypeError, ValueError) as e:
            log(f"lookup {flight} {day}: {e!r}")
            return None
        return Leg(flight, r.get("from", ""), r.get("to", ""), dep, arr) if r.get("from") and r.get("to") else None

    def add(self, leg):
        f = self._call("POST", "/api/flights", self._payload(leg))
        self._flights = None
        return f["id"]

    def update(self, cid, leg):
        self._call("PUT", f"/api/flights/{cid}", self._payload(leg))
        self._flights = None

    def delete(self, cid):
        try:
            self._call("DELETE", f"/api/flights/{cid}")
        except urllib.error.HTTPError as e:
            if e.code != 404:  # already deleted by hand
                raise
        self._flights = None


def open_stores(cfg, airports, airlines):
    return (EventKitCalendar(cfg.get("calendar_account", "Google"), cfg.get("calendar_title", "Travel"), airports),
            ContrailHTTP(cfg.get("contrail_url", "http://127.0.0.1:3000"), airports, airlines))


class Logged:
    """Logs every change; with dry=True only logs (has_flight still asks the real store)."""

    def __init__(self, store, name, dry):
        self.store, self.name, self.dry, self.n = store, name, dry, 0

    def has_flight(self, *a):
        return self.store.has_flight(*a)

    def lookup(self, *a):
        return self.store.lookup(*a)

    def has_event_at(self, *a):
        return self.store.has_event_at(*a)

    def __getattr__(self, action):
        def call(*a):
            leg = next((x for x in a if isinstance(x, Leg)), None)
            log(f"{'would ' if self.dry else ''}{action} {self.name}: {leg.flight + ' ' + str(leg.dep_local) if leg else a[0]}")
            if self.dry:
                self.n += 1
                return f"dry{self.n}"
            return getattr(self.store, action)(*a)
        return call


def merge_alerts(alerts):
    """One line per flight for "not applied" alerts (the latest email wins); exact repeats dropped."""
    merged = {}
    for a in alerts:
        key = a.split(" not applied")[0] if " not applied" in a else a
        merged.pop(key, None)
        merged[key] = a
    return list(merged.values())


def run(args, cfg, sec):
    state = load_state()
    first_run = not state.get("last_uid")
    probe = dict(state) if args.dry_run or args.rescan_days else state
    messages = fetch_new(cfg, sec, probe, since_days=args.rescan_days)
    log(f"{len(messages)} new message(s)")
    if not messages and not state.get("seen") and not state.get("stays"):
        if not args.dry_run:
            save_state(state)
        return []
    airports, airlines, places = load_reference(cfg)
    cal, con = open_stores(cfg, airports, airlines)
    extras = open_extras(cfg, cal)
    cal, con = Logged(cal, "calendar", args.dry_run), Logged(con, "contrail", args.dry_run)
    work = json.loads(json.dumps(state)) if args.dry_run else state
    cache_file = home() / "lookups.json"  # a cache, kept even in dry runs: lookups use the free monthly quota
    cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
    limit = int(cfg.get("lookup_monthly_limit", 100))
    alerts = []
    for uid, msg in messages:
        s = msg is not None and stays.parse_email(msg)
        if s:
            log(f"uid {uid} {s.what} {s.kind}: {s.provider} {s.place} {s.start}..{s.end} {s.type} {s.price}")
            note_stay(work, s, now())
        if msg is not None and not s:
            parsed = parse_email(msg, airports, airlines, places, cfg.get("home_timezone", "Europe/Amsterdam"))
            if parsed.kind != "other" or parsed.legs:
                name, addr = parseaddr(msg.get("From", ""))
                sender = str(make_header(decode_header(name))) if name else addr.rsplit("@", 1)[-1]
                subject = " ".join(str(make_header(decode_header(msg.get("Subject", "")))).split())  # unfold
                try:
                    received = parsedate_to_datetime(msg.get("Date")).date()
                except (TypeError, ValueError):
                    received = now().date()
                log(f"uid {uid} {parsed.kind}: {sender} | {subject} | " + ", ".join(
                    f"{l.flight} {l.dep}-{l.arr} {l.dep_local}" for l in parsed.legs))
                if parsed.kind in ("booking", "change"):
                    parsed = sync.enrich(parsed, con.lookup, cache, now(), limit)
                    cache_file.parent.mkdir(parents=True, exist_ok=True)
                    cache_file.write_text(json.dumps(cache, indent=1))
                alerts += sync.apply(parsed, sender, subject, received, work, cal, con,
                                     cfg.get("passenger_names", []), now(), airports)
        work["last_uid"] = max(uid, work.get("last_uid", 0))  # a rescan never moves it back
        if not args.dry_run:
            save_state(work)
    if extras:
        todos, blocks, banners = (Logged(x, name, args.dry_run) for x, name in zip(extras, ("things", "work calendar", "banner")))
        run_extras(work, todos, blocks, banners, airports, now(), cfg.get("home_airports", ["AMS", "EIN", "RTM"]),
                   cfg.get("home_timezone", "Europe/Amsterdam"))
        if not args.dry_run:
            save_state(work)
    docs = open_docs(cfg, args.dry_run)
    if docs:
        try:
            docs.run(work, airports, now(), cfg.get("home_airports", ["AMS", "EIN", "RTM"]))
        finally:
            if not args.dry_run:
                save_state(work)
    alerts = merge_alerts(alerts)
    for a in alerts:
        log("ALERT " + a)
    if alerts and not args.dry_run:
        head = "flightmail first run: emails to check" if first_run else "flightmail: emails to check"
        send_discord(head + "\n" + "\n".join(f"- {a}" for a in alerts), sec)
    return alerts


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", nargs="?", choices=["run", "calendars"], default="run")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--rescan-days", type=int, metavar="N", help="read all matching mail of the last N days again")
    args = p.parse_args(argv)
    sec = {}
    try:
        cfg, sec = load_config()
        if args.command == "calendars":
            import EventKit
            store = EventKit.EKEventStore.alloc().init()
            for c in store.calendarsForEntityType_(EventKit.EKEntityTypeEvent):
                print(f"account: {c.source().title()!r:30} calendar: {c.title()!r}")
        else:
            run(args, cfg, sec)
    except Exception as e:
        log(f"FAILED: {e!r}")
        traceback.print_exc()
        try:
            send_discord("**flightmail** failed on mini\n```\n" + traceback.format_exc()[-1700:] + "\n```", sec)
        except Exception as e2:
            log(f"could not post to Discord: {e2!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
