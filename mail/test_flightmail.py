"""Tests for flightmail.py without network or EventKit. Run: python mail/test_flightmail.py (no pytest needed)."""
import imaplib
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import flightmail  # noqa: E402
import test_parse  # noqa: E402


class Recorder:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        if name in ("has_flight", "lookup"):
            return lambda *a: self.calls.append((name, a)) and None if name == "lookup" else False
        return lambda *a: self.calls.append((name, a)) or "id1"


def with_home(fn):
    def wrapper():
        old = os.environ.get("FLIGHTMAIL_HOME")
        with tempfile.TemporaryDirectory() as d:
            os.environ["FLIGHTMAIL_HOME"] = d
            try:
                fn(Path(d))
            finally:
                if old is None:
                    os.environ.pop("FLIGHTMAIL_HOME")
                else:
                    os.environ["FLIGHTMAIL_HOME"] = old
    wrapper.__name__ = fn.__name__
    return wrapper


CFG = ({"passenger_names": ["Jan Testers"], "gmail_user": "jan.testers@example.com", "lookback_days": 365}, {})


def patch(**values):
    values = {"load_config": lambda: CFG, "now": lambda: flightmail.datetime(2026, 10, 21, 12, 0),
              "open_extras": lambda cfg, cal: None, "open_docs": lambda cfg, dry: None,
              **values}  # never drive the real Things, calendars or Google Docs
    saved = {k: getattr(flightmail, k) for k in values}
    for k, v in values.items():
        setattr(flightmail, k, v)
    return lambda: [setattr(flightmail, k, v) for k, v in saved.items()]


@with_home
def test_failure_alerts_and_keeps_state(home):
    (home / "state.json").write_text(json.dumps({"last_uid": 5, "legs": []}))
    sent = []

    def fail(*a):
        raise imaplib.IMAP4.error("AUTHENTICATIONFAILED")

    undo = patch(fetch_new=lambda *a, **k: fail(), send_discord=lambda text, sec: sent.append(text))
    try:
        assert flightmail.main([]) == 0
    finally:
        undo()
    assert len(sent) == 1 and "AUTHENTICATIONFAILED" in sent[0]
    assert json.loads((home / "state.json").read_text()) == {"last_uid": 5, "legs": []}


@with_home
def test_dry_run_writes_nothing(home):
    (home / "state.json").write_text(json.dumps({"last_uid": 5, "legs": []}))
    cal, con, sent = Recorder(), Recorder(), []
    msg = test_parse.fixture("edreams_nl_overnight")
    undo = patch(fetch_new=lambda cfg, sec, state, since_days=None: [(6, msg)],
                 load_reference=lambda cfg: (test_parse.airports(), test_parse.airlines(), {}),
                 open_stores=lambda cfg, airports, airlines: (cal, con),
                 send_discord=lambda text, sec: sent.append(text))
    try:
        assert flightmail.main(["--dry-run"]) == 0
    finally:
        undo()
    writes = [c for c in cal.calls + con.calls if c[0] != "lookup"]  # lookups only read
    assert writes == [], writes
    assert json.loads((home / "state.json").read_text()) == {"last_uid": 5, "legs": []}
    assert sent == []


@with_home
def test_run_applies_and_saves_state(home):
    cal, con, sent = Recorder(), Recorder(), []
    msg = test_parse.fixture("edreams_nl_overnight")
    undo = patch(fetch_new=lambda cfg, sec, state, since_days=None: [(7, msg)],
                 load_reference=lambda cfg: (test_parse.airports(), test_parse.airlines(), {}),
                 open_stores=lambda cfg, airports, airlines: (cal, con),
                 send_discord=lambda text, sec: sent.append(text))
    try:
        assert flightmail.main([]) == 0
    finally:
        undo()
    state = json.loads((home / "state.json").read_text())
    assert state["last_uid"] == 7 and [e["flight"] for e in state["legs"]] == ["KL1702"]
    assert [c[0] for c in cal.calls] == ["create"] and [c[0] for c in con.calls if c[0] != "lookup"] == ["add"]
    assert sent == []


class StubContrail(flightmail.ContrailHTTP):
    def __init__(self, replies):
        super().__init__("http://x", test_parse.airports(), test_parse.airlines())
        self.replies, self.sent = replies, []

    def _call(self, method, path, body=None):
        self.sent.append((method, path, body))
        return self.replies[(method, path)]


def test_contrail_duplicate_by_route_or_number():
    con = StubContrail({("GET", "/api/flights"): [
        {"id": 4, "date": "2026-11-04 18:55:00", "from": "TER", "to": "LIS", "flight_number": "140"},
        {"id": 5, "date": "2026-11-16 16:10:00", "from": "AMS", "to": "MAD", "flight_number": "KL1234"}]})
    d = flightmail.datetime
    assert con.has_flight("S4140", "TER", "LIS", d(2026, 11, 4).date())      # same day and route, other number
    assert con.has_flight("KL1234", "AMS", "LIS", d(2026, 11, 16).date())   # same day and number, other route
    assert not con.has_flight("KL1234", "AMS", "LIS", d(2026, 11, 17).date())


def test_contrail_lookup():
    con = StubContrail({("POST", "/api/flights/lookup"): {"from": "MAD", "to": "AMS", "airline": "KLM",
                        "departure_time": "2026-11-16 16:10+01:00", "arrival_time": "2026-11-16 18:45+01:00"}})
    leg = con.lookup("KL1234", flightmail.datetime(2026, 11, 16).date())
    assert (leg.flight, leg.dep, leg.arr, leg.dep_local, leg.arr_local) == (
        "KL1234", "MAD", "AMS", flightmail.datetime(2026, 11, 16, 16, 10), flightmail.datetime(2026, 11, 16, 18, 45))
    assert con.sent == [("POST", "/api/flights/lookup", {"flight_number": "KL1234", "date": "2026-11-16"})]


@with_home
def test_lookups_cached_even_in_dry_run(home):
    cal, con = Recorder(), Recorder()
    msg = test_parse.fixture("edreams_nl_overnight")
    undo = patch(fetch_new=lambda cfg, sec, state, since_days=None: [(6, msg)],
                 load_reference=lambda cfg: (test_parse.airports(), test_parse.airlines(), {}),
                 open_stores=lambda cfg, airports, airlines: (cal, con), send_discord=lambda text, sec: None)
    try:
        flightmail.main(["--dry-run"])
        flightmail.main(["--dry-run"])
    finally:
        undo()
    assert [c for c in con.calls if c[0] == "lookup"] == [("lookup", ("KL1702", flightmail.datetime(2026, 11, 16).date()))]
    assert not (home / "state.json").exists()


def test_alerts_merged_per_flight():
    a = ["Change for S4127 on 2026-10-29 not applied, its event was not made by flightmail: G | One | 2026-09-16",
         "Change for S4127 on 2026-10-29 not applied, its event was not made by flightmail: G | Two | 2026-09-23",
         "Could not read flight: X | Y | 2026-10-01", "Could not read flight: X | Y | 2026-10-01"]
    assert flightmail.merge_alerts(a) == [a[1], a[2]]


def test_event_title_and_notes():
    leg = flightmail.Leg("KL1702", "MAD", "AMS", None, None, ("ABC123", "11112222333"), "eDreams 11112222333")
    assert flightmail.event_title(leg, test_parse.airports()) == "✈️ KL1702: Madrid - Amsterdam"
    assert flightmail.event_notes(leg, ["Rebooked from KL1700 on 2026-11-15"]) == (
        "Confirmation Code: ABC123\nBooking: eDreams 11112222333\nflightmail ABC123 KL1702\nRebooked from KL1700 on 2026-11-15")


def test_ground_titles_and_notes():
    train = flightmail.Leg("EC9236", "Breda", "Bruxelles Midi", None, None, ("TRAIN12",), "", None, "train",
                           "Europe/Amsterdam", "Europe/Brussels")
    bus = flightmail.Leg("", "Lisboa (Oriente)", "Porto (Campanhã)", None, None, ("3000000001",), "", None, "bus",
                         "Europe/Lisbon", "Europe/Lisbon", True)
    ferry = flightmail.Leg("", "Horta", "Madalena", None, None, (), "", None, "ferry", "Atlantic/Azores", "Atlantic/Azores")
    assert flightmail.event_title(train, {}) == "🚆 EC9236: Breda - Bruxelles Midi"
    assert flightmail.event_title(bus, {}) == "🚌 Lisboa (Oriente) - Porto (Campanhã)"
    assert flightmail.event_title(ferry, {}) == "⛴️ Horta - Madalena"
    assert flightmail.event_notes(bus, []) == ("Confirmation Code: 3000000001\nflightmail 3000000001 bus:Lisboa (Oriente)>Porto (Campanhã)\n"
                                               "Arrival time not in the email: the end time is a guess.")


@with_home
def test_rescan_reads_again_without_moving_back(home):
    (home / "state.json").write_text(json.dumps({"last_uid": 500, "legs": []}))
    seen = []
    undo = patch(fetch_new=lambda cfg, sec, state, since_days=None: seen.append((state.get("last_uid"), since_days)) or [],
                 send_discord=lambda text, sec: None)
    try:
        flightmail.main(["--rescan-days", "60"])
    finally:
        undo()
    assert seen == [(500, 60)]
    assert json.loads((home / "state.json").read_text())["last_uid"] == 500


class Store:
    """Stand-in for Things, the work calendar or the banners: records calls, hands out refs."""
    def __init__(self, skip=False):
        self.items, self.calls, self.n, self.skip = {}, [], 0, skip

    def create(self, spec):
        self.calls.append("create")
        if self.skip:
            return None
        self.n += 1
        self.items[f"r{self.n}"] = spec
        return f"r{self.n}"

    def update(self, ref, spec):
        self.calls.append("update")
        self.items[ref] = spec

    def remove(self, ref):
        self.calls.append("remove")
        del self.items[ref]


def seen_row(flight, dep, arr, t0, t1):
    return {"flight": flight, "dep": dep, "arr": arr, "dep_local": t0, "arr_local": t1, "codes": ["ABC123"], "checkin_url": ""}


def test_extras_keep_todos_blocks_and_banners_in_step():
    ap = test_parse.airports()
    state = {"seen": {"KL1234@2026-11-16": seen_row("KL1234", "AMS", "LIS", "2026-11-16T16:10:00", "2026-11-16T17:55:00"),
                      "KL1235@2026-11-20": seen_row("KL1235", "LIS", "AMS", "2026-11-20T10:00:00", "2026-11-20T13:45:00")}}
    todos, blocks, banners = Store(), Store(), Store()
    now = flightmail.datetime(2026, 10, 22, 8, 0)
    flightmail.run_extras(state, todos, blocks, banners, ap, now, ["AMS"])
    assert sorted(t["when"] for t in todos.items.values()) == ["2026-11-15"]  # one booking: one to-do, before the first flight
    assert [b for b in blocks.items.values()][0] == ["2026-11-16T14:10:00+01:00", "2026-11-16T18:55:00+00:00"]
    assert list(banners.items.values()) == [{"id": "KL1234@2026-11-16", "name": "Lisbon", "start": "2026-11-16", "end": "2026-11-20"}]
    flightmail.run_extras(state, todos, blocks, banners, ap, now, ["AMS"])  # nothing changed: no calls
    assert todos.calls == ["create"] and blocks.calls == ["create", "create"] and banners.calls == ["create"]
    del state["seen"]["KL1235@2026-11-20"]  # return flight cancelled
    flightmail.run_extras(state, todos, blocks, banners, ap, now, ["AMS"])
    assert len(todos.items) == 1 and len(blocks.items) == 1 and banners.items == {}


def test_extras_skipped_banner_and_past_items():
    ap = test_parse.airports()
    state = {"seen": {"KL1234@2026-11-16": seen_row("KL1234", "AMS", "LIS", "2026-11-16T16:10:00", "2026-11-16T17:55:00"),
                      "KL1235@2026-11-20": seen_row("KL1235", "LIS", "AMS", "2026-11-20T10:00:00", "2026-11-20T13:45:00")}}
    todos, blocks, banners = Store(), Store(), Store(skip=True)  # an all-day event of the owner already covers the trip
    flightmail.run_extras(state, todos, blocks, banners, ap, flightmail.datetime(2026, 10, 22), ["AMS"])
    flightmail.run_extras(state, todos, blocks, banners, ap, flightmail.datetime(2026, 10, 22), ["AMS"])
    assert banners.calls == ["create"]  # asked once, not every run
    flightmail.run_extras(state, todos, blocks, banners, ap, flightmail.datetime(2026, 11, 17, 12, 0), ["AMS"])
    assert todos.calls.count("remove") == 0 and blocks.calls.count("remove") == 0  # past ones are left alone
    assert list(state["todos"]) == []  # the booking's first flight is past: no new to-do for its return flight


def test_one_todo_per_booking():
    ap = test_parse.airports()
    out, back, other = (seen_row("KL1234", "AMS", "LIS", "2026-11-16T16:10:00", "2026-11-16T17:55:00"),
                        seen_row("KL1235", "LIS", "AMS", "2026-11-20T10:00:00", "2026-11-20T13:45:00"),
                        seen_row("KL1236", "AMS", "LIS", "2026-12-01T10:00:00", "2026-12-01T12:45:00"))
    other["codes"] = ["XYZ789"]
    state = {"todos": {"KL1235@2026-11-20": {"ref": "old", "spec": {"when": "2026-11-19"}}},  # made before this rule
             "seen": {"KL1234@2026-11-16": out, "KL1235@2026-11-20": back, "KL1236@2026-12-01": other}}
    todos = Store()
    todos.items["old"] = {}
    flightmail.run_extras(state, todos, Store(), Store(), ap, flightmail.datetime(2026, 10, 22, 8, 0), ["AMS"])
    assert sorted(state["todos"]) == ["KL1234@2026-11-16", "KL1236@2026-12-01"]
    assert "old" not in todos.items  # the return flight's own to-do is cancelled


def test_things_script_arguments():
    spec = {"title": "check in KL1234", "when": "2026-11-15", "notes": "https://x\nBooking code: ABC123"}
    assert flightmail.ThingsTodos("✈️ Travel").args(spec) == [spec["title"], spec["notes"], "2026", "11", "15", "✈️ Travel"]


def test_title_matches_any_airline_prefix():
    for title in ("EJU7883: Amsterdam - Tenerife South", "✈️ U27883: Amsterdam - Tenerife", "Flight: U2 7883 from AMS to TFS", "U27883: Amsterdam - Tenerife"):
        assert flightmail.title_has_flight(title, "U27883"), title
    assert not flightmail.title_has_flight("EJU78830: somewhere", "U27883")
    assert not flightmail.title_has_flight("Tenerife", "U27883")



def test_note_stay():
    from stays import Stay
    from datetime import date
    state, now = {}, flightmail.datetime(2026, 10, 21, 12, 0)
    flightmail.note_stay(state, Stay("booking", "stay", "Airbnb", "HM1", "Faro", "Portugal", date(2026, 11, 1), date(2026, 11, 3)), now)
    assert state["stays"]["HM1"]["start"] == "2026-11-01" and "cancelled" not in state["stays"]["HM1"]
    flightmail.note_stay(state, Stay("cancel", "stay", "Airbnb", "HM1"), now)
    assert state["stays"]["HM1"]["cancelled"] is True
    flightmail.note_stay(state, Stay("cancel", "stay", "Airbnb", "HM2"), now)  # never booked here: nothing to cancel
    assert "HM2" not in state["stays"]
    flightmail.note_stay(state, Stay("booking", "stay", "Airbnb", "HM3", "Faro", "", date(2026, 9, 1), date(2026, 9, 2)), now)
    assert "HM3" not in state["stays"]  # over for more than a month



def test_blocks_only_in_work_hours_and_for_ground_legs():
    ap = test_parse.airports()
    state = {"seen": {"KL1234@2026-11-14": seen_row("KL1234", "AMS", "LIS", "2026-11-14T16:10:00", "2026-11-14T17:55:00")},  # Saturday
             "ground": {"bus@2026-11-17T10:00:00": {"flight": "bus:A>B", "dep": "A", "arr": "B", "dep_local": "2026-11-17T10:00:00",
                                                    "arr_local": "2026-11-17T13:00:00", "codes": [], "mode": "bus",
                                                    "tz": ["Europe/Lisbon", "Europe/Lisbon"]}}}
    todos, blocks, banners = Store(), Store(), Store()
    flightmail.run_extras(state, todos, blocks, banners, ap, flightmail.datetime(2026, 10, 22, 8, 0), ["AMS"])
    assert list(blocks.items.values()) == [["2026-11-17T08:00:00+00:00", "2026-11-17T14:00:00+00:00"]]
    assert len(todos.items) == 1  # the Saturday flight still gets its check-in to-do

if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f) and hasattr(f, "__code__")]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
