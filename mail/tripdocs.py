"""Trip documents in a Google Drive folder: one Google Doc per trip with an Information heading, a Plan table
(Place | Dates | Accommodation | Price | Comments) and a Transport table (Transport | Date | Price | Comments).

flightmail fills them from the bookings it reads: a hotel or Airbnb goes into the Plan row for that place and dates
(empty cells only) or a new row in date order; a rental car into the Comments of the row of its pick-up day; each
flight into a Transport row. A cancelled stay empties the Accommodation and Price cells. A trip without a doc gets
a new one, named like "Portugal 2026". Text the user wrote is never changed.

Google access: OAuth "Desktop app" client (google_client.json) and a refresh token (google_token.json) in
~/.flightmail, made once with `python mail/tripdocs.py auth`. Standard library only.
"""
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

SCOPE = "https://www.googleapis.com/auth/drive"
DOCS = "https://docs.googleapis.com/v1/documents/"
DRIVE = "https://www.googleapis.com/drive/v3/files"
TEMPLATE = """<html><body>
<h1><b>Information</b></h1><p></p>
<h1><b>Plan</b></h1>
<table><tr><td><b>Place</b></td><td><b>Dates</b></td><td><b>Accommodation</b></td><td><b>Price</b></td><td><b>Comments</b></td></tr></table>
<h1><b>Transport</b></h1>
<table><tr><td><b>Transport</b></td><td><b>Date</b></td><td><b>Price</b></td><td><b>Comments</b></td></tr></table>
</body></html>"""


# --- Google (OAuth refresh token + JSON calls) ---

class Google:
    def __init__(self, client_file, token_file):
        self.client = json.loads(Path(client_file).read_text())["installed"]
        self.token_file, self.access, self.expires = Path(token_file), None, 0

    def _token(self):
        if not self.access or time.time() > self.expires - 60:
            refresh = json.loads(self.token_file.read_text())["refresh_token"]
            r = _post_form(self.client["token_uri"], {"client_id": self.client["client_id"],
                           "client_secret": self.client["client_secret"], "refresh_token": refresh,
                           "grant_type": "refresh_token"})
            self.access, self.expires = r["access_token"], time.time() + r.get("expires_in", 3600)
        return self.access

    def call(self, method, url, body=None, data=None, ctype="application/json"):
        if body is not None:
            data = json.dumps(body).encode()
        req = urllib.request.Request(url, data, method=method,
                                     headers={"Authorization": "Bearer " + self._token(), "Content-Type": ctype})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"null")

    def docs_in(self, folder):
        q = f"'{folder}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false"
        url = DRIVE + "?" + urllib.parse.urlencode({"q": q, "fields": "files(id,name)", "pageSize": 1000})
        return self.call("GET", url)["files"]

    def get(self, doc_id):
        return self.call("GET", DOCS + doc_id)

    def batch(self, doc_id, requests):
        if requests:
            self.call("POST", DOCS + doc_id + ":batchUpdate", {"requests": requests})

    def create(self, folder, name, html=TEMPLATE):
        """A new Google Doc in the folder, converted from html by Drive."""
        boundary = "flightmail-boundary"
        meta = {"name": name, "mimeType": "application/vnd.google-apps.document", "parents": [folder]}
        data = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n"
                f"--{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{html}\r\n--{boundary}--").encode()
        return self.call("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", data=data,
                         ctype=f"multipart/related; boundary={boundary}")["id"]


def _post_form(url, fields):
    req = urllib.request.Request(url, urllib.parse.urlencode(fields).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def authorize(client_file, token_file, port=8765):
    """One-time sign-in: prints a URL to open in a browser (through `ssh -L 8765:localhost:8765 mini` when run on
    mini) and stores the refresh token in token_file (mode 600)."""
    import http.server
    client = json.loads(Path(client_file).read_text())["installed"]
    redirect = f"http://localhost:{port}"
    print("Open in a browser:\n" + "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent"}), flush=True)
    got = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            got.update(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"flightmail: signed in, you can close this tab." if "code" in got else b"no code")

        def log_message(self, *a):
            pass

    with http.server.HTTPServer(("127.0.0.1", port), Handler) as srv:
        while "code" not in got and "error" not in got:
            srv.handle_request()
    if "code" not in got:
        sys.exit(f"sign-in failed: {got.get('error')}")
    r = _post_form(client["token_uri"], {"code": got["code"][0], "client_id": client["client_id"],
                   "client_secret": client["client_secret"], "redirect_uri": redirect, "grant_type": "authorization_code"})
    Path(token_file).write_text(json.dumps({"refresh_token": r["refresh_token"]}))
    Path(token_file).chmod(0o600)
    print("saved", token_file)


# --- the doc's tables ---

def _cell(c):
    paras = [p["paragraph"] for p in c.get("content", []) if "paragraph" in p]
    runs = [e for p in paras for e in p.get("elements", []) if "textRun" in e]
    return {"start": paras[0]["elements"][0]["startIndex"] if paras and paras[0].get("elements") else c["startIndex"] + 1,
            "end": c["endIndex"] - 1,  # the cell's last newline, which stays
            "text": "".join(e["textRun"]["content"] for e in runs).strip(),
            "links": [e["textRun"].get("textStyle", {}).get("link", {}).get("url", "") for e in runs
                      if e["textRun"].get("textStyle", {}).get("link")]}


def tables(doc):
    """{"plan": table, "transport": table} found by their header rows; a table is {start, cols, rows: [[cell]]}."""
    out = {}
    for el in doc["body"]["content"]:
        if "table" not in el:
            continue
        rows = [[_cell(c) for c in r["tableCells"]] for r in el["table"]["tableRows"]]
        head = [c["text"].lower() for c in rows[0]] if rows else []
        kind = {"place": "plan", "transport": "transport"}.get(head[0] if head else "")
        if kind and kind not in out:
            out[kind] = {"start": el["startIndex"], "cols": {h: i for i, h in enumerate(head)}, "rows": rows}
    return out


DATES_RX = re.compile(r"(\d{1,2})(?:\.(\d{1,2}))?(?:\.(\d{2,4}))?\s*[–—-]\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})|(\d{1,2})\.(\d{1,2})\.(\d{2,4})")


def _year(y):
    return int(y) + (2000 if len(y) == 2 else 0)


def parse_dates(text):
    """(first, last) day of '24–26.09.26', '31.08–01.09.26', '31.12.26–01.01.27' or '07.12.26 16:10'; else None."""
    m = DATES_RX.search(text or "")
    if not m:
        return None
    try:
        if m.group(4):
            end = date(_year(m.group(6)), int(m.group(5)), int(m.group(4)))
            start = date(_year(m.group(3)) if m.group(3) else end.year, int(m.group(2) or end.month), int(m.group(1)))
            return (start, end) if start <= end else (start.replace(year=start.year - 1), end)
        d = date(_year(m.group(9)), int(m.group(8)), int(m.group(7)))
        return d, d
    except ValueError:
        return None


def fmt_dates(start, end):
    """The docs' way: 24–26.09.26, 31.08–01.09.26, 31.12.26–01.01.27."""
    if start.year != end.year:
        return f"{start:%d.%m.%y}–{end:%d.%m.%y}"
    if start.month != end.month:
        return f"{start:%d.%m}–{end:%d.%m.%y}"
    return f"{start:%d}–{end:%d.%m.%y}"


def span(doc):
    """First and last day written in the Plan and Transport tables, or None."""
    days = [d for t in tables(doc).values() for row in t["rows"][1:] for c in row[:2] for d in (parse_dates(c["text"]) or ())]
    return (min(days), max(days)) if days else None


def _norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


# --- edits (Docs API requests; each list is sent against a fresh copy of the doc) ---

def _len(text):
    return len(text.encode("utf-16-le")) // 2  # Docs indexes count UTF-16 code units


def _write(cell, text, link=None):
    """Insert text at the start of an empty cell, not bold, linked or not."""
    i = cell["start"]
    style = {"bold": False, **({"link": {"url": link}} if link else {})}
    return [{"insertText": {"location": {"index": i}, "text": text}},
            {"updateTextStyle": {"range": {"startIndex": i, "endIndex": i + _len(text)}, "textStyle": style, "fields": "bold,link"}}]


def car_requests(cell, car):
    """'Rental car 26–30.09' with 'Rental car' linked, at the end of the cell (after a space when it has text)."""
    i, lead = (cell["end"], " ") if cell["text"] else (cell["start"], "")
    text = lead + "Rental car " + car_text(car)
    out = [{"insertText": {"location": {"index": i}, "text": text}},
           {"updateTextStyle": {"range": {"startIndex": i, "endIndex": i + _len(text)}, "textStyle": {"bold": False}, "fields": "bold,link"}}]
    if car["link"]:
        out.append({"updateTextStyle": {"range": {"startIndex": i + _len(lead), "endIndex": i + _len(lead + "Rental car")},
                                        "textStyle": {"link": {"url": car["link"]}}, "fields": "link"}})
    return out


def fill(table, r, values):
    """Requests that write {column: text or (text, link)} into the empty cells of row r, last cell first."""
    out = []
    for col in sorted((c for c in values if c in table["cols"]), key=lambda c: -table["cols"][c]):
        cell = table["rows"][r][table["cols"][col]]
        v = values[col] if isinstance(values[col], tuple) else (values[col], None)
        if v[0] and not cell["text"]:
            out += _write(cell, *v)
    return out


def clear(table, r, cols):
    out = []
    for col in sorted((c for c in cols if c in table["cols"]), key=lambda c: -table["cols"][c]):
        cell = table["rows"][r][table["cols"][col]]
        if cell["end"] > cell["start"]:
            out.append({"deleteContentRange": {"range": {"startIndex": cell["start"], "endIndex": cell["end"]}}})
    return out


def add_row(table, after):
    return [{"insertTableRow": {"tableCellLocation": {"tableStartLocation": {"index": table["start"]},
                                                       "rowIndex": after, "columnIndex": 0}, "insertBelow": True}}]


# --- where a booking goes ---

def stay_row(plan, stay):
    """("fill", row) for the Plan row that already links to the booking, else for the row of this place and dates;
    else ("insert", row to insert below) in date order. Filling writes only empty cells."""
    after = 0
    for r, row in enumerate(plan["rows"][1:], 1):
        cell = lambda name: row[plan["cols"][name]] if name in plan["cols"] else {"text": "", "links": []}
        if any(stay["code"] in l or l == stay["link"] for l in cell("accommodation")["links"]):
            return "fill", r
        days = parse_dates(cell("dates")["text"])
        if days and days[0] <= date.fromisoformat(stay["start"]):
            after = r
        place = _norm(cell("place")["text"])
        if days and place and (place in _norm(stay["place"]) or _norm(stay["place"]) in place) \
                and days[0] < date.fromisoformat(stay["end"]) and date.fromisoformat(stay["start"]) < days[1] + timedelta(days=1):
            return "fill", r
    return "insert", after


def stay_cells(stay):
    s, e = date.fromisoformat(stay["start"]), date.fromisoformat(stay["end"])
    return {"place": stay["place"], "dates": fmt_dates(s, e), "accommodation": (stay["type"], stay["link"] or None),
            "price": stay["price"]}


def car_text(car):
    s, e = date.fromisoformat(car["start"]), date.fromisoformat(car["end"])
    return f"{s:%d}–{e:%d.%m}" if (s.year, s.month) == (e.year, e.month) else f"{s:%d.%m}–{e:%d.%m}"


def car_row(plan, car):
    """The Plan row whose stay holds the pick-up day (the one starting that day first), else None."""
    day, best = date.fromisoformat(car["start"]), None
    for r, row in enumerate(plan["rows"][1:], 1):
        days = parse_dates(row[plan["cols"]["dates"]]["text"]) if "dates" in plan["cols"] else None
        if days and days[0] <= day <= days[1] and (best is None or days[0] == day):
            best = r
    return best


def leg_row(transport, leg):
    """("done", row) if a Transport row has this trip on this day (same title, or same flight or train number);
    else its place in time order: ("fill", row) when that row is empty, or ("insert", row to insert below)."""
    rows, me, after = transport["rows"], _when(leg["date"]), 0
    for r, row in enumerate(rows[1:], 1):
        text = " ".join(c["text"] for c in row)
        same = row[0]["text"] == leg["title"] or (leg["flight"] and leg["flight"] in row[0]["text"].replace(" ", ""))
        if same and leg["date"][:8] in text:
            return "done", r
        when = _when(text)
        if when and when <= me:
            after = r
    if after + 1 < len(rows) and not any(c["text"] for c in rows[after + 1]):
        return "fill", after + 1
    return "insert", after


def _when(text):
    """(day, "HH:MM") of the first date in text, for ordering Transport rows; None without a date."""
    days = parse_dates(text)
    if not days:
        return None
    t = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
    return days[0], f"{int(t.group(1)):02d}:{t.group(2)}" if t else "00:00"


def pick_doc(files, start, end):
    """The doc (id) whose days overlap start..end (one day of slack) the most, else None."""
    best, most = None, 0
    for doc_id, f in files.items():
        if not f.get("start"):
            continue
        a, b = max(start, date.fromisoformat(f["start"]) - timedelta(days=1)), min(end, date.fromisoformat(f["end"]) + timedelta(days=1))
        if (b - a).days + 1 > most:
            best, most = doc_id, (b - a).days + 1
    return best



# --- one run: what should be in the docs, and making it so ---

def wanted(state, airports, now, home, skip=()):
    """{item id: spec} for every stay, car, flight, train, bus and ferry that is not over yet, except bookings
    whose code is in skip."""
    import plan
    today = now.date().isoformat()
    out = {}
    for code, s in state.get("stays", {}).items():
        if code not in skip and not s.get("cancelled") and s.get("start") and s.get("end") and s["end"] >= today:
            out[f"{s['what']}:{code}"] = {k: s.get(k, "") for k in ("what", "code", "place", "country", "start", "end", "type", "price", "link")}
    rows = [r for r in state.get("seen", {}).values() if r["dep"] in airports and r["arr"] in airports]
    trips = plan.trips(rows, home, airports)
    for sid, r in state.get("seen", {}).items():
        if r not in rows or r["arr_local"][:10] < today:
            continue
        day = r["dep_local"][:10]
        trip = next((t for t in trips if t["start"] <= day <= t["end"]), None)
        away = r["dep"] if r["arr"] in home else r["arr"]  # a lone flight home is named after where it left
        out["leg:" + sid] = {"what": "leg", "flight": r["flight"], "dep_local": r["dep_local"],
                             "date": f"{datetime.fromisoformat(r['dep_local']):%d.%m.%y %H:%M}",
                             "title": f"✈️ {r['flight']}: {plan._city(r['dep'], airports)} - {plan._city(r['arr'], airports)}",
                             "codes": r.get("codes", []), "start": trip["start"] if trip else day, "end": trip["end"] if trip else r["arr_local"][:10],
                             "name": trip["name"] if trip else plan._city(away, airports)}
    for sid, r in state.get("ground", {}).items():
        if r["arr_local"][:10] < today:
            continue
        day = r["dep_local"][:10]
        trip = next((t for t in trips if t["start"] <= day <= t["end"]), None)
        number = "" if r["flight"].startswith(r["mode"] + ":") else r["flight"]  # "bus:A>B" when it has none
        out["ride:" + sid] = {"what": "leg", "mode": r["mode"], "flight": number, "dep_local": r["dep_local"],
                              "date": f"{datetime.fromisoformat(r['dep_local']):%d.%m.%y %H:%M}",
                              "title": f"{plan.EMOJI.get(r['mode'], '🚌')} {number + ': ' if number else ''}{r['dep']} - {r['arr']}",
                              "codes": r.get("codes", []), "start": trip["start"] if trip else day,
                              "end": trip["end"] if trip else r["arr_local"][:10]}
    return out


def _stub(name):
    """An empty doc made from TEMPLATE, for dry runs that would create one."""
    def table(start, heads):
        cells = [{"startIndex": start + 2 + 2 * i, "endIndex": start + 4 + 2 * i, "content": [{"paragraph": {"elements": [
            {"startIndex": start + 3 + 2 * i, "endIndex": start + 4 + 2 * i, "textRun": {"content": h + "\n"}}]}}]} for i, h in enumerate(heads)]
        return {"startIndex": start, "table": {"tableRows": [{"tableCells": cells}]}}
    return {"title": name, "body": {"content": [table(10, ["Place", "Dates", "Accommodation", "Price", "Comments"]),
                                                  table(100, ["Transport", "Date", "Price", "Comments"])]}}


class TripDocs:
    def __init__(self, google, folder, log, dry=False, skip=()):
        self.g, self.folder, self.log, self.dry, self.skip, self.names = google, folder, log, dry, set(skip), {}

    def files(self):
        out = {}
        for f in self.g.docs_in(self.folder):
            self.names[f["id"]] = f["name"]
            days = span(self.g.get(f["id"]))
            out[f["id"]] = {"name": f["name"], "start": days[0].isoformat() if days else None, "end": days[1].isoformat() if days else None}
        return out

    def get(self, doc_id):
        return _stub(self.names[doc_id]) if doc_id.startswith("dry:") else self.g.get(doc_id)

    def batch(self, doc_id, requests):
        if not requests:
            return
        texts = [r["insertText"]["text"] for r in requests if "insertText" in r]
        what = f"write {texts}" if texts else f"empty {sum('deleteContentRange' in r for r in requests)} cell(s)" \
            if any("deleteContentRange" in r for r in requests) else "add a row"
        self.log(f"{'would ' if self.dry else ''}{what} in doc {self.names.get(doc_id, doc_id)!r}")
        if not self.dry:
            self.g.batch(doc_id, requests)

    def create(self, name):
        taken = set(self.names.values())
        title = next(t for t in [name] + [f"{name} {i}" for i in range(2, 100)] if t not in taken)
        self.log(f"{'would ' if self.dry else ''}create doc {title!r}")
        doc_id = "dry:" + title if self.dry else self.g.create(self.folder, title)
        self.names[doc_id] = title
        return doc_id

    def _table(self, doc_id, kind):
        t = tables(self.get(doc_id)).get(kind)
        if not t:
            self.log(f"doc {self.names.get(doc_id)!r} has no {kind.capitalize()} table, left alone")
        return t

    def _insert_and_fill(self, doc_id, kind, after, values):
        self.batch(doc_id, add_row(self._table(doc_id, kind), after))
        if self.dry:
            self.log(f"would write {[v[0] if isinstance(v, tuple) else v for v in values.values()]} in doc {self.names.get(doc_id)!r}")
        else:
            self.batch(doc_id, fill(self._table(doc_id, kind), after + 1, values))

    def add(self, doc_id, spec):
        if spec["what"] == "leg":
            t = self._table(doc_id, "transport")
            if not t:
                return
            how, r = leg_row(t, spec)
            values = {"transport": spec["title"], "date": spec["date"],
                      "comments": "Booking code: " + ", ".join(spec["codes"]) if spec["codes"] else ""}
            if how == "fill":
                self.batch(doc_id, fill(t, r, values))
            elif how == "insert":
                self._insert_and_fill(doc_id, "transport", r, values)
            return
        t = self._table(doc_id, "plan")
        if not t:
            return
        if spec["what"] == "car":
            r = car_row(t, spec)
            col = "car" if "car" in t["cols"] else "comments"
            if r is None or col not in t["cols"]:
                self._car_in_transport(doc_id, spec)
                return
            cell = t["rows"][r][t["cols"][col]]
            if any(spec["code"] in l or l == spec["link"] for l in cell["links"]):
                return
            self.batch(doc_id, car_requests(cell, spec))
            return
        how, r = stay_row(t, spec)
        if how == "fill":
            self.batch(doc_id, fill(t, r, {k: v for k, v in stay_cells(spec).items() if k in ("accommodation", "price")}))
        elif how == "insert":
            self._insert_and_fill(doc_id, "plan", r, stay_cells(spec))

    def _car_in_transport(self, doc_id, car):
        t = self._table(doc_id, "transport")
        if not t:
            return
        if any(car["code"] in l for row in t["rows"] for c in row for l in c["links"]):
            return
        values = {"transport": ("Rental car", car["link"] or None), "date": car_text(car) + "." + car["end"][2:4],
                  "price": car["price"], "comments": car["place"]}
        empty = next((r for r, row in enumerate(t["rows"][1:], 1) if not any(c["text"] for c in row)), None)
        if empty:
            self.batch(doc_id, fill(t, empty, values))
        else:
            self._insert_and_fill(doc_id, "transport", len(t["rows"]) - 1, values)

    def remove(self, doc_id, spec):
        if spec["what"] == "stay":
            t = self._table(doc_id, "plan")
            col = t and t["cols"].get("accommodation")
            for r, row in enumerate(t["rows"][1:] if t else [], 1):
                if col is not None and any(spec["code"] in l or l == spec["link"] for l in row[col]["links"]):
                    self.batch(doc_id, clear(t, r, ["accommodation", "price"]))
                    return
        elif spec["what"] == "leg":
            t = self._table(doc_id, "transport")
            how, r = leg_row(t, spec) if t else (None, None)
            if how == "done":
                self.batch(doc_id, clear(t, r, list(t["cols"])))
        else:
            self.log(f"rental car {spec['code']} cancelled: check doc {self.names.get(doc_id, doc_id)!r} by hand")

    def run(self, state, airports, now, home):
        import plan
        reg = state.setdefault("docs", {})
        done = reg.setdefault("done", {})
        desired = wanted(state, airports, now, home, self.skip)
        steps = plan.reconcile(desired, done)
        if not any(steps.values()):
            return
        waiting = [i for i in desired if i in done and not done[i]["doc"] and i not in steps["update"]]
        files = self.files()
        today = now.date().isoformat()
        for i in steps["remove"] + steps["update"]:
            if done[i]["spec"]["end"] >= today and done[i]["doc"] in files:
                self.remove(done[i]["doc"], done[i]["spec"])
            del done[i]
        for i in sorted(steps["create"] + steps["update"] + waiting, key=lambda i: (desired[i]["start"], desired[i].get("dep_local", ""))):
            spec = desired[i]
            s, e = date.fromisoformat(spec["start"]), date.fromisoformat(spec["end"])
            doc_id = pick_doc(files, s, e)
            if not doc_id and spec.get("mode", "flight") != "flight":  # trains, buses, ferries only join a trip's doc
                done[i] = {"doc": None, "spec": spec}
                continue
            if not doc_id:
                doc_id = self.create(f"{spec.get('name') or spec.get('country') or spec['place']} {s.year}")
                files[doc_id] = {"name": self.names[doc_id], "start": spec["start"], "end": spec["end"]}
            f = files[doc_id]
            f["start"], f["end"] = min(f["start"] or spec["start"], spec["start"]), max(f["end"] or spec["end"], spec["end"])
            self.add(doc_id, spec)
            done[i] = {"doc": doc_id, "spec": spec}

if __name__ == "__main__":
    if sys.argv[1:] == ["auth"]:
        d = Path.home() / ".flightmail"
        authorize(d / "google_client.json", d / "google_token.json")
    else:
        sys.exit("usage: python mail/tripdocs.py auth")
