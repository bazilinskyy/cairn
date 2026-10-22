"""Tests for plan.py (check-in to-dos, busy blocks, trip banners). Run: python mail/test_plan.py."""
import sys
from datetime import date, datetime as D
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse import Airport  # noqa: E402
import plan  # noqa: E402

AP = {"AMS": Airport("Schiphol", "Amsterdam", "Europe/Amsterdam", "Netherlands"),
      "EIN": Airport("Eindhoven Airport", "Eindhoven", "Europe/Amsterdam", "Netherlands"),
      "LIS": Airport("Humberto Delgado", "Lisbon", "Europe/Lisbon", "Portugal"),
      "PDL": Airport("João Paulo II", "Ponta Delgada", "Atlantic/Azores", "Portugal"),
      "TFS": Airport("Tenerife South", "Tenerife", "Atlantic/Canary", "Spain"),
      "MAD": Airport("Barajas", "Madrid", "Europe/Madrid", "Spain"),
      "CDG": Airport("Charles de Gaulle", "Paris", "Europe/Paris", "France")}
HOME = ["AMS", "EIN"]
NOW = D(2026, 10, 22, 8, 0)


def row(flight, dep, arr, t0, t1, codes=("ABC123",), url=""):
    return {"flight": flight, "dep": dep, "arr": arr, "dep_local": t0.isoformat(), "arr_local": t1.isoformat(),
            "codes": list(codes), "checkin_url": url}


def test_todo_day_before_with_link():
    r = row("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 10), D(2026, 11, 16, 17, 55), url="https://example.com/ci")
    t = plan.todo(r, AP, NOW)
    assert t == {"title": "Check in ✈️ KL1234: Amsterdam - Lisbon", "when": "2026-11-15",
                 "notes": "https://example.com/ci\nBooking code: ABC123"}


def test_todo_uses_airline_link_and_never_the_past():
    r = row("FR8302", "EIN", "TFS", D(2026, 10, 22, 19, 40), D(2026, 10, 22, 23, 40))
    t = plan.todo(r, AP, NOW)
    assert t["when"] == "2026-10-22" and t["notes"].startswith("https://www.ryanair.com/")


def test_block_two_hours_before_one_after():
    r = row("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 10), D(2026, 11, 16, 17, 55))
    start, end = plan.block(r, AP)
    assert (start.isoformat(), end.isoformat()) == ("2026-11-16T14:10:00+01:00", "2026-11-16T18:55:00+00:00")


def test_trip_single_place():
    rows = [row("U27883", "AMS", "TFS", D(2027, 2, 3, 7, 0), D(2027, 2, 3, 11, 50)),
            row("U27884", "TFS", "AMS", D(2027, 2, 11, 16, 30), D(2027, 2, 11, 22, 10))]
    assert plan.trips(rows, HOME, AP) == [{"id": "U27883@2027-02-03", "name": "Tenerife", "start": "2027-02-03", "end": "2027-02-11"}]


def test_trip_several_stops_same_country_and_connections():
    rows = [row("KL1500", "AMS", "LIS", D(2026, 11, 2, 9, 0), D(2026, 11, 2, 11, 0)),
            row("S4127", "LIS", "PDL", D(2026, 11, 5, 10, 0), D(2026, 11, 5, 11, 45)),
            row("S4128", "PDL", "LIS", D(2026, 11, 9, 13, 0), D(2026, 11, 9, 16, 30)),
            row("TP662", "LIS", "AMS", D(2026, 11, 9, 18, 0), D(2026, 11, 9, 21, 45))]  # same-day connection, no stay
    assert plan.trips(rows, HOME, AP) == [{"id": "KL1500@2026-11-02", "name": "Portugal", "start": "2026-11-02", "end": "2026-11-09"}]


def test_trip_several_countries_and_open_trips():
    rows = [row("KL1", "AMS", "MAD", D(2026, 12, 1, 9, 0), D(2026, 12, 1, 11, 30)),
            row("AF2", "MAD", "CDG", D(2026, 12, 4, 9, 0), D(2026, 12, 4, 11, 0)),
            row("AF3", "CDG", "AMS", D(2026, 12, 7, 9, 0), D(2026, 12, 7, 10, 15)),
            row("KL9", "AMS", "LIS", D(2027, 1, 5, 9, 0), D(2027, 1, 5, 11, 0))]  # no return yet: no banner
    assert [t["name"] for t in plan.trips(rows, HOME, AP)] == ["Spain · France"]


def test_reconcile():
    desired = {"a": {"x": 1}, "b": {"x": 2}}
    owned = {"b": {"ref": "B", "spec": {"x": 1}}, "c": {"ref": "C", "spec": {"x": 3}}}
    assert plan.reconcile(desired, owned) == {"create": ["a"], "update": ["b"], "remove": ["c"]}


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f) and hasattr(f, "__code__")]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
