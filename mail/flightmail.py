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
import imaplib
import json
import os
import re
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

REPO = Path(__file__).resolve().parent.parent
AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"
GMAIL_QUERY = ("flight OR flights OR vlucht OR vluchten OR flug OR vol OR vuelo OR voo OR boarding OR itinerary OR "
               "reisoverzicht OR reisplan OR PNR OR boekingscode OR \"booking reference\" OR reserveringsnummer OR "
               "e-ticket OR geannuleerd OR cancelled OR rebooked OR omgeboekt OR category:reservations")


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
    airlines = REPO / "data" / "airlines.dat"
    if not airlines.exists():
        urllib.request.urlretrieve(AIRLINES_URL, airlines)
    return load_airports(REPO / cfg["airports_file"]), load_airlines(airlines)


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

def fetch_new(cfg, sec, state):
    """(uid, message) for new messages in All Mail that match the flight query, oldest first. Never changes the mailbox."""
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
        if state.get("last_uid"):
            criteria = ["UID", f"{state['last_uid'] + 1}:*"]
        else:
            since = (now() - timedelta(days=int(cfg.get("lookback_days", 365)))).strftime("%d-%b-%Y")
            criteria = ["SINCE", since]
        query = cfg.get("gmail_query") or GMAIL_QUERY
        _, data = imap.uid("SEARCH", "X-GM-RAW", '"' + query.replace('"', '\\"') + '"', *criteria)
        uids = sorted(int(u) for u in data[0].split() if int(u) > state.get("last_uid", 0))
        out = []
        for uid in uids:
            _, parts = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
            raw = next(p[1] for p in parts if isinstance(p, tuple))
            msg = email.message_from_bytes(raw, policy=policy.compat32)
            if parseaddr(msg.get("From", ""))[1].lower() != cfg["gmail_user"].lower():  # skip sent mail
                out.append((uid, msg))
            elif uid > state.get("last_uid", 0):
                out.append((uid, None))  # keeps last_uid moving past sent mail
        return out
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# --- Travel calendar (EventKit) ---

def event_title(leg, airports):
    """The owner's style with a plane: "✈️ KL1234: Amsterdam - Lisbon" (airport cities from airports.dat)."""
    city = lambda code: airports[code].city if code in airports else code
    return f"✈️ {leg.flight}: {city(leg.dep)} - {city(leg.arr)}"


def title_has_flight(title, flight):
    """True when the title holds this flight number with any airline prefix: EJU7883, U27883, U2 7883."""
    return bool(re.search(rf"(?<![A-Za-z0-9])[A-Z0-9]{{2,3}}\s?{flight[2:]}(?!\d)", title or ""))


def event_notes(leg, notes):
    pnr = next((c for c in leg.codes if not re.fullmatch(r"[\d-]+", c)), None)
    lines = ([f"Confirmation Code: {pnr}"] if pnr else []) + ([f"Booking: {leg.agency}"] if leg.agency else [])
    lines.append(f"flightmail {leg.codes[0] if leg.codes else '-'} {leg.flight}")
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
        cals = [c for c in self.store.calendarsForEntityType_(EventKit.EKEntityTypeEvent)
                if c.title() == title and c.source().title() == account]
        if len(cals) != 1:
            raise RuntimeError(f"Expected one calendar {title!r} in account {account!r}, found {len(cals)}")
        self.cal = cals[0]

    @staticmethod
    def _ns(dt):
        from Foundation import NSDate
        return NSDate.dateWithTimeIntervalSince1970_(dt.timestamp())

    def has_flight(self, flight, day):
        start = datetime(day.year, day.month, day.day)
        pred = self.store.predicateForEventsWithStartDate_endDate_calendars_(
            self._ns(start), self._ns(start + timedelta(days=1)), [self.cal])
        return any(title_has_flight(ev.title(), flight) for ev in self.store.eventsMatchingPredicate_(pred) or [])

    def _fill(self, ev, leg):
        from Foundation import NSTimeZone
        dep, arr = leg.instants(self.airports)
        a = self.airports[leg.dep]
        ev.setTitle_(event_title(leg, self.airports))
        ev.setStartDate_(self._ns(dep))
        ev.setEndDate_(self._ns(arr))
        ev.setTimeZone_(NSTimeZone.timeZoneWithName_(a.tz))
        ev.setLocation_(f"{a.name}, {a.city}")

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
        ev = self.store.eventWithIdentifier_(event_id)
        if ev is not None:
            ok, err = self.store.removeEvent_span_commit_error_(ev, self.EK.EKSpanThisEvent, True, None)
            if not ok:
                raise RuntimeError(f"Could not delete event {event_id}: {err}")


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
    messages = fetch_new(cfg, sec, dict(state) if args.dry_run else state)
    log(f"{len(messages)} new message(s)")
    if not messages:
        if not args.dry_run:
            save_state(state)
        return []
    airports, airlines = load_reference(cfg)
    cal, con = open_stores(cfg, airports, airlines)
    cal, con = Logged(cal, "calendar", args.dry_run), Logged(con, "contrail", args.dry_run)
    work = json.loads(json.dumps(state)) if args.dry_run else state
    cache_file = home() / "lookups.json"  # a cache, kept even in dry runs: lookups use the free monthly quota
    cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
    limit = int(cfg.get("lookup_monthly_limit", 100))
    alerts = []
    for uid, msg in messages:
        if msg is not None:
            parsed = parse_email(msg, airports, airlines)
            if parsed.kind != "other" or parsed.legs:
                name, addr = parseaddr(msg.get("From", ""))
                sender = str(make_header(decode_header(name))) if name else addr.rsplit("@", 1)[-1]
                subject = str(make_header(decode_header(msg.get("Subject", ""))))
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
        work["last_uid"] = max(uid, work.get("last_uid", 0))
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
