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


def ride(dep, arr, t0, t1, code, mode="bus", number=""):
    return {"flight": number or f"{mode}:{dep}>{arr}", "dep": dep, "arr": arr, "dep_local": t0, "arr_local": t1,
            "codes": [code], "mode": mode, "tz": ["Europe/Lisbon", "Europe/Lisbon"]}


def test_trains_and_buses_join_the_doc_of_their_days():
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [rows(PLAN, ["Faro", "10–14.11.26", "", "", ""]),
                                                               rows(TRANSPORT, ["✈️ X1: A - B", "13.11.26 08:00", "", ""], ["", "", "", ""])]}})
    state = {"ground": {"a": ride("Faro", "Lagos", "2026-11-12T15:30:00", "2026-11-12T17:00:00", "B1"),
                        "b": ride("Lagos", "Lisboa (Oriente)", "2026-11-14T09:00:00", "2026-11-14T13:00:00", "T1", "train", "IC571")}}
    tripdocs.TripDocs(g, "folder", lambda m: None).run(state, AIRPORTS, NOW, ["AMS"])
    assert texts(g.docs["d1"]["tables"][1])[1:] == [["🚌 Faro - Lagos", "12.11.26 15:30", "", "Booking code: B1"],  # in time order
                                                   ["✈️ X1: A - B", "13.11.26 08:00", "", ""],
                                                   ["🚆 IC571: Lagos - Lisboa (Oriente)", "14.11.26 09:00", "", "Booking code: T1"]]
    assert not g.created


def test_a_ride_without_a_doc_waits_for_one():
    g = FakeGoogle({})
    state = {"ground": {"a": ride("Faro", "Lagos", "2026-11-12T15:30:00", "2026-11-12T17:00:00", "B1")}}
    docs = tripdocs.TripDocs(g, "folder", lambda m: None)
    docs.run(state, AIRPORTS, NOW, ["AMS"])
    assert not g.created  # a bus alone makes no doc
    state["stays"] = {"1": stay("1", "Faro", "2026-11-11", "2026-11-13")}
    docs.run(state, AIRPORTS, NOW, ["AMS"])  # the stay makes one, and the bus joins it
    assert g.created == ["Portugal 2026"]
    assert texts(g.docs["new1"]["tables"][1])[1] == ["🚌 Faro - Lagos", "12.11.26 15:30", "", "Booking code: B1"]


def test_rental_car_without_its_stay_goes_to_transport():
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [rows(PLAN, ["Faro", "10–11.11.26", "", "", ""]), rows(TRANSPORT)]}})
    car = {"what": "car", "code": "D2", "place": "Lagos", "country": "Portugal", "start": "2026-11-12", "end": "2026-11-16",
           "type": "Rental car", "price": "50€", "link": "https://example.com/car"}
    tripdocs.TripDocs(g, "folder", lambda m: None).run({"stays": {"D2": car}}, AIRPORTS, NOW, ["AMS"])
    assert texts(g.docs["d1"]["tables"][1])[1] == ["Rental car", "12–16.11.26", "50€", "Lagos"]


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


class ParaGoogle(FakeGoogle):
    """A doc with a Plan table and then paragraphs, kept as one string with a style and a bullet flag per paragraph;
    applies the requests suggestion_requests makes, and exports Markdown like Drive."""

    def __init__(self, plan, paras, modified="2026-10-01T10:00:00Z"):
        super().__init__({"d1": {"name": "Faro 2026", "tables": [plan]}})
        self.text = "".join(t + "\n" for t, _ in paras)
        self.styles, self.bullets, self.bold = [s for _, s in paras], [False] * len(paras), []
        self.modified_at, self.calls = modified, 0

    def docs_in(self, folder):
        return [{"id": "d1", "name": "Faro 2026", "modifiedTime": self.modified_at}]

    def modified(self, doc_id):
        return self.modified_at

    def _start(self):
        return self._build("d1")[0]["body"]["content"][-1]["endIndex"]

    def paras(self):
        return list(zip(self.text.split("\n")[:-1], self.styles, self.bullets))

    def get(self, doc_id):
        doc, i = self._build(doc_id)[0], self._start()
        for t, style, _ in self.paras():
            doc["body"]["content"].append({"startIndex": i, "endIndex": i + len(t) + 1, "paragraph": {
                "elements": [{"textRun": {"content": t + "\n"}}], "paragraphStyle": {"namedStyleType": style}}})
            i += len(t) + 1
        return doc

    def export(self, doc_id):
        table = "\n".join("| " + " | ".join(c["text"] for c in row) + " |" for row in self.docs["d1"]["tables"][0])
        lines = [f"# **{t}**" if s == "HEADING_1" else f"## **{t}**" if s == "HEADING_2" else f"* {t}" if b else t
                 for t, s, b in self.paras()]
        return table + "\n\n" + "\n\n".join(lines)

    def _para(self, k):
        return self.text[:k].count("\n")

    def batch(self, doc_id, requests):
        self.calls += 1
        t0 = self._start()
        for q in requests:
            (kind, body), = q.items()
            rng = body.get("range") or {}
            a, b = rng.get("startIndex", 0) - t0, rng.get("endIndex", 0) - t0
            if kind == "insertText":
                k, ins = body["location"]["index"] - t0, body["text"]
                p, n = self._para(k), ins.count("\n")
                self.styles[p:p] = [self.styles[p]] * n
                self.bullets[p:p] = [self.bullets[p]] * n
                self.text = self.text[:k] + ins + self.text[k:]
            elif kind == "deleteContentRange":
                p, n = self._para(a), self.text[a:b].count("\n")
                del self.styles[p:p + n], self.bullets[p:p + n]
                self.text = self.text[:a] + self.text[b:]
            elif kind == "updateParagraphStyle":
                for p in range(self._para(a), self._para(b - 1) + 1):
                    self.styles[p] = body["paragraphStyle"]["namedStyleType"]
            elif kind in ("createParagraphBullets", "deleteParagraphBullets"):
                for p in range(self._para(a), self._para(b - 1) + 1):
                    self.bullets[p] = kind == "createParagraphBullets"
            elif kind == "updateTextStyle" and body["textStyle"].get("bold"):
                self.bold.append(self.text[a:b])


REPLY = """```json
{"things_to_do": [{"place": "Faro", "items": ["Walk the old town walls.", "Take the boat to Ilha Deserta."]}],
 "itinerary": [{"date": "2026-11-13", "place": "Faro", "plan": "Fly home at 16:10."},
               {"date": "2026-11-12", "place": "Faro", "plan": "Arrive, walk the old town."}]}
```"""
FARO = rows(PLAN, ["Faro", "12–13.11.26", "Hostel", "", ""])


def suggest(g, now=NOW, dry=False, state=None):
    asked, log = [], []
    state = {} if state is None else state
    tripdocs.TripDocs(g, "folder", log.append, dry=dry).suggest(state, now, lambda p: asked.append(p) or REPLY)
    return state, asked, log


def test_suggestions_are_written_then_replaced_when_the_doc_changes():
    g = ParaGoogle(FARO, [("Information", "HEADING_1"), ("Bring a towel", "NORMAL_TEXT"), ("", "NORMAL_TEXT")])
    state, asked, log = suggest(g)
    assert len(asked) == 1 and "Bring a towel" in asked[0] and "from 12.11.26" in asked[0], asked
    assert "https://" not in asked[0]
    got = [(t, s, b) for t, s, b in g.paras()]
    assert got[:2] == [("Information", "HEADING_1", False), ("Bring a towel", "NORMAL_TEXT", False)], got
    assert got[2] == ("Suggestions", "HEADING_1", False) and got[3][0].startswith("By flightmail on 01.11.26"), got
    assert got[4:] == [("Things to do", "HEADING_2", False), ("Faro", "NORMAL_TEXT", False),
                       ("Walk the old town walls.", "NORMAL_TEXT", True), ("Take the boat to Ilha Deserta.", "NORMAL_TEXT", True),
                       ("Itinerary", "HEADING_2", False), ("Thu 12.11, Faro: Arrive, walk the old town.", "NORMAL_TEXT", True),
                       ("Fri 13.11, Faro: Fly home at 16:10.", "NORMAL_TEXT", True)], got
    assert "Thu 12.11, Faro:" in g.bold and "Faro" in g.bold
    assert suggest(g, state=state)[1] == []  # unchanged
    g.modified_at = "2026-10-02T10:00:00Z"
    assert suggest(g, state=state)[1] == []  # touched, but the same text: no new question
    g.text = g.text.replace("Bring a towel", "Bring a towel and a surfboard")
    g.modified_at = "2026-11-01T11:50:00Z"
    assert suggest(g, state=state)[1] == []  # changed ten minutes ago: maybe still typing
    g.modified_at = "2026-11-01T09:00:00Z"
    state, asked, _ = suggest(g, state=state)
    assert len(asked) == 1 and "surfboard" in asked[0] and "Ilha Deserta" not in asked[0]
    assert [t for t, _, _ in g.paras()].count("Suggestions") == 1
    assert g.paras()[1][0] == "Bring a towel and a surfboard" and g.paras()[-1][0].startswith("Fri 13.11")


def test_suggestions_before_a_later_heading_keep_it():
    g = ParaGoogle(FARO, [("Information", "HEADING_1"), ("Suggestions", "HEADING_1"), ("By flightmail on 01.10.26", "NORMAL_TEXT"),
                          ("old idea", "NORMAL_TEXT"), ("Notes", "HEADING_1"), ("mine", "NORMAL_TEXT"), ("", "NORMAL_TEXT")])
    state = {"docs": {"suggested": {"d1": {"modified": "old", "hash": "old"}}}}
    _, asked, _ = suggest(g, state=state)
    texts_ = [t for t, _, _ in g.paras()]
    assert len(asked) == 1 and "old idea" not in texts_ and "old idea" not in asked[0], texts_
    assert texts_[-3:] == ["Notes", "mine", ""] and texts_[texts_.index("Notes") - 1].startswith("Fri 13.11"), texts_


def test_no_suggestions_for_past_trips_dry_runs_or_docs_that_have_them():
    g = ParaGoogle(rows(PLAN, ["Faro", "12–13.10.26", "", "", ""]), [("", "NORMAL_TEXT")])
    state, asked, _ = suggest(g)
    assert asked == [] and g.calls == 0 and state["docs"]["suggested"]["d1"] == {"modified": "2026-10-01T10:00:00Z"}
    g = ParaGoogle(FARO, [("", "NORMAL_TEXT")])
    _, asked, log = suggest(g, dry=True)
    assert asked == [] and g.calls == 0 and log == ["would ask Claude for suggestions for doc 'Faro 2026'"], log
    g = ParaGoogle(FARO, [("Suggestions", "HEADING_1"), ("By flightmail on 01.10.26", "NORMAL_TEXT"), ("", "NORMAL_TEXT")])
    state, asked, _ = suggest(g)  # state lost: the section is kept until the doc changes
    assert asked == [] and state["docs"]["suggested"]["d1"]["hash"]


def test_reply_and_markdown_helpers():
    data = tripdocs.parse_reply("Here you go:\n" + REPLY)
    assert [d["date"] for d in data["itinerary"]] == [date(2026, 11, 12), date(2026, 11, 13)]
    md = "# **Plan**\n\n| Faro |\n\n# **Suggestions**\n\n*By flightmail on 01.11.26*\n\n## **Itinerary**\n\n# **Notes**\n\nmine"
    assert tripdocs.without_suggestions(md) == "# **Plan**\n\n| Faro |\n\n# **Notes**\n\nmine"
    assert tripdocs._plain("[Hostel](https://x.example/?a=1) 20€") == "Hostel 20€"
    assert tripdocs._plain("| ✈️ U27883 | 03.02.27 07:00 |  | Booking code: ABC123, 26002 |") == "| ✈️ U27883 | 03.02.27 07:00 |  | |"


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
