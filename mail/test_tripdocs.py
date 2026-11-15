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
            elif "deleteTableRow" in q:
                loc = q["deleteTableRow"]["tableCellLocation"]
                doc, _ = self._build(doc_id)
                t = next(n for n, el in enumerate(doc["body"]["content"]) if el["startIndex"] == loc["tableStartLocation"]["index"])
                del self.docs[doc_id]["tables"][t][loc["rowIndex"]]

    def create(self, folder, name):
        doc_id = f"new{len(self.created) + 1}"
        self.created.append(name)
        self.docs[doc_id] = {"name": name, "tables": [[[{"text": h} for h in heads]] +
                                                      [[{"text": ""} for _ in heads] for _ in range(tripdocs.EMPTY_ROWS)]
                                                      for heads in (PLAN, TRANSPORT)]}  # as TEMPLATE
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
                                                     ["✈️ FR2: Faro - Amsterdam", "05.03.27 13:00", "", "Booking code: ABC123"],
                                                     ["", "", "", ""]]  # the new doc's empty rows filled in turn
    docs.run(state, AIRPORTS, NOW, ["AMS"])  # nothing new: nothing written twice
    assert len(g.docs["new1"]["tables"][1]) == 4
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


def test_rental_car_and_its_stay_of_the_same_day():  # booked together: the stay's new row first, the car in it
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [rows(PLAN), rows(TRANSPORT, ["✈️ X1: Eindhoven - Faro", "10.12.26 13:45", "", ""])]}})
    car = {"what": "car", "code": "C1", "place": "Faro - Airport", "country": "", "start": "2026-12-10", "end": "2026-12-14",
           "type": "Rental car", "price": "", "link": "https://example.com/car"}
    flat = stay("S1", "Lagos", "2026-12-10", "2026-12-14")
    tripdocs.TripDocs(g, "folder", lambda m: None).run({"stays": {"C1": car, "S1": flat}}, AIRPORTS, NOW, ["AMS"])
    plan, transport = g.docs["d1"]["tables"]
    assert [c["text"] for c in plan[1]][:2] == ["Lagos", "10–14.12.26"] and "Rental car" in plan[1][4]["text"], plan
    assert len(transport) == 2, transport

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



def test_tables_without_data_get_three_empty_rows_and_a_stay_fills_the_first():
    g = FakeGoogle({"d1": {"name": "Portugal 2026", "tables": [rows(PLAN), rows(TRANSPORT, ["", "", "", ""])]},
                    "d2": {"name": "Spain 2026", "tables": [rows(PLAN, ["Madrid", "01–03.12.26", "", "", ""]), rows(TRANSPORT)]}})
    state = {"stays": {"1": stay("1", "Faro", "2026-11-12", "2026-11-13")}}
    docs = tripdocs.TripDocs(g, "folder", lambda m: None)
    docs.run(state, AIRPORTS, NOW, ["AMS"])
    plan, transport = g.docs["d1"]["tables"]  # no dates, so not this trip's doc, but brought up to three rows
    assert texts(plan)[1:] == [["", "", "", "", ""]] * 3 and texts(transport)[1:] == [["", "", "", ""]] * 3
    assert texts(g.docs["d2"]["tables"][0])[1:] == [["Madrid", "01–03.12.26", "", "", ""]]  # has data: left as it is
    assert len(g.docs["d2"]["tables"][1]) == 4
    g.docs["d3"] = {"name": "Spain 2025", "tables": [rows(PLAN), rows(TRANSPORT, ["✈️ X1: A - B", "01.05.25 08:00", "", ""])]}
    state["stays"]["2"] = stay("2", "Lagos", "2026-11-20", "2026-11-21")
    docs.run(state, AIRPORTS, NOW, ["AMS"])
    assert len(g.docs["d3"]["tables"][0]) == 1  # a trip that is over is left as it is
    assert tripdocs.over("Turkey 2021", None, NOW.date()) and not tripdocs.over("Asia winter 2026", None, NOW.date())
    assert not tripdocs.over("Yellowstone", None, NOW.date())
    assert texts(g.docs["new1"]["tables"][0])[1:] == [["Faro", "12–13.11.26", "Hostel", "20€", ""], ["", "", "", "", ""],
                                                     ["", "", "", "", ""]]  # the first empty row filled


def test_new_docs_are_noted_and_shared_by_link():
    g = FakeGoogle({})
    docs = tripdocs.TripDocs(g, "folder", lambda m: None)
    docs.run({"stays": {"1": stay("1", "Faro", "2026-11-12", "2026-11-13")}}, AIRPORTS, NOW, ["AMS"])
    assert docs.created == {"new1": "Portugal 2026"}

    class Calls(tripdocs.Google):
        def __init__(self, template=None):
            self.calls, self.template = [], template

        def call(self, method, url, body=None, data=None, ctype="application/json"):
            self.calls.append((method, url.rsplit("/", 2)[-2:], body))
            return {"id": "doc9", "body": {"content": []}}
    c = Calls()
    assert c.create("folder", "Faro 2027") == "doc9"
    assert ("POST", ["doc9", "permissions"], {"type": "anyone", "role": "writer", "allowFileDiscovery": False}) in c.calls
    c = Calls("tpl")  # with a template doc: a copy of it in the folder, shared, and nothing else
    assert c.create("folder", "Faro 2027") == "doc9"
    assert [m for m, *_ in c.calls] == ["POST", "POST"]
    assert c.calls[0] == ("POST", ["tpl", "copy"], {"name": "Faro 2027", "parents": ["folder"]})


def test_restyle_gives_new_docs_the_users_look():
    def para(start, text, named="NORMAL_TEXT", **style):
        return {"startIndex": start, "endIndex": start + len(text) + 1, "paragraph": {
            "paragraphStyle": {"namedStyleType": named, **style}, "elements": [{"textRun": {"content": text + "\n"}}]}}

    def table(start, head, pad, widths, font={}):
        cell = lambda t: {"startIndex": start, "endIndex": start + 2, "tableCellStyle": {k: {"unit": "PT", **({"magnitude": pad} if pad else {})} for k in tripdocs.PADS},
                          "content": [{"paragraph": {"elements": [{"startIndex": start + 1, "textRun": {"content": t + "\n", "textStyle": font}}]}}]}
        return {"startIndex": start, "endIndex": start + 60, "table": {"tableRows": [{"tableCells": [cell(h) for h in head]}],
                "tableStyle": {"tableColumnProperties": [{"width": {"magnitude": w}} for w in widths]}}}
    pt = {"magnitude": 24, "unit": "PT"}
    made = {"body": {"content": [para(1, "Information", "HEADING_1"), para(13, "", spaceBelow=pt),
                                 para(14, "Plan", "HEADING_1", spaceAbove={"unit": "PT"}),
                                 table(20, ["Place", "Dates", "Accommodation", "Price", "Comments"], 0, [93.6] * 5),
                                 para(90, "Transport", "HEADING_1"), table(100, ["Transport", "Date", "Price", "Comments"], 0, [93.6] * 4)]}}
    r = tripdocs.restyle(made)
    paras = [x["updateParagraphStyle"] for x in r if "updateParagraphStyle" in x]
    assert [(p["range"]["startIndex"], p["fields"], p["paragraphStyle"]) for p in paras] == [
        (1, "alignment", {"alignment": "CENTER"}), (13, "spaceBelow", {}), (14, "spaceAbove,alignment", {"alignment": "CENTER"}),
        (90, "alignment", {"alignment": "CENTER"})]
    pads = [x["updateTableCellStyle"] for x in r if "updateTableCellStyle" in x]
    assert [p["tableStartLocation"]["index"] for p in pads] == [20, 100]
    assert pads[0]["tableCellStyle"]["paddingTop"] == {"magnitude": 5, "unit": "PT"}
    fonts = [x["updateTextStyle"] for x in r if "updateTextStyle" in x]
    assert [(f["range"]["startIndex"], f["textStyle"]) for f in fonts] == [(20, tripdocs.CELL_FONT), (100, tripdocs.CELL_FONT)]
    widths = [(x["updateTableColumnProperties"]["tableStartLocation"]["index"], x["updateTableColumnProperties"]["tableColumnProperties"]["width"]["magnitude"])
              for x in r if "updateTableColumnProperties" in x]
    assert widths == [(20, w) for w in tripdocs.WIDTHS["plan"]] + [(100, w) for w in tripdocs.WIDTHS["transport"]]
    # the user's own doc: centred headings, padded cells, widths of their own: nothing to do
    own = {"body": {"content": [para(1, "Plan", "HEADING_1", alignment="CENTER"),
                                table(6, ["Place", "Dates", "Accommodation", "Price", "Comments"], 5, [125, 88, 106, 72, 165], tripdocs.CELL_FONT)]}}
    assert tripdocs.restyle(own) == []
    assert len(tripdocs.restyle(own, widths=True)) == 5  # the user's widths for a doc tripmail made earlier


def test_template_keeps_the_layout_only():
    g = FakeGoogle({"d": {"name": "Faro 2026", "tables": [
        rows(PLAN, ["Faro", "01–03.12.26", "Hotel", "€90", ""], ["Lagos", "03–05.12.26", "", "", "x"],
             ["Sagres", "05–06.12.26", "", "", ""], ["Tavira", "06–08.12.26", "", "", ""]),
        rows(TRANSPORT, ["✈️ TP1", "01.12.26 10:00", "", ""])]}})
    g.batch("d", tripdocs.template_requests(g.get("d")))
    g.batch("d", tripdocs.pad(g.get("d")))
    plan, transport = g.docs["d"]["tables"]
    assert texts(plan) == [PLAN] + [["", "", "", "", ""]] * 3 and texts(transport) == [TRANSPORT] + [["", "", "", ""]] * 3


class ParaGoogle(FakeGoogle):
    """A doc with a Plan table and then paragraphs, kept as one string with a style and a bullet flag per paragraph;
    applies the requests suggestion_requests makes, and exports Markdown like Drive."""

    def __init__(self, plan, paras, modified="2026-10-01T10:00:00Z"):
        super().__init__({"d1": {"name": "Faro 2026", "tables": [plan]}})
        self.text = "".join(t + "\n" for t, _ in paras)
        self.styles, self.bullets, self.bold, self.links = [s for _, s in paras], [False] * len(paras), [], []
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
            elif kind == "updateTextStyle" and (body["textStyle"].get("bold") or body["textStyle"].get("italic")):
                self.bold.append(self.text[a:b])  # any direct style on top of the doc's own
            elif kind == "updateTextStyle" and body["textStyle"].get("link"):
                self.links.append((self.text[a:b], body["textStyle"]["link"]["url"]))


REPLY = """```json
{"things_to_do": [{"place": "Faro", "items": [{"name": "Vila Adentro", "why": "walk the old town walls."},
                                              {"name": "Ilha Deserta", "why": "take the boat from the harbour."}]}],
 "itinerary": [{"date": "2026-11-13", "place": "Faro", "plan": "Fly home at 16:10."},
               {"date": "2026-11-12", "place": "Faro", "plan": "Arrive, walk the old town."}]}
```"""
FARO = rows(PLAN, ["Faro", "12–13.11.26", "Hostel", "", ""])


def suggest(g, now=NOW, dry=False, state=None, history=None):
    asked, log = [], []
    state = {} if state is None else state
    tripdocs.TripDocs(g, "folder", log.append, dry=dry).suggest(state, now, lambda p: asked.append(p) or REPLY, history)
    return state, asked, log


def test_suggestions_are_written_then_replaced_when_the_doc_changes():
    g = ParaGoogle(FARO, [("Information", "HEADING_1"), ("Bring a towel", "NORMAL_TEXT"), ("", "NORMAL_TEXT")])
    state, asked, log = suggest(g)
    assert len(asked) == 1 and "Bring a towel" in asked[0] and "from 12.11.26" in asked[0], asked
    assert "https://" not in asked[0]
    got = [(t, s, b) for t, s, b in g.paras()]
    assert got[:2] == [("Information", "HEADING_1", False), ("Bring a towel", "NORMAL_TEXT", False)], got
    assert got[2] == ("Suggestions", "HEADING_1", False) and got[3][0].startswith("By tripmail on 01.11.26"), got
    assert got[4:] == [("Things to do", "HEADING_2", False), ("Faro", "HEADING_3", False),
                       ("Vila Adentro: walk the old town walls.", "NORMAL_TEXT", True),
                       ("Ilha Deserta: take the boat from the harbour.", "NORMAL_TEXT", True),
                       ("Itinerary", "HEADING_2", False), ("Thu 12.11, Faro: Arrive, walk the old town.", "NORMAL_TEXT", True),
                       ("Fri 13.11, Faro: Fly home at 16:10.", "NORMAL_TEXT", True)], got
    assert g.bold == [], g.bold  # the doc's own styles: headings and bullets, no bold or italics on top
    assert "Nothing near these places." in asked[0]
    maps = "https://www.google.com/maps/search/?api=1&query="
    assert g.links == [("Faro", maps + "Faro"), ("Vila Adentro", maps + "Vila%20Adentro%2C%20Faro"),
                       ("Ilha Deserta", maps + "Ilha%20Deserta%2C%20Faro")], g.links
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


def test_suggestions_know_where_you_have_been():
    plan = rows(PLAN, ["Faro", "12–13.11.26", "Hostel", "", ""], ["Tavira", "13.11.26", "", "", ""])
    g = ParaGoogle(plan, [("", "NORMAL_TEXT")])
    seen = []
    _, asked, _ = suggest(g, history=lambda names, a, b: seen.append((names, a, b)) or "Faro: 9 days on 3 visits, 2019–2024.")
    assert seen == [(["Faro", "Tavira"], date(2026, 11, 12), date(2026, 11, 13))], seen
    assert "Faro: 9 days on 3 visits, 2019–2024." in asked[0] and "Things new to me" in asked[0]


def test_places_of_a_doc():
    doc = FakeGoogle({"d": {"name": "x", "tables": [rows(PLAN, ["Lagos", "10–14.03.27", "", "", ""]),
                                                    rows(["Transport", "Date", "Price", "Comments"],
                                                         ["✈️ XX100: Eindhoven - Faro", "10.03.27 13:45", "", ""],
                                                         ["Rental car", "10–14.03", "", "Faro - Airport"],
                                                         ["✈️ XX101: Faro - Amsterdam", "14.03.27 16:10", "", ""])]}}).get("d")
    assert tripdocs.places(doc) == ["Lagos", "Faro", "Amsterdam"], tripdocs.places(doc)


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
    old = tripdocs.parse_reply('{"things_to_do": [{"place": "Faro", "items": ["Walk the walls."]}], "itinerary": []}')
    assert tripdocs.suggestion_lines(old, date(2026, 11, 1))[-1] == ("Walk the walls.", "item", None)  # a plain answer: no link
    md = "# **Plan**\n\n| Faro |\n\n# **Suggestions**\n\n*By flightmail on 01.11.26*\n\n## **Itinerary**\n\n# **Notes**\n\nmine"
    assert tripdocs.without_suggestions(md) == "# **Plan**\n\n| Faro |\n\n# **Notes**\n\nmine"
    assert tripdocs._plain("[Hostel](https://x.example/?a=1) 20€") == "Hostel 20€"
    assert tripdocs._plain("| ✈️ U21234 | 03.05.31 07:00 |  | Booking code: ABC123, 26002 |") == "| ✈️ U21234 | 03.05.31 07:00 |  | |"


# --- prices in euros ---

RATES = {"USD": 1.16, "VND": 30500.0, "LAK": 25000.0, "HKD": 9.0}


def flat_doc(blocks):
    """(doc JSON with real indexes, its characters): blocks are ("p", text, style) or ("t", [[cell paragraphs]]);
    table, row and cell starts take one index each, as in the API."""
    i, body, chars = 1, [], ["\x00"]

    def para(text, style="NORMAL_TEXT"):
        nonlocal i
        el = {"startIndex": i, "endIndex": i + len(text) + 1, "paragraph": {"paragraphStyle": {"namedStyleType": style},
              "elements": [{"startIndex": i, "endIndex": i + len(text) + 1, "textRun": {"content": text + "\n"}}]}}
        chars.extend(text + "\n")
        i += len(text) + 1
        return el

    for b in blocks:
        if b[0] == "p":
            body.append(para(*b[1:]))
            continue
        el, rows = {"startIndex": i}, []
        chars.append("\x00")
        i += 1
        for row in b[1]:
            chars.append("\x00")
            i += 1
            cells = []
            for cell in row:
                start = i
                chars.append("\x00")
                i += 1
                content = [para(t) for t in (cell if isinstance(cell, list) else [cell])]
                cells.append({"startIndex": start, "endIndex": i, "content": content})
            rows.append({"tableCells": cells})
        el["table"], el["endIndex"] = {"tableRows": rows}, i
        body.append(el)
    return {"body": {"content": body}}, chars


def applied(chars, requests):
    chars = list(chars)
    for q in requests:
        if "insertText" in q:
            k = q["insertText"]["location"]["index"]
            chars[k:k] = list(q["insertText"]["text"])
        elif "deleteContentRange" in q:
            del chars[q["deleteContentRange"]["range"]["startIndex"]:q["deleteContentRange"]["range"]["endIndex"]]
    return "".join(c if c != "\x00" else "|" for c in chars)


def test_prices_in_euros():
    ok = lambda text, eur, foreign: tripdocs.in_euros(text, RATES) == (eur, foreign)  # noqa: E731
    assert ok("10.45 USD", 9.01, True) and ok("773760 VND", 25.37, True) and ok("773.760 VND", 25.37, True)
    assert ok("99€", 99, False) and ok("€64", 64, False) and ok("~€3", 3, False) and ok("18,90€", 18.9, False)
    assert ok("1,234.50 EUR", 1234.5, False) and ok("20 USD + 5", 21.55, True) and ok("$10", 8.62, True)
    assert ok("671.22 HKD", 74.58, True) and ok("HK$ 671.22", 74.58, True)
    assert ok("130+45", None, False) and ok("12 XYZ", None, False) and ok("free", None, False)


def test_euro_lines_and_totals_under_the_tables():
    plan = ["Place", "Dates", "Accommodation", "Price", "Comments"]
    blocks = [("p", "Plan", "HEADING_1"),
              ("t", [plan, ["Vang Vieng", "20–21.12.26", "Hotel", "10.45 USD", ""], ["Hue", "", "", "99€", ""],
                     ["X", "", "", "130+45", ""]]),
              ("p", "Transport", "HEADING_1"), ("t", [["Transport", "Date", "Price", "Comments"], ["Bus", "", "", ""]]),
              ("p", "")]
    doc, chars = flat_doc(blocks)
    out = applied(chars, tripdocs.price_requests(doc, RATES))
    assert "10.45 USD\n≈ 9.01€\n|" in out and "99€\n|" in out and "≈ 85" not in out, out
    assert "\nTotal: 108.01€ (not counted: 130+45)\nTransport\n" in out, out
    assert out.count("Total") == 1, out  # nothing under a table without prices
    reqs = tripdocs.price_requests(doc, RATES)
    styled = [q for q in reqs if "updateParagraphStyle" in q]
    assert styled and styled[0]["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"] == "NORMAL_TEXT"
    # written already: nothing to do, also when today's rate moved a little
    blocks[1] = ("t", [plan, ["Vang Vieng", "", "", ["10.45 USD", "≈ 9.20€"], ""], ["Hue", "", "", "99€", ""], ["X", "", "", "130+45", ""]])
    blocks.insert(2, ("p", "Total: 108.01€ (not counted: 130+45)"))
    doc, chars = flat_doc(blocks)
    assert tripdocs.price_requests(doc, RATES) == []
    # the price changed: its line and the total are written again; a line left under a price in euros goes
    blocks[1] = ("t", [plan, ["Vang Vieng", "", "", ["30 USD", "≈ 9.01€"], ""], ["Hue", "", "", ["99€", "≈ 5.00€"], ""]])
    doc, chars = flat_doc(blocks)
    out = applied(chars, tripdocs.price_requests(doc, RATES))
    assert "30 USD\n≈ 25.86€\n|" in out and "|99€\n|" in out and "\nTotal: 124.86€\nTransport" in out, out
    # no prices left: the total goes
    blocks[1] = ("t", [plan, ["Hue", "", "", "", ""]])
    doc, chars = flat_doc(blocks)
    out = applied(chars, tripdocs.price_requests(doc, RATES))
    assert "Total" not in out and "|\nTransport\n" in out, out


def test_prices_only_in_coming_trips_that_changed():
    class G:
        def __init__(self):
            self.batches, self.stamp = [], "2026-11-01T10:00:00Z"

        def docs_in(self, folder):
            return [{"id": "a", "name": "Asia", "modifiedTime": self.stamp}]

        def get(self, doc_id):
            return flat_doc([("p", "Plan", "HEADING_1"), ("t", [["Place", "Dates", "Accommodation", "Price", "Comments"],
                                                                  ["Hue", "20–21.12.26", "", "10 USD", ""]]), ("p", "")])[0]

        def batch(self, doc_id, requests):
            self.batches.append(requests)

        def modified(self, doc_id):
            return "2026-11-14T10:00:00Z"

    g, state, calls = G(), {}, []
    docs = tripdocs.TripDocs(g, "folder", lambda m: None)
    rates = lambda: calls.append(1) or RATES  # noqa: E731
    docs.prices(state, datetime(2026, 11, 14, 12), rates)
    assert len(g.batches) == 1 and state["docs"]["priced"]["a"] == "2026-11-14T10:00:00Z" and calls == [1]
    g.stamp = "2026-11-14T10:00:00Z"
    docs.prices(state, datetime(2026, 11, 14, 13), rates)  # its own edit: not looked at again
    assert len(g.batches) == 1 and calls == [1]
    g.stamp = "2026-11-14T12:50:00Z"
    docs.prices(state, datetime(2026, 11, 14, 13), rates)  # the user may still be typing
    assert len(g.batches) == 1
    docs.prices(state, datetime(2027, 1, 14, 13), rates)  # the trip is over
    assert len(g.batches) == 1
    assert tripdocs.without_euros("| 10 USD ≈ 8.62€ |\nTotal: 8.62€\nmine") == "| 10 USD  |\n\nmine"


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
