"""Tests for tripdocs.py against a fake Google Docs that applies the requests. Run: python mail/test_tripdocs.py."""
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import tripdocs  # noqa: E402
from parse import Airport  # noqa: E402

PLAN = ["Place", "Dates", "Accommodation", "Price", "Comments"]
TRANSPORT = ["Transport", "Date", "Price", "Comments"]


class FakeGoogle:
    """Docs kept as tables of {"text", "link"} cells; get() builds the API's JSON with real indexes, batch() applies
    insertText / updateTextStyle / deleteContentRange / insertTableRow the way the API does, one after another."""

    def __init__(self, docs):
        self.docs = docs  # id -> {"name", "tables": [[[cell]]]}
        self.created = []

    def docs_in(self, folder):
        return [{"id": i, "name": d["name"]} for i, d in self.docs.items()]

    def _build(self, doc_id):
        i, content, where = 1, [], []
        for t, table in enumerate(self.docs[doc_id]["tables"]):
            el = {"startIndex": i, "table": {"tableRows": []}}
            i += 1
            for r, row in enumerate(table):
                i += 1
                cells = []
                for c, cell in enumerate(row):
                    start, text = i, cell["text"] + "\n"
                    run = {"content": text, **({"textStyle": {"link": {"url": cell["link"]}}} if cell.get("link") else {})}
                    cells.append({"startIndex": start, "endIndex": start + 1 + len(text), "content": [{"paragraph": {
                        "elements": [{"startIndex": start + 1, "endIndex": start + 1 + len(text), "textRun": run}]}}]})
                    where.append((start + 1, start + len(text), t, r, c))
                    i = start + 1 + len(text)
                el["table"]["tableRows"].append({"tableCells": cells})
            el["endIndex"] = i
            content.append(el)
            i += 1
        return {"body": {"content": content}}, where

    def get(self, doc_id):
        return self._build(doc_id)[0]

    def _at(self, doc_id, index):
        doc, where = self._build(doc_id)
        for p, last, t, r, c in where:
            if p <= index <= last:
                return self.docs[doc_id]["tables"][t][r][c], p
        raise AssertionError(f"index {index} is not in a cell")

    def batch(self, doc_id, requests):
        for q in requests:
            if "insertText" in q:
                cell, p = self._at(doc_id, q["insertText"]["location"]["index"])
                k = q["insertText"]["location"]["index"] - p
                cell["text"] = cell["text"][:k] + q["insertText"]["text"] + cell["text"][k:]
            elif "updateTextStyle" in q:
                rng, style = q["updateTextStyle"]["range"], q["updateTextStyle"]["textStyle"]
                cell, p = self._at(doc_id, rng["startIndex"])
                if "link" in style:
                    cell["link"] = style["link"]["url"]
                    cell["linked"] = cell["text"][rng["startIndex"] - p:rng["endIndex"] - p]
                elif "link" in q["updateTextStyle"]["fields"]:
                    cell.pop("link", None)
            elif "deleteContentRange" in q:
                rng = q["deleteContentRange"]["range"]
                cell, p = self._at(doc_id, rng["startIndex"])
                cell["text"] = cell["text"][:rng["startIndex"] - p] + cell["text"][rng["endIndex"] - p:]
                if not cell["text"]:
                    cell.pop("link", None)
            elif "insertTableRow" in q:
                loc = q["insertTableRow"]["tableCellLocation"]
                doc, _ = self._build(doc_id)
                t = next(n for n, el in enumerate(doc["body"]["content"]) if el["startIndex"] == loc["tableStartLocation"]["index"])
                table = self.docs[doc_id]["tables"][t]
                table.insert(loc["rowIndex"] + 1, [{"text": ""} for _ in table[0]])

    def create(self, folder, name):
        doc_id = f"new{len(self.created) + 1}"
        self.created.append(name)
        self.docs[doc_id] = {"name": name, "tables": [[[{"text": h} for h in PLAN]], [[{"text": h} for h in TRANSPORT]]]}
        return doc_id


def rows(*texts):
    return [[t if isinstance(t, dict) else {"text": t} for t in row] for row in texts]


def texts(table):
    return [[c["text"] for c in row] for row in table]


AIRPORTS = {"AMS": Airport("Schiphol", "Amsterdam", "Europe/Amsterdam", "Netherlands"),
            "FAO": Airport("Faro", "Faro", "Europe/Lisbon", "Portugal"),
            "LIS": Airport("Lisbon", "Lisbon", "Europe/Lisbon", "Portugal")}
NOW = datetime(2026, 11, 1, 12, 0)


def stay(code, place, start, end, **kw):
    return {"what": "stay", "code": code, "place": place, "country": "Portugal", "start": start, "end": end,
            "type": "Hostel", "price": "20€", "link": f"https://example.com/b/{code}", **kw}


def test_dates():
    for text, want in [("24–26.09.26", (date(2026, 9, 24), date(2026, 9, 26))),
                       ("31.08–01.09.26", (date(2026, 8, 31), date(2026, 9, 1))),
                       ("31.12.26–01.01.27", (date(2026, 12, 31), date(2027, 1, 1))),
                       ("07.12.26 16:10", (date(2026, 12, 7), date(2026, 12, 7))), ("", None), ("Hostel", None)]:
        assert tripdocs.parse_dates(text) == want, text
        if want and want[0] != want[1]:
            assert tripdocs.fmt_dates(*want) == text


def test_fills_the_row_of_that_place_and_keeps_user_text():
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [
        rows(PLAN, ["Faro", "12–13.11.26", "", "", "my note"], ["Lisbon", "13–15.11.26", "Friend's flat", "", ""],
             ["Lagos", "15–16.11.26", {"text": "Hostel", "link": "https://example.com/x?bn=5"}, "", ""]),
        rows(TRANSPORT, ["", "", "", ""])]}})
    state = {"stays": {"1": stay("1", "Faro", "2026-11-12", "2026-11-13"),
                       "2": stay("2", "Lisbon", "2026-11-13", "2026-11-15", type="Flat", price="99€"),
                       "5": stay("5", "Lagos", "2026-11-15", "2026-11-16", price="12€")}}
    tripdocs.TripDocs(g, "folder", lambda m: None).run(state, AIRPORTS, NOW, ["AMS"])
    plan = g.docs["d1"]["tables"][0]
    assert texts(plan)[1] == ["Faro", "12–13.11.26", "Hostel", "20€", "my note"], texts(plan)
    assert plan[1][2]["link"] == "https://example.com/b/1"
    assert texts(plan)[2] == ["Lisbon", "13–15.11.26", "Friend's flat", "99€", ""], texts(plan)  # own text kept
    assert texts(plan)[3] == ["Lagos", "15–16.11.26", "Hostel", "12€", ""], texts(plan)  # linked by you: price still filled
    assert not g.created


def test_new_rows_in_date_order_then_cancel_empties_cells():
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [
        rows(PLAN, ["Faro", "10–12.11.26", "Hotel", "", ""], ["Lisbon", "14–15.11.26", "", "", ""]), rows(TRANSPORT)]}})
    state = {"stays": {"3": stay("3", "Évora", "2026-11-12", "2026-11-14")}}
    docs = tripdocs.TripDocs(g, "folder", lambda m: None)
    docs.run(state, AIRPORTS, NOW, ["AMS"])
    assert [r[0] for r in texts(g.docs["d1"]["tables"][0])] == ["Place", "Faro", "Évora", "Lisbon"]
    assert texts(g.docs["d1"]["tables"][0])[2] == ["Évora", "12–14.11.26", "Hostel", "20€", ""]
    state["stays"]["3"]["cancelled"] = True
    docs.run(state, AIRPORTS, NOW, ["AMS"])
    assert texts(g.docs["d1"]["tables"][0])[2] == ["Évora", "12–14.11.26", "", "", ""]  # place and dates stay
    assert state["docs"]["done"] == {}


def test_flights_go_to_transport_and_a_new_doc():
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [rows(PLAN, ["Faro", "10–12.11.26", "", "", ""]), rows(TRANSPORT)]}})
    seen = {"FR1@2027-02-28": {"flight": "FR1", "dep": "AMS", "arr": "FAO", "dep_local": "2027-02-28T10:00:00",
                               "arr_local": "2027-02-28T12:00:00", "codes": ["ABC123"]},
            "FR2@2027-03-05": {"flight": "FR2", "dep": "FAO", "arr": "AMS", "dep_local": "2027-03-05T13:00:00",
                               "arr_local": "2027-03-05T17:00:00", "codes": ["ABC123"]}}
    state = {"seen": seen}
    docs = tripdocs.TripDocs(g, "folder", lambda m: None)
    docs.run(state, AIRPORTS, NOW, ["AMS"])
    assert g.created == ["Faro 2027"], g.created
    assert texts(g.docs["new1"]["tables"][1])[1:] == [["✈️ FR1: Amsterdam - Faro", "28.02.27 10:00", "", "Booking code: ABC123"],
                                                     ["✈️ FR2: Faro - Amsterdam", "05.03.27 13:00", "", "Booking code: ABC123"]]
    docs.run(state, AIRPORTS, NOW, ["AMS"])  # nothing new: nothing written twice
    assert len(g.docs["new1"]["tables"][1]) == 3
    state["stays"] = {"4": stay("4", "Faro", "2027-02-28", "2027-03-05")}
    docs.run(state, AIRPORTS, NOW, ["AMS"])  # a stay in the same days joins that doc
    assert texts(g.docs["new1"]["tables"][0])[1][:3] == ["Faro", "28.02–05.03.27", "Hostel"]
    del seen["FR2@2027-03-05"]
    docs.run(state, AIRPORTS, NOW, ["AMS"])
    assert texts(g.docs["new1"]["tables"][1])[2] == ["", "", "", ""]


def test_rental_car_in_comments():
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [
        rows(PLAN, ["Faro", "10–12.11.26", "", "", ""], ["Lagos", "12–14.11.26", "", "", "beach"]), rows(TRANSPORT)]}})
    car = {"what": "car", "code": "D1", "place": "Faro", "country": "Portugal", "start": "2026-11-12", "end": "2026-11-16",
           "type": "Rental car", "price": "50€", "link": "https://example.com/car"}
    tripdocs.TripDocs(g, "folder", lambda m: None).run({"stays": {"D1": car}}, AIRPORTS, NOW, ["AMS"])
    cell = g.docs["d1"]["tables"][0][2][4]
    assert (cell["text"], cell["linked"], cell["link"]) == ("beach Rental car 12–16.11", "Rental car", "https://example.com/car"), cell


def test_lone_flight_home_names_the_doc_after_where_it_left():
    g = FakeGoogle({})
    seen = {"FR9@2026-12-07": {"flight": "FR9", "dep": "FAO", "arr": "AMS", "dep_local": "2026-12-07T16:00:00",
                               "arr_local": "2026-12-07T20:00:00", "codes": []}}
    tripdocs.TripDocs(g, "folder", lambda m: None).run({"seen": seen}, AIRPORTS, NOW, ["AMS"])
    assert g.created == ["Faro 2026"], g.created


def test_dry_run_writes_nothing():
    g = FakeGoogle({})
    log = []
    state = {"stays": {"1": stay("1", "Faro", "2026-11-12", "2026-11-13")}}
    tripdocs.TripDocs(g, "folder", log.append, dry=True).run(state, AIRPORTS, NOW, ["AMS"])
    assert not g.created and not g.docs
    assert log[0] == "would create doc 'Portugal 2026'", log
    assert any("Hostel" in m for m in log), log


def test_skipped_bookings_get_no_doc():
    state = {"stays": {"1": stay("1", "Faro", "2026-11-12", "2026-11-13"), "2": stay("2", "Lagos", "2026-11-13", "2026-11-14")}}
    assert list(tripdocs.wanted(state, AIRPORTS, NOW, ["AMS"], skip={"1"})) == ["stay:2"]


def test_past_items_are_left_alone():
    state = {"stays": {"1": stay("1", "Faro", "2026-10-01", "2026-10-03")}}
    assert tripdocs.wanted(state, AIRPORTS, NOW, ["AMS"]) == {}


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
