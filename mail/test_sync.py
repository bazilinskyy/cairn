"""Tests for sync.py with in-memory calendar and Contrail. Run: python mail/test_sync.py (no pytest needed)."""
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse import Airport, Leg, Parsed  # noqa: E402
import sync  # noqa: E402

AIRPORTS = {"AMS": Airport("Schiphol", "Amsterdam", "Europe/Amsterdam"),
            "LIS": Airport("Humberto Delgado", "Lisbon", "Europe/Lisbon"),
            "MAD": Airport("Barajas", "Madrid", "Europe/Madrid")}
NOW = datetime(2026, 10, 21, 12, 0)
NAMES = ["Jan Testers"]
D = datetime


class FakeCalendar:
    def __init__(self, foreign=(), foreign_at=()):
        self.events, self.foreign, self.foreign_at, self.n = {}, set(foreign), set(foreign_at), 0  # id -> [leg, notes]

    def has_event_at(self, start):
        return start in self.foreign_at or any(l.instants(AIRPORTS)[0] == start for l, _ in self.events.values())

    def has_flight(self, flight, day):
        return (flight, day) in self.foreign or any(l.flight == flight and l.dep_local.date() == day for l, _ in self.events.values())

    def create(self, leg, notes):
        self.n += 1
        self.events[f"ev{self.n}"] = [leg, list(notes)]
        return f"ev{self.n}"

    def update(self, event_id, leg, note):
        self.events[event_id] = [leg, self.events[event_id][1] + [note]]

    def delete(self, event_id):
        del self.events[event_id]


class FakeContrail:
    def __init__(self, foreign=()):
        self.flights, self.events, self.foreign, self.n = {}, {}, set(foreign), 0

    def has_flight(self, flight, dep, arr, day):
        return (flight, dep, arr, day) in self.foreign or any(
            (l.flight, l.dep, l.arr, l.dep_local.date()) == (flight, dep, arr, day) for l in self.flights.values())

    def add(self, leg, event_id=None):
        self.n += 1
        self.flights[self.n] = leg
        self.events[self.n] = event_id
        return self.n

    def update(self, cid, leg):
        self.flights[cid] = leg

    def delete(self, cid):
        del self.flights[cid]


def leg(flight="KL1234", dep_local=D(2026, 11, 16, 16, 10), arr_local=D(2026, 11, 16, 17, 55), dep="AMS", arr="LIS", codes=("ABC123",)):
    return Leg(flight, dep, arr, dep_local, arr_local, codes)


def run(parsed, state, cal, con, sender="KLM", subject="Boeking bevestigd"):
    return sync.apply(parsed, sender, subject, date(2026, 10, 21), state, cal, con, NAMES, NOW, AIRPORTS)


def booking(*legs, kind="booking", passengers=("Jan Testers",), old=(), latest=date(2026, 11, 16)):
    return Parsed(kind, list(legs), list(passengers), True, list(old), latest)


def test_new_booking_creates_both():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    assert run(booking(leg()), state, cal, con) == []
    assert [l.flight for l, _ in cal.events.values()] == ["KL1234"]
    assert [l.flight for l in con.flights.values()] == ["KL1234"]
    assert state["legs"][0]["event_id"] == "ev1" and state["legs"][0]["contrail_id"] == 1


def test_existing_event_not_duplicated():
    cal, con, state = FakeCalendar(foreign={("KL1234", date(2026, 11, 16))}), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    assert cal.events == {}
    assert len(con.flights) == 1
    assert state["legs"][0]["event_id"] is None and state["legs"][0]["contrail_id"] == 1


def test_same_email_twice_is_noop():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    run(booking(leg()), state, cal, con)
    assert len(cal.events) == 1 and len(con.flights) == 1 and len(state["legs"]) == 1
    assert cal.events["ev1"][1] == []


def test_schedule_change_updates_and_notes():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    new = leg(dep_local=D(2026, 11, 16, 18, 0), arr_local=D(2026, 11, 16, 19, 45))
    assert run(booking(new, kind="change"), state, cal, con, sender="Gotogate") == []
    l, notes = cal.events["ev1"]
    assert l.dep_local == D(2026, 11, 16, 18, 0)
    assert notes == ["Updated 2026-10-21: schedule change (Gotogate)"]
    assert con.flights[1].dep_local == D(2026, 11, 16, 18, 0)
    assert state["legs"][0]["dep_local"] == "2026-11-16T18:00:00"


def test_cancel_deletes_both():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    cancelled = Leg("KL1234", "AMS", "LIS", None, None, ("ABC123",))
    assert run(booking(cancelled, kind="cancel"), state, cal, con) == []
    assert cal.events == {} and con.flights == {} and state["legs"] == []


def test_cancel_for_unowned_alerts():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    alerts = run(booking(Leg("KL1234", "AMS", "LIS", None, None, ("ABC123",)), kind="cancel"), state, cal, con, subject="Geannuleerd")
    assert len(alerts) == 1 and "KL1234" in alerts[0]


def test_rebooking_replaces_with_note():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    new = leg(flight="KL1236", dep_local=D(2026, 11, 17, 9, 0), arr_local=D(2026, 11, 17, 10, 45))
    run(booking(new, kind="change"), state, cal, con)
    assert [(l.flight, n) for l, n in cal.events.values()] == [("KL1236", ["Rebooked from KL1234 on 2026-11-16"])]
    assert [l.flight for l in con.flights.values()] == ["KL1236"]
    assert [e["flight"] for e in state["legs"]] == ["KL1236"]


def test_rebooking_with_old_legs():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    a = leg(flight="AF1229", dep="AMS", arr="MAD", dep_local=D(2026, 11, 17, 6, 50), arr_local=D(2026, 11, 17, 9, 15))
    b = leg(flight="AF1840", dep="MAD", arr="LIS", dep_local=D(2026, 11, 17, 11, 30), arr_local=D(2026, 11, 17, 12, 0))
    old = Leg("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 10), None, ("ABC123",))
    run(booking(a, b, kind="change", old=[old]), state, cal, con)
    assert sorted((l.flight, tuple(n)) for l, n in cal.events.values()) == [
        ("AF1229", ("Rebooked from KL1234 on 2026-11-16",)), ("AF1840", ("Rebooked from KL1234 on 2026-11-16",))]
    assert sorted(l.flight for l in con.flights.values()) == ["AF1229", "AF1840"]


def test_past_leg_ignored():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg(dep_local=D(2026, 10, 20, 8, 0), arr_local=D(2026, 10, 20, 10, 0))), state, cal, con)
    assert cal.events == {} and con.flights == {}


def test_other_passenger_ignored():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    assert run(booking(leg(), passengers=["Anna Testers"]), state, cal, con) == []
    assert cal.events == {} and con.flights == {}


def test_change_for_unowned_alerts():
    cal, con, state = FakeCalendar(foreign={("KL1234", date(2026, 11, 16))}), FakeContrail(), {}
    alerts = run(booking(leg(), kind="change"), state, cal, con)
    assert len(alerts) == 1 and "KL1234" in alerts[0]
    assert cal.events == {}


def test_unreadable_booking_alerts():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    half = Leg("KL1234", "AMS", "", None, None, ("ABC123",))
    alerts = run(booking(half), state, cal, con, sender="eDreams", subject="Je reservering is bevestigd")
    assert alerts == ["Could not read flight: eDreams | Je reservering is bevestigd | 2026-10-21"]
    assert run(Parsed("booking", [], [], True, [], date(2026, 12, 1)), state, cal, con, sender="X", subject="Y") == [
        "Could not read flight: X | Y | 2026-10-21"]


def test_no_alerts_for_emails_about_the_past():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    half = Leg("KL1234", "AMS", "", None, None, ("ABC123",))
    assert run(booking(half, latest=date(2026, 9, 1)), state, cal, con) == []
    assert run(booking(Leg("KL1234", "AMS", "LIS", None, None, ("ABC123",)), kind="cancel", latest=date(2026, 9, 1)), state, cal, con) == []
    assert run(Parsed("booking", [], [], True, [], None), state, cal, con) == []


class Lookup:
    def __init__(self, result):
        self.calls, self.result = [], result

    def __call__(self, flight, day):
        self.calls.append((flight, day))
        return self.result


def test_enrich_fills_from_lookup():
    found = Leg("U27891", "AMS", "PMI", D(2027, 3, 5, 11, 40), D(2027, 3, 5, 14, 5))
    look, cache = Lookup(found), {}
    p = booking(Leg("U27891", "", "", None, None, ("KQX7Z2T",), "", date(2027, 3, 5)))
    out = sync.enrich(p, look, cache, NOW, 100)
    assert [(l.flight, l.dep, l.arr, l.dep_local, l.codes) for l in out.legs] == [
        ("U27891", "AMS", "PMI", D(2027, 3, 5, 11, 40), ("KQX7Z2T",))]
    sync.enrich(p, look, cache, NOW, 100)
    assert look.calls == [("U27891", date(2027, 3, 5))]  # second time from the cache


def test_enrich_keeps_email_route_when_lookup_disagrees():
    # one flight number can fly several hops; the email's route is the passenger's
    found = Leg("SP564", "PDL", "SMA", D(2026, 10, 29, 13, 30), D(2026, 10, 29, 14, 5))
    mine = Leg("SP564", "LIS", "PDL", D(2026, 10, 29, 10, 0), D(2026, 10, 29, 11, 45), ("ABC123",))
    assert sync.enrich(booking(mine), Lookup(found), {}, NOW, 100).legs[0] == mine


def test_enrich_takes_lookup_times_for_the_same_route():
    found = Leg("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 30), D(2026, 11, 16, 18, 15))
    mine = Leg("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 10), D(2026, 11, 16, 17, 55), ("ABC123",))
    leg = sync.enrich(booking(mine), Lookup(found), {}, NOW, 100).legs[0]
    assert (leg.dep_local, leg.arr_local, leg.codes) == (D(2026, 11, 16, 16, 30), D(2026, 11, 16, 18, 15), ("ABC123",))


def test_enrich_keeps_email_when_unknown_and_skips_past_and_cap():
    look = Lookup(None)
    keep = Leg("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 10), D(2026, 11, 16, 17, 55), ("ABC123",))
    assert sync.enrich(booking(keep), look, {}, NOW, 100).legs == [keep]
    past = Leg("KL1234", "AMS", "LIS", D(2026, 9, 16, 16, 10), D(2026, 9, 16, 17, 55), ("ABC123",))
    look.calls.clear()
    sync.enrich(booking(past), look, {}, NOW, 100)
    assert look.calls == []
    cache = {"month": "2026-10", "count": 100}
    sync.enrich(booking(keep), look, cache, NOW, 100)
    assert look.calls == []


def test_same_flight_two_dates_in_one_email():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    second = leg(dep_local=D(2026, 11, 23, 16, 10), arr_local=D(2026, 11, 23, 17, 55))
    run(booking(leg(), second), state, cal, con)
    assert sorted(l.dep_local.day for l, _ in cal.events.values()) == [16, 23]
    assert len(con.flights) == 2 and len(state["legs"]) == 2


def bus(dep_local=D(2026, 11, 21, 9, 30), codes=("3000000001",)):
    return Leg("", "Lisboa (Oriente)", "Porto (Campanhã)", dep_local, dep_local.replace(hour=13), codes, "", None,
               "bus", "Europe/Lisbon", "Europe/Lisbon")


def test_ground_leg_goes_to_calendar_and_contrail_with_its_event():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    assert run(booking(bus()), state, cal, con) == []
    assert len(cal.events) == 1 and list(con.flights.values()) == [bus()] and con.events == {1: "ev1"}
    assert state["legs"][0]["flight"] == "bus:Lisboa (Oriente)>Porto (Campanhã)" and state["legs"][0]["contrail_id"] == 1


def test_ground_duplicate_is_an_event_at_the_same_moment():
    start = bus().instants(AIRPORTS)[0]
    cal, con, state = FakeCalendar(foreign_at={start}), FakeContrail(), {}
    run(booking(bus()), state, cal, con)
    assert cal.events == {} and con.events == {1: None}  # Contrail merges it with the calendar's trip at that minute
    assert state["legs"][0]["event_id"] is None and state["legs"][0]["contrail_id"] == 1


def test_ground_cancel_by_booking_code_only():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(bus()), state, cal, con)
    assert run(Parsed("cancel", [], [], False, [], date(2026, 11, 1), ("3000000001",)), state, cal, con) == []
    assert cal.events == {} and con.flights == {} and state["legs"] == []


def test_enrich_skips_ground_legs():
    look = Lookup(None)
    sync.enrich(booking(bus()), look, {}, NOW, 100)
    assert look.calls == []


def test_seen_records_every_future_flight_i_am_on():
    cal, con, state = FakeCalendar(foreign={("KL1234", date(2026, 11, 16))}), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    assert list(state["seen"]) == ["KL1234@2026-11-16"]
    assert state["seen"]["KL1234@2026-11-16"]["codes"] == ["ABC123"]
    run(booking(bus()), state, cal, con)
    assert list(state["seen"]) == ["KL1234@2026-11-16"]  # flights only


def test_seen_follows_schedule_change_and_cancel():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    moved = leg(dep_local=D(2026, 11, 17, 9, 0), arr_local=D(2026, 11, 17, 10, 45))
    run(booking(moved, kind="change"), state, cal, con)
    assert list(state["seen"]) == ["KL1234@2026-11-17"]
    run(booking(Leg("KL1234", "AMS", "LIS", None, None, ("ABC123",)), kind="cancel"), state, cal, con)
    assert state["seen"] == {}


def test_seen_drops_rebooked_old_legs():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(leg()), state, cal, con)
    new = leg(flight="AF1229", dep="AMS", arr="MAD", dep_local=D(2026, 11, 17, 6, 50), arr_local=D(2026, 11, 17, 9, 15))
    old = Leg("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 10), None, ("ABC123",))
    run(booking(new, kind="change", old=[old]), state, cal, con)
    assert list(state["seen"]) == ["AF1229@2026-11-17"]


def test_other_kind_does_nothing():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    assert run(booking(leg(), kind="other"), state, cal, con) == []
    assert cal.events == {} and con.flights == {}



def test_ground_legs_are_tracked_for_busy_blocks():
    cal, con, state = FakeCalendar(), FakeContrail(), {}
    run(booking(bus()), state, cal, con)
    (sid, row), = state["ground"].items()
    assert row["mode"] == "bus" and row["tz"] == ["Europe/Lisbon", "Europe/Lisbon"] and row["dep_local"] == bus().dep_local.isoformat()
    run(Parsed("cancel", [], [], False, [], date(2026, 11, 1), ("3000000001",)), state, cal, con)
    assert state["ground"] == {}
    start = bus().instants(AIRPORTS)[0]  # also when the event was not made by flightmail
    state = {}
    run(booking(bus()), state, FakeCalendar(foreign_at={start}), con)
    assert len(state["ground"]) == 1

if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_")]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
