"""Trip documents in a Google Drive folder: one Google Doc per trip with an Information heading, a Plan table
(Place | Dates | Stay | Price | Comments; "Accommodation" in older docs) and a Transport table (Transport | Date | Price | Comments).

tripmail fills them from the bookings it reads: a hotel or Airbnb goes into the Plan row for that place and dates
(empty cells only) or a new row in date order; a rental car into the Comments of the row of its pick-up day; each
flight into a Transport row. A cancelled stay empties the Stay and Price cells. A trip without a doc gets
a new one, named like "Portugal 2026", that anyone with its link can edit (and a Things to-do, by tripmail.py).
Tables with no data yet get three empty rows. New docs are copies of a template doc (`python mail/tripdocs.py template
<doc id>` makes one from a trip doc), else made from html and given the user's look: Normal text and Heading styles
with no spacing of their own, the three headings centred, 5 pt cell padding, their column widths, table text in
Helvetica Neue. Text the user wrote is never changed.

Prices: under a price in another currency ("773760 VND") a line "≈ 25.39€" at the day's rate (open.er-api.com), and
under each table a line "Total: 123.45€", kept up to date in the docs of trips not over yet.

Suggestions: when the doc of a trip that is not over yet changes (the user's edits or tripmail's), Claude (`claude
-p`) is asked for things to do around where the user sleeps and a day-by-day itinerary, new to them: it is told where
they have been near the trip's places before (Cairn's towns and what they did there). Written into a "Suggestions"
section that is tripmail's own and replaced every time, in the docs' own styles (headings, bullets, no bold).

Google access: OAuth "Desktop app" client (google_client.json) and a refresh token (google_token.json) in
~/.tripmail, made once with `python mail/tripdocs.py auth`. Standard library only.
"""
import hashlib
import json
import re
import subprocess
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
# The styles of the user's own docs, which Drive makes the doc's named styles (Normal text, Heading 1 to 3) from the
# CSS: its headings are those styles alone, with no bold or size of their own on top
STYLE = """<style>
body { font-family: Arial; font-size: 11pt; }
h1 { font-size: 18pt; font-weight: bold; margin-top: 24pt; margin-bottom: 6pt; }
h2 { font-size: 14pt; font-weight: bold; margin-top: 18pt; margin-bottom: 4pt; }
h3 { font-size: 12pt; font-weight: bold; color: #666666; margin-top: 14pt; margin-bottom: 4pt; }
td { font-family: "Helvetica Neue"; }
</style>"""
EMPTY_ROWS = 3  # a table with no data yet has this many empty rows to write in
TEMPLATE = f"""<html><head>{STYLE}</head><body>
<h1>Information</h1><p></p>
<h1>Plan</h1>
<table><tr><td><b>Place</b></td><td><b>Dates</b></td><td><b>Stay</b></td><td><b>Price</b></td><td><b>Comments</b></td></tr>{("<tr>" + "<td></td>" * 5 + "</tr>") * EMPTY_ROWS}</table>
<h1>Transport</h1>
<table><tr><td><b>Transport</b></td><td><b>Date</b></td><td><b>Price</b></td><td><b>Comments</b></td></tr>{("<tr>" + "<td></td>" * 4 + "</tr>") * EMPTY_ROWS}</table>
</body></html>"""
# and their page: A4 with 1 cm margins, pageless
CM = {"magnitude": 28.346456692913385, "unit": "PT"}
PAGE = {"updateDocumentStyle": {"documentStyle": {
    "pageSize": {"width": {"magnitude": 595.2755905511812, "unit": "PT"}, "height": {"magnitude": 841.8897637795277, "unit": "PT"}},
    "marginTop": CM, "marginBottom": CM, "marginLeft": CM, "marginRight": CM, "documentFormat": {"documentMode": "PAGELESS"}},
    "fields": "pageSize,marginTop,marginBottom,marginLeft,marginRight,documentFormat"}}
# and their tables (those of "Asia winter 2026"): 5 pt cell padding, these column widths (Drive's import gives 0
# padding and even widths), text in Helvetica Neue. A template doc (Google.template) has all of it, and moves the
# tables a little to the left, which neither the Docs API nor the import can do.
PADS = ("paddingTop", "paddingBottom", "paddingLeft", "paddingRight")
PADDING = {"magnitude": 5, "unit": "PT"}
WIDTHS = {"plan": (101.25, 104.25, 97.5, 48.75, 243), "transport": (142.5, 90.75, 48.75, 312)}
CELL_FONT = {"weightedFontFamily": {"fontFamily": "Helvetica Neue", "weight": 400}}


# --- Google (OAuth refresh token + JSON calls) ---

class Google:
    def __init__(self, client_file, token_file, template=None):
        self.client = json.loads(Path(client_file).read_text())["installed"]
        self.token_file, self.access, self.expires = Path(token_file), None, 0
        self.template = template  # the id of a doc new docs are copies of (make_template), else they are made from html

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
        url = DRIVE + "?" + urllib.parse.urlencode({"q": q, "fields": "files(id,name,modifiedTime)", "pageSize": 1000})
        return self.call("GET", url)["files"]

    def modified(self, doc_id):
        return self.call("GET", f"{DRIVE}/{doc_id}?fields=modifiedTime")["modifiedTime"]

    def export(self, doc_id):
        """The doc as Markdown (Drive's export), tables included."""
        req = urllib.request.Request(f"{DRIVE}/{doc_id}/export?mimeType=text/markdown",
                                     headers={"Authorization": "Bearer " + self._token()})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode()

    def get(self, doc_id):
        return self.call("GET", DOCS + doc_id)

    def batch(self, doc_id, requests):
        if requests:
            self.call("POST", DOCS + doc_id + ":batchUpdate", {"requests": requests})

    def create(self, folder, name, html=TEMPLATE):
        """A new Google Doc in the folder: a copy of the template doc, or else converted from html by Drive and given
        the look of the user's docs (PAGE, restyle)."""
        if self.template:
            doc_id = self.call("POST", f"{DRIVE}/{self.template}/copy", {"name": name, "parents": [folder]})["id"]
            self.share(doc_id)
            return doc_id
        boundary = "tripmail-boundary"
        meta = {"name": name, "mimeType": "application/vnd.google-apps.document", "parents": [folder]}
        data = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n"
                f"--{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{html}\r\n--{boundary}--").encode()
        doc_id = self.call("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", data=data,
                           ctype=f"multipart/related; boundary={boundary}")["id"]
        self.batch(doc_id, [PAGE] + restyle(self.get(doc_id)))
        self.share(doc_id)
        return doc_id

    def share(self, doc_id):
        """Anyone with the link can edit (it is not listed or searchable)."""
        self.call("POST", f"{DRIVE}/{doc_id}/permissions", {"type": "anyone", "role": "writer", "allowFileDiscovery": False})

    def replace(self, doc_id, html=TEMPLATE):
        """The doc's whole content and named styles made anew from html (same doc, same link), on that page."""
        req = urllib.request.Request(f"https://www.googleapis.com/upload/drive/v3/files/{doc_id}?uploadType=media",
                                     html.encode(), method="PATCH",
                                     headers={"Authorization": "Bearer " + self._token(), "Content-Type": "text/html"})
        urllib.request.urlopen(req, timeout=60).close()
        self.batch(doc_id, [PAGE] + restyle(self.get(doc_id)))


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
            self.wfile.write(b"tripmail: signed in, you can close this tab." if "code" in got else b"no code")

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
            "paras": [{"start": q["elements"][0].get("startIndex", 0), "end": q["elements"][-1].get("endIndex", 0),
                       "text": "".join(e.get("textRun", {}).get("content", "") for e in q["elements"]).strip()}
                      for q in paras if q.get("elements")],
            "links": [e["textRun"].get("textStyle", {}).get("link", {}).get("url", "") for e in runs
                      if e["textRun"].get("textStyle", {}).get("link")]}


HEADS = {"accommodation": "stay"}  # the column's name in docs made before it was "Stay"


def tables(doc):
    """{"plan": table, "transport": table} found by their header rows; a table is {start, cols, rows: [[cell]], after:
    the paragraph that follows it}."""
    out, body = {}, doc["body"]["content"]
    for k, el in enumerate(body):
        if "table" not in el:
            continue
        rows = [[_cell(c) for c in r["tableCells"]] for r in el["table"]["tableRows"]]
        head = [HEADS.get(c["text"].lower(), c["text"].lower()) for c in rows[0]] if rows else []
        kind = {"place": "plan", "transport": "transport"}.get(head[0] if head else "")
        if kind and kind not in out:
            nxt = body[k + 1] if k + 1 < len(body) and "paragraph" in body[k + 1] else None
            out[kind] = {"start": el["startIndex"], "cols": {h: i for i, h in enumerate(head)}, "rows": rows,
                         "after": nxt and {"start": nxt["startIndex"], "end": nxt["endIndex"], "text": _ptext(nxt), "style": _pstyle(nxt)}}
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
    style = {"bold": False, **CELL_FONT, **({"link": {"url": link}} if link else {})}
    return [{"insertText": {"location": {"index": i}, "text": text}},
            {"updateTextStyle": {"range": {"startIndex": i, "endIndex": i + _len(text)}, "textStyle": style,
                                 "fields": "bold,link,weightedFontFamily"}}]


def car_requests(cell, car):
    """'Rental car 26–30.09' with 'Rental car' linked, at the end of the cell (after a space when it has text)."""
    i, lead = (cell["end"], " ") if cell["text"] else (cell["start"], "")
    text = lead + "Rental car " + car_text(car)
    out = [{"insertText": {"location": {"index": i}, "text": text}},
           {"updateTextStyle": {"range": {"startIndex": i, "endIndex": i + _len(text)}, "textStyle": {"bold": False, **CELL_FONT},
                                "fields": "bold,link,weightedFontFamily"}}]
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


def replace_cells(table, r, values):
    """Requests that make a planned row (planned) the booked one: its Transport and Date cells rewritten, the price
    written when its cell is empty, the booking code put above your comments; last cell first."""
    out = []
    for col in sorted((c for c in values if c in table["cols"]), key=lambda c: -table["cols"][c]):
        cell, text = table["rows"][r][table["cols"][col]], values[col]
        if not text:
            continue
        if col in ("transport", "date"):
            if cell["end"] > cell["start"]:
                out.append({"deleteContentRange": {"range": {"startIndex": cell["start"], "endIndex": cell["end"]}}})
            out += _write(cell, text)
        elif not cell["text"]:
            out += _write(cell, text)
        elif col == "comments" and text not in cell["text"]:
            out += _write(cell, text + "\n")
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


def restyle(doc, widths=False):
    """Requests that make a doc made from html look like the user's own: plain Normal text and Heading paragraphs
    (no spacing of their own over the style, which Drive's import leaves), the Information, Plan and Transport
    headings centred, 5 pt padding in every table cell, table text in CELL_FONT, and the user's column widths where
    the import's even ones are (or always, with widths)."""
    out, kinds = [], {t["start"]: k for k, t in tables(doc).items()}
    for el in doc["body"]["content"]:
        if "paragraph" in el:
            p = el["paragraph"]
            ps, text = p["paragraphStyle"], "".join(e.get("textRun", {}).get("content", "") for e in p["elements"]).strip()
            fields, style = [k for k in ("spaceAbove", "spaceBelow") if k in ps], {}
            if ps.get("namedStyleType") == "HEADING_1" and text in ("Information", "Plan", "Transport") \
                    and ps.get("alignment") != "CENTER":
                fields.append("alignment")
                style["alignment"] = "CENTER"
            if fields:
                out.append({"updateParagraphStyle": {"range": {"startIndex": el["startIndex"], "endIndex": el["endIndex"]},
                                                     "paragraphStyle": style, "fields": ",".join(fields)}})
        elif "table" in el:
            at = {"index": el["startIndex"]}
            cells = [c.get("tableCellStyle", {}) for r in el["table"]["tableRows"] for c in r["tableCells"]]
            # no padding in a cell is Google's default, 5 pt; Drive's import writes 0 ({"unit": "PT"} alone)
            if any(c.get(k, PADDING).get("magnitude", 0) != PADDING["magnitude"] for c in cells for k in PADS):
                out.append({"updateTableCellStyle": {"tableStartLocation": at, "tableCellStyle": {k: PADDING for k in PADS},
                                                     "fields": ",".join(PADS)}})
            runs = [e["textRun"] for r in el["table"]["tableRows"] for c in r["tableCells"] for p in c.get("content", [])
                    for e in p.get("paragraph", {}).get("elements", []) if "textRun" in e]
            if any(r.get("textStyle", {}).get("weightedFontFamily", {}).get("fontFamily") != CELL_FONT["weightedFontFamily"]["fontFamily"]
                   for r in runs):
                out.append({"updateTextStyle": {"range": {"startIndex": el["startIndex"], "endIndex": el["endIndex"]},
                                                "textStyle": CELL_FONT, "fields": "weightedFontFamily"}})
            cols = el["table"].get("tableStyle", {}).get("tableColumnProperties", [])
            want = WIDTHS.get(kinds.get(el["startIndex"]), ())
            have = [c.get("width", {}).get("magnitude") for c in cols]
            if len(want) == len(cols) and list(want) != have and (widths or len(set(have)) == 1):
                out += [{"updateTableColumnProperties": {"tableStartLocation": at, "columnIndices": [i], "fields": "width,widthType",
                         "tableColumnProperties": {"widthType": "FIXED_WIDTH", "width": {"magnitude": w, "unit": "PT"}}}}
                        for i, w in enumerate(want)]
    return out


def template_requests(doc):
    """Requests that empty a trip doc down to its layout: the Information section to one empty line, each table to its
    header row and EMPTY_ROWS empty rows, nothing after the last table; every style stays. From the end backwards,
    so each request's place holds."""
    body = doc["body"]["content"]
    plain = lambda at: [{"updateParagraphStyle": {"range": {"startIndex": at, "endIndex": at + 1},
                                                  "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}, "fields": "namedStyleType"}},
                        {"deleteParagraphBullets": {"range": {"startIndex": at, "endIndex": at + 1}}}]
    out, last = [], max(i for i, el in enumerate(body) if "table" in el)
    if body[-1]["endIndex"] - 1 > body[last]["endIndex"]:
        out += [{"deleteContentRange": {"range": {"startIndex": body[last]["endIndex"], "endIndex": body[-1]["endIndex"] - 1}}}]
        out += plain(body[last]["endIndex"])
    for t in sorted(tables(doc).values(), key=lambda t: -t["start"]):
        out += [{"deleteTableRow": {"tableCellLocation": {"tableStartLocation": {"index": t["start"]}, "rowIndex": r, "columnIndex": 0}}}
                for r in range(len(t["rows"]) - 1, EMPTY_ROWS, -1)]
        out += [{"deleteContentRange": {"range": {"startIndex": c["start"], "endIndex": c["end"]}}}
                for row in reversed(t["rows"][1:EMPTY_ROWS + 1]) for c in reversed(row) if c["end"] > c["start"]]
    heads = [el for el in body if "paragraph" in el and el["paragraph"]["paragraphStyle"].get("namedStyleType") == "HEADING_1"]
    info = next((i for i, el in enumerate(body) if el in heads[:1]), None)
    if info is not None and info + 1 < len(body) and body[info + 1] not in heads and "paragraph" in body[info + 1]:
        start, end = body[info + 1]["startIndex"], next(el for el in body[info + 1:] if el in heads or "table" in el)["startIndex"] - 1
        if end > start:
            out.append({"deleteContentRange": {"range": {"startIndex": start, "endIndex": end}}})
        out += plain(start)
    return out


def make_template(google, source, name="Trip template (tripmail)"):
    """A copy of the trip doc source, emptied by template_requests and padded to EMPTY_ROWS rows, in My Drive (not in
    the trips folder, so it is not taken for a trip); returns its id, for "trip_docs_template" in config."""
    doc_id = google.call("POST", f"{DRIVE}/{source}/copy", {"name": name, "parents": ["root"]})["id"]
    google.batch(doc_id, template_requests(google.get(doc_id)))
    google.batch(doc_id, pad(google.get(doc_id)))
    return doc_id


def over(name, days, today):
    """Whether a doc's trip is past: by its dates, else by the years in its name ("Turkey 2021")."""
    years = [int(y) for y in re.findall(r"\b(?:19|20)\d\d\b", name)]
    return days[1] < today if days else bool(years) and max(years) < today.year


def pad(doc):
    """Rows that bring each table with no data yet (Plan, Transport) up to EMPTY_ROWS empty ones, the later table
    first so the earlier one's place holds."""
    out = []
    for t in sorted(tables(doc).values(), key=lambda t: -t["start"]):
        if not any(c["text"] for row in t["rows"][1:] for c in row):
            out += add_row(t, len(t["rows"]) - 1) * max(0, EMPTY_ROWS + 1 - len(t["rows"]))
    return out


# --- where a booking goes ---

def stay_row(plan, stay):
    """("fill", row) for the Plan row that already links to the booking, else for the row of this place and dates;
    else its place in date order: ("fill", row) when that row is empty, or ("insert", row to insert below). Filling
    writes only empty cells."""
    after, best, most = 0, None, 0
    start, end = date.fromisoformat(stay["start"]), date.fromisoformat(stay["end"])
    for r, row in enumerate(plan["rows"][1:], 1):
        cell = lambda name: row[plan["cols"][name]] if name in plan["cols"] else {"text": "", "links": []}
        if any(stay["code"] in l or l == stay["link"] for l in cell("stay")["links"]):
            return "fill", r
        days = parse_dates(cell("dates")["text"])
        if days and days[0] <= start:
            after = r
        place = _norm(cell("place")["text"])
        if days and place and (place in _norm(stay["place"]) or _norm(stay["place"]) in place):
            # the nights it shares with the stay ("North Phú Quốc 25–26" shares none with a stay from the 26th:
            # that one is "South Phú Quốc 26–28"); a row of one day counts as that night
            nights = (min(end, max(days[1], days[0] + timedelta(days=1))) - max(start, days[0])).days
            if nights > most:
                best, most = r, nights
    if best:
        return "fill", best
    if after + 1 < len(plan["rows"]) and not any(c["text"] for c in plan["rows"][after + 1]):
        return "fill", after + 1  # an empty row in its place
    return "insert", after


def stay_cells(stay):
    s, e = date.fromisoformat(stay["start"]), date.fromisoformat(stay["end"])
    return {"place": stay["place"], "dates": fmt_dates(s, e), "stay": (stay["type"], stay["link"] or None),
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


def _ends(title):
    """The two ends of a Transport title, run together without accents, or None: "✈️ VJ341: Ho Chi Minh City -
    Phuquoc" -> ("hochiminhcity", "phuquoc"), "Phú Quốc - Nha Trang" -> ("phuquoc", "nhatrang")."""
    parts = re.split(r"\s[-–—]\s|\s*→\s*", title.split(": ", 1)[-1])
    ends = tuple(re.sub(r"[^a-z]", "", _norm(p.replace("Đ", "D").replace("đ", "d"))) for p in parts)
    return ends if len(ends) == 2 and all(ends) else None


def planned(row, cols, leg):
    """Whether a row of yours plans this trip before it was booked: its first cell names the same two ends in the
    same order ("Phú Quốc - Nha Trang" for "✈️ 9G2952: Phuquoc - Nhatrang"; one may hold the other, as a station's
    name its town's) and no flight or train of its own (no ":"), and its Date cell is that day without a time."""
    first, mine = row[0]["text"], _ends(leg["title"])
    date_cell = row[cols["date"]]["text"] if "date" in cols else ""
    theirs = _ends(first) if ":" not in first else None
    days = parse_dates(date_cell)
    return bool(mine and theirs and days and days[0] == _when(leg["date"])[0] and not re.search(r"\d:\d\d", date_cell)
                and all(a in b or b in a for a, b in zip(mine, theirs)))


def leg_row(transport, leg):
    """("done", row) if a Transport row has this trip on this day (same title, or same flight or train number);
    ("replace", row) for a row of yours that planned it (planned); else its place in time order: ("fill", row) when
    that row is empty, or ("insert", row to insert below)."""
    rows, me, after = transport["rows"], _when(leg["date"]), 0
    for r, row in enumerate(rows[1:], 1):
        text = " ".join(c["text"] for c in row)
        same = row[0]["text"] == leg["title"] or (leg["flight"] and leg["flight"] in row[0]["text"].replace(" ", ""))
        if same and leg["date"][:8] in text:
            return "done", r
    for r, row in enumerate(rows[1:], 1):
        if planned(row, transport["cols"], leg):
            return "replace", r
    for r, row in enumerate(rows[1:], 1):
        text = " ".join(c["text"] for c in row)
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
                             "name": trip["name"] if trip else plan._city(away, airports), "price": r.get("price", "")}
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
                              "end": trip["end"] if trip else r["arr_local"][:10], "price": r.get("price", "")}
    return out


def _same_row(old, new):
    """Whether two specs of a booking write the same row, but for its price: they differ only in the price (or
    the older one was saved without one), or in what only picks or names the doc: the trip's name, and a flight's
    or ride's trip dates (they grow when the trip gets another flight). Such a change never empties the row."""
    keep = ("price", "name") + (("start", "end") if old.get("what") == "leg" else ())
    return old != new and {**old, **dict.fromkeys(keep, "")} == {**new, **dict.fromkeys(keep, "")}


def _stub(name):
    """An empty doc made from TEMPLATE, for dry runs that would create one."""
    def table(start, heads):
        cells = [{"startIndex": start + 2 + 2 * i, "endIndex": start + 4 + 2 * i, "content": [{"paragraph": {"elements": [
            {"startIndex": start + 3 + 2 * i, "endIndex": start + 4 + 2 * i, "textRun": {"content": h + "\n"}}]}}]} for i, h in enumerate(heads)]
        return {"startIndex": start, "table": {"tableRows": [{"tableCells": cells}]}}
    return {"title": name, "body": {"content": [table(10, ["Place", "Dates", "Stay", "Price", "Comments"]),
                                                  table(100, ["Transport", "Date", "Price", "Comments"])]}}


class TripDocs:
    def __init__(self, google, folder, log, dry=False, skip=()):
        self.g, self.folder, self.log, self.dry, self.skip, self.names = google, folder, log, dry, set(skip), {}
        self.created = {}  # doc id -> name of the docs this run made

    def files(self, today=None):
        """{doc id: name and days}; the empty tables of docs whose trip is not over padded."""
        out = {}
        for f in self.g.docs_in(self.folder):
            self.names[f["id"]] = f["name"]
            doc = self.g.get(f["id"])
            days = span(doc)
            if pad(doc) and today and not over(f["name"], days, today):
                self.batch(f["id"], pad(doc))
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
        self.names[doc_id] = self.created[doc_id] = title
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
            values = {"transport": spec["title"], "date": spec["date"], "price": spec.get("price", ""),
                      "comments": "Booking code: " + ", ".join(spec["codes"]) if spec["codes"] else ""}
            if how == "fill":
                self.batch(doc_id, fill(t, r, values))
            elif how == "replace":
                self.batch(doc_id, replace_cells(t, r, values))
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
        if how == "fill":  # the place and dates too when the row has none
            self.batch(doc_id, fill(t, r, stay_cells(spec)))
        elif how == "insert":
            self._insert_and_fill(doc_id, "plan", r, stay_cells(spec))

    def price(self, doc_id, spec):
        """A booking's new price into the Price cell of its row, when that cell is empty (yours is kept)."""
        if not spec.get("price"):
            return
        kind = "transport" if spec["what"] == "leg" else "plan"
        t = self._table(doc_id, kind)
        if not t:
            return
        how, r = leg_row(t, spec) if kind == "transport" else stay_row(t, spec)
        if how in ("done", "fill") and any(c["text"] for c in t["rows"][r]):
            self.batch(doc_id, fill(t, r, {"price": spec["price"]}))

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
            col = t and t["cols"].get("stay")
            for r, row in enumerate(t["rows"][1:] if t else [], 1):
                if col is not None and any(spec["code"] in l or l == spec["link"] for l in row[col]["links"]):
                    self.batch(doc_id, clear(t, r, ["stay", "price"]))
                    return
        elif spec["what"] == "leg":
            t = self._table(doc_id, "transport")
            how, r = leg_row(t, spec) if t else (None, None)
            if how == "done":  # your comments stay (from a row you planned it in); tripmail's booking code goes
                comments = t["rows"][r][t["cols"]["comments"]]["text"] if "comments" in t["cols"] else ""
                mine = not comments or re.fullmatch(r"Booking code: [^\n]*", comments)
                self.batch(doc_id, clear(t, r, [c for c in t["cols"] if c != "comments" or mine]))
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
        files = self.files(now.date())
        today = now.date().isoformat()
        for i in [i for i in steps["update"] if _same_row(done[i]["spec"], desired[i])]:  # its price into its row,
            steps["update"].remove(i)                                                     # nothing written again
            if done[i]["doc"] in files and desired[i]["end"] >= today:
                self.price(done[i]["doc"], desired[i])
            done[i]["spec"] = desired[i]
        for i in steps["remove"] + steps["update"]:
            if done[i]["spec"]["end"] >= today and done[i]["doc"] in files:
                self.remove(done[i]["doc"], done[i]["spec"])
            del done[i]
        order = lambda i: (desired[i]["start"], desired[i].get("dep_local", ""), desired[i].get("what") == "car")  # noqa: E731
        for i in sorted(steps["create"] + steps["update"] + waiting, key=order):  # a car after its stay of that day: in its row
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

    def prices(self, state, now, rates=None):
        """Euros under the prices in other currencies and a total under each table, in the docs of trips not over
        yet that changed since the last look, but not in the last half hour (the user may still be typing)."""
        reg = state.setdefault("docs", {}).setdefault("priced", {})
        today, cache = now.date(), state["docs"].get("rates") or {}
        for f in self.g.docs_in(self.folder):
            self.names[f["id"]] = f["name"]
            modified = f.get("modifiedTime", "")
            if reg.get(f["id"]) == modified and modified or modified and now - _local(modified) < QUIET:
                continue
            doc = self.g.get(f["id"])
            days = span(doc)
            if not days or days[1] < today:
                reg[f["id"]] = modified
                continue
            if cache.get("day") != today.isoformat():
                try:
                    cache = state["docs"]["rates"] = {"day": today.isoformat(), "rates": (rates or fetch_rates)()}
                except Exception as e:  # tried again next run
                    self.log(f"no exchange rates, prices in euros wait: {e!r}")
                    return
            requests = price_requests(doc, cache["rates"])
            if requests and self.dry:
                self.log(f"would write prices in euros in doc {f['name']!r}")
            elif requests:
                self.g.batch(f["id"], requests)
                self.log(f"prices in euros written in doc {f['name']!r}")
            if not self.dry:
                reg[f["id"]] = self.g.modified(f["id"]) if requests else modified

    def suggest(self, state, now, ask, history=None, limit=3):
        """Suggestions in the docs of trips not over yet that changed since the last look, but not in the last half
        hour (the user may still be typing; tripmail's own edits of this run wait an hour too). At most limit
        questions to Claude per run; the rest wait for the next. history(places, start, end): where the user has been
        near those places before the trip, as text for Claude ("" when nothing)."""
        reg = state.setdefault("docs", {}).setdefault("suggested", {})
        today, asked = now.date(), 0
        for f in self.g.docs_in(self.folder):
            self.names[f["id"]] = f["name"]
            seen, modified = reg.get(f["id"]), f.get("modifiedTime", "")
            if seen and seen["modified"] == modified or modified and now - _local(modified) < QUIET:
                continue
            doc = self.g.get(f["id"])
            days = span(doc)
            if not days or days[1] < today:
                reg[f["id"]] = {"modified": modified}
                continue
            text = without_suggestions(self.g.export(f["id"]))
            digest = hashlib.sha256(without_euros(text).encode()).hexdigest()[:16]
            if seen and seen.get("hash") == digest or not seen and section(doc):  # only the suggestions changed
                reg[f["id"]] = {"modified": modified, "hash": digest}
                continue
            if asked >= limit:
                continue
            asked += 1
            if self.dry:
                self.log(f"would ask Claude for suggestions for doc {f['name']!r}")
                continue
            try:
                been = history(places(doc), *days) if history else ""
                data = parse_reply(ask(PROMPT.format(today=f"{today:%d.%m.%y}", first=f"{max(today, days[0]):%d.%m.%y}",
                                                     doc=_plain(text), history=been or "Nothing near these places.")))
                self.g.batch(f["id"], suggestion_requests(self.g.get(f["id"]), suggestion_lines(data, today)))
            except Exception as e:  # tried again next run
                self.log(f"no suggestions for doc {f['name']!r}: {e!r}")
                continue
            self.log(f"suggestions written in doc {f['name']!r}: things to do in {len(data['things_to_do'])} place(s), "
                     f"{len(data['itinerary'])} day(s)")
            reg[f["id"]] = {"modified": self.g.modified(f["id"]), "hash": digest}


# --- prices in euros: "≈ 25.39€" under a price in another currency, "Total: 123.45€" under each table ---

RATES = "https://open.er-api.com/v6/latest/EUR"  # free, no key, every currency (the ECB's rates have no VND or LAK)
SYMBOLS = {"US$": "USD", "HK$": "HKD", "NZ$": "NZD", "NT$": "TWD", "AU$": "AUD", "CA$": "CAD", "MX$": "MXN", "S$": "SGD",
           "A$": "AUD", "C$": "CAD", "R$": "BRL", "€": "EUR", "$": "USD", "£": "GBP", "฿": "THB", "₫": "VND", "₭": "LAK",
           "₺": "TRY", "₹": "INR", "¥": "JPY", "zł": "PLN"}  # the dollars with a prefix before "$" alone
CUR_RX = re.compile("|".join(re.escape(k) for k in SYMBOLS) + r"|\b[A-Z]{3}\b")
NUM_RX = re.compile(r"\d[\d.,]*")
EURO_RX = re.compile(r"≈\s*(\d[\d.,]*)\s*€")
TOTAL = "Total: "
STALE = 0.05  # a conversion this far off today's rate is written again (the price was changed); less is left alone


def _number(num):
    """'773760', '773.760', '1,234.56', '18,90' as a float: a separator before exactly 3 last digits groups thousands."""
    num = num.rstrip(".,")
    if "," in num and "." in num:
        dec = max(num.rfind(","), num.rfind("."))
        return float(re.sub(r"[.,]", "", num[:dec]) + "." + num[dec + 1:])
    if re.fullmatch(r"\d{1,3}([.,]\d{3})+", num):
        return float(re.sub(r"[.,]", "", num))
    return float(num.replace(",", "."))


def in_euros(text, rates):
    """(euros, foreign) of a price cell's text: '10.45 USD', '773760 VND', '99€', '€64', '~€3', '20 USD + 5'; a part
    without a currency has the cell's other one. (None, False) when it has no number or no currency known."""
    parts, total, foreign = [], 0.0, False
    for term in text.split("+"):
        num, cur = NUM_RX.search(term), CUR_RX.search(term)
        if num:
            parts.append((_number(num.group()), SYMBOLS.get(cur.group(), cur.group()) if cur else None))
    known = {c for _, c in parts if c}
    if not parts or not known or (len(known) > 1 and any(c is None for _, c in parts)):
        return None, False
    for value, cur in parts:
        cur = cur or next(iter(known))
        if cur != "EUR" and cur not in rates:
            return None, False
        total += value if cur == "EUR" else value / rates[cur]
        foreign |= cur != "EUR"
    return round(total, 2), foreign


def _euros(x):
    return f"{x:.2f}€"


def _plain_text(at, text, para=False):
    style = {"updateTextStyle": {"range": {"startIndex": at, "endIndex": at + _len(text)}, "textStyle": {"bold": False, **CELL_FONT},
                                 "fields": "bold,italic,underline,link,foregroundColor,weightedFontFamily"}}
    if para:  # a line under a table: Normal text, not the heading it was split from
        return [{"updateParagraphStyle": {"range": {"startIndex": at, "endIndex": at + _len(text)},
                                          "paragraphStyle": {"namedStyleType": "NORMAL_TEXT", "alignment": "START"},
                                          "fields": "namedStyleType,alignment"}},
                {"updateTextStyle": {"range": {"startIndex": at, "endIndex": at + _len(text)}, "textStyle": {},
                                     "fields": "bold,italic,underline,link,foregroundColor"}}]
    return [style]


def price_requests(doc, rates):
    """Requests that keep, in each table with a Price column, a line "≈ x€" under every price in another currency
    (written again when more than STALE off) and a line "Total: x€" right under the table (with the prices it could
    not read). From the end of the doc backwards, so each request's indexes still hold."""
    out = []
    for t in sorted(tables(doc).values(), key=lambda t: -t["start"]):
        col = t["cols"].get("price")
        if col is None:
            continue
        cells, total, counted, skipped = [], 0.0, 0, []
        for row in t["rows"][1:]:
            cell = row[col]
            paras = cell["paras"]
            own = paras[-1] if len(paras) > 1 and EURO_RX.fullmatch(paras[-1]["text"]) else None
            text = " ".join(q["text"] for q in (paras[:-1] if own else paras)).strip()
            eur, foreign = in_euros(text, rates) if text else (None, False)
            if eur is not None:
                total, counted = total + eur, counted + 1
            elif text:
                skipped.append(text)
            cells.append((cell, own, eur if foreign else None, paras))
        line = None
        if counted:
            line = TOTAL + _euros(total) + (f" (not counted: {', '.join(skipped)})" if skipped else "")
        after = t["after"]
        if after and after["text"].startswith(TOTAL.strip()) and after["style"] == "NORMAL_TEXT":
            if line is None:
                out.append({"deleteContentRange": {"range": {"startIndex": after["start"], "endIndex": after["end"]}}})
            elif after["text"] != line:
                out.append({"deleteContentRange": {"range": {"startIndex": after["start"], "endIndex": after["end"] - 1}}})
                out += [{"insertText": {"location": {"index": after["start"]}, "text": line}}] + _plain_text(after["start"], line, True)
        elif line and after:
            out += [{"insertText": {"location": {"index": after["start"]}, "text": line + "\n"}}] + _plain_text(after["start"], line, True)
        for cell, own, eur, paras in reversed(cells):
            want = "≈ " + _euros(eur) if eur is not None else None
            if own:
                old = _number(EURO_RX.fullmatch(own["text"]).group(1))
                if want and abs(old - eur) <= STALE * max(eur, 0.01):
                    continue
                if want:  # the line's text replaced
                    out.append({"deleteContentRange": {"range": {"startIndex": own["start"], "endIndex": own["end"] - 1}}})
                    out += [{"insertText": {"location": {"index": own["start"]}, "text": want}}] + _plain_text(own["start"], want)
                else:  # no foreign price left: the line goes, with the newline before it
                    out.append({"deleteContentRange": {"range": {"startIndex": paras[-2]["end"] - 1, "endIndex": own["end"] - 1}}})
            elif want:
                at = cell["end"]
                out += [{"insertText": {"location": {"index": at}, "text": "\n" + want}}] + _plain_text(at + 1, want)
    return out


def fetch_rates():
    """{currency: units per euro}, today's."""
    with urllib.request.urlopen(RATES, timeout=30) as r:
        data = json.load(r)
    if data.get("result") != "success":
        raise ValueError(f"rates: {data.get('error-type') or data.get('result')}")
    return data["rates"]


def without_euros(text):
    """A doc's text without the lines tripmail writes for prices: they change nothing about the trip."""
    return re.sub(r"(?m)^.*\bTotal: [\d.]+€.*$", "", EURO_RX.sub("", text))


# --- suggestions: things to do and an itinerary by Claude, in a section of the doc that is tripmail's own ---

SUGGESTIONS, MARK, MARKS = "Suggestions", "By tripmail", ("By tripmail", "By flightmail")  # and as docs written before the rename have it
QUIET = timedelta(minutes=30)
PROMPT = """You help plan a trip. Today is {today}. Below is the trip's document: notes under Information, the Plan
table (places, dates, where we sleep, comments) and the Transport table (flights, trains, buses, rental cars, with
their departure times). Dates are written day.month.year, like 24–26.09.26.

Reply with JSON only, no other text:
{{"things_to_do": [{{"place": "...", "items": [{{"name": "...", "why": "..."}}]}}],
 "itinerary": [{{"date": "YYYY-MM-DD", "place": "...", "plan": "..."}}]}}

- things_to_do: for each place where we sleep (the Plan's places; when the Plan is empty, where the flights go), 3
  to 6 specific things worth doing there or nearby: named sights, walks and hikes, viewpoints, beaches, villages,
  food to try. With a rental car, the places within about an hour's drive count as nearby. A town we only land in
  or pass through (the airport's city when we sleep elsewhere) gets no entry of its own. "name": what it is called,
  as you would search for it on a map ("Ponte Vecchio", "Sentiero degli Dei"; for food the dish); "why": one short
  sentence that says why. Follow what the notes and comments ask for, and leave out what they already plan.
- Things new to me: under "Where I have been before" is what my travel records know of my earlier visits near
  these places. Leave out what a first visit there is about (the famous sights, the old town, the best known
  beaches and walks of a town I spent days in) and whatever the list says I did. Where the list shows I know the
  area well (many days on several visits around it), its famous sights are not new to me either, even those
  outside the towns listed: its national park, best known peaks, villages, gorges and walks. Suggest what I
  have not done: less known places, villages, nature, hikes and rides off the usual list, food. A town seen for
  a day long ago may still get its one main sight.
- What I still want to do there, when the list has it: a place I saved goes in when it fits the trip; one or
  two of the famous climbs I have not ridden make a ride (by car to its foot when it is far), with a bike to
  rent or bring.
- itinerary: one entry per day from {first} to the trip's last day, following the stays' dates and the transport
  times (the arrival day, travel between places, the departure day), with that day's transport in it. Each day
  starts and ends where we sleep; with a car, days out by car from there. One or two sentences a day.
- Plain text in the strings: no Markdown, no links.

Where I have been before:
{history}

The document:
{doc}"""


def _local(stamp):
    """Drive's '2026-10-24T23:02:30.441Z' as a naive local datetime, like tripmail's now()."""
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)


def _ptext(el):
    return "".join(e.get("textRun", {}).get("content", "") for e in el["paragraph"].get("elements", [])).strip()


def _pstyle(el):
    return el["paragraph"].get("paragraphStyle", {}).get("namedStyleType", "")


def section(doc):
    """(start, end, at_end) of tripmail's Suggestions section: its heading (followed by the "By tripmail" line) up
    to the next top-level heading, or to the end of the doc (at_end); None when the doc has none."""
    body = doc["body"]["content"]
    for k, el in enumerate(body):
        if "paragraph" not in el or _ptext(el) != SUGGESTIONS or not _pstyle(el).startswith("HEADING"):
            continue
        nxt = next((e for e in body[k + 1:] if "paragraph" in e and _ptext(e)), None)
        if not nxt or not _ptext(nxt).startswith(MARKS):
            continue
        for e in body[k + 1:]:
            if "paragraph" in e and _pstyle(e) == "HEADING_1":
                return el["startIndex"], e["startIndex"], False
        return el["startIndex"], body[-1]["endIndex"] - 1, True
    return None


def without_suggestions(md):
    """The doc's Markdown without tripmail's Suggestions section."""
    lines = md.splitlines()
    for i, line in enumerate(lines):
        if re.fullmatch(r"#\s*\**Suggestions\**", line.strip()) and any(m in x for m in MARKS for x in lines[i + 1:i + 4]):
            end = next((j for j in range(i + 1, len(lines)) if re.match(r"#\s", lines[j])), len(lines))
            return "\n".join(lines[:i] + lines[end:]).strip()
    return md.strip()


def places(doc):
    """The trip's places as the doc names them: the Plan's places, then where the Transport rows go ("✈️ KL1234:
    Amsterdam - Lisbon": Lisbon), each once."""
    t, out = tables(doc), []
    plan, transport = t.get("plan"), t.get("transport")
    for row in (plan["rows"][1:] if plan and "place" in plan["cols"] else []):
        out.append(row[plan["cols"]["place"]]["text"])
    for row in (transport["rows"][1:] if transport and "transport" in transport["cols"] else []):
        ends = re.split(r"\s[-–—]\s|→", row[transport["cols"]["transport"]]["text"])
        out += ends[-1:] if len(ends) > 1 else []  # not "Rental car"
    out = [" ".join(x.split()) for x in out]
    return [x for i, x in enumerate(out) if x and x not in out[:i]]


def _plain(md):
    """Markdown with links reduced to their text and without booking codes: long, private, and nothing about the trip."""
    return re.sub(r"Booking code: [^|\n]*", "", re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", md))


def ask_claude(prompt, claude="claude", model="sonnet", timeout=600):
    """Claude's answer to prompt, from the Claude Code CLI signed in on this Mac, with no tools."""
    r = subprocess.run([claude, "-p", "--model", model, "--tools", "", "--no-session-persistence"], input=prompt,
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode or not r.stdout.strip():
        raise RuntimeError(f"claude failed ({r.returncode}): {(r.stdout or r.stderr).strip()[-300:]}")
    return r.stdout


def parse_reply(text):
    """{"things_to_do": [{place, items}], "itinerary": [{date, place, plan}]} out of Claude's answer (a code fence or
    a line around the JSON is fine)."""
    data = json.loads(text[text.index("{"):text.rindex("}") + 1])
    one = lambda s: " ".join(str(s).split())  # noqa: E731
    item = lambda i: ({"name": one(i.get("name", "")), "why": one(i.get("why", ""))} if isinstance(i, dict)  # noqa: E731
                      else {"name": "", "why": one(i)})  # a plain sentence, as answers before names had it
    todo = [{"place": one(p["place"]), "items": [x for x in map(item, p["items"]) if x["name"] or x["why"]]}
            for p in data.get("things_to_do", [])]
    days = [{"date": date.fromisoformat(d["date"]), "place": one(d.get("place", "")), "plan": one(d["plan"])}
            for d in data.get("itinerary", [])]
    if not any(p["items"] for p in todo) and not days:
        raise ValueError("no suggestions in the answer")
    return {"things_to_do": [p for p in todo if p["items"]], "itinerary": sorted(days, key=lambda d: d["date"])}


def maps_link(*words):
    """A Google Maps search for what the words name ("Ilha Deserta, Faro"): a link that always leads somewhere."""
    return "https://www.google.com/maps/search/?api=1&query=" + urllib.parse.quote(", ".join(w for w in words if w))


def suggestion_lines(data, today):
    """[(text, kind, link)], kind one of h1, note, h2, place (a Heading 3), item (a bullet) or day (a bullet led by
    its date and place); link None or (how many characters at the start it covers, url): a place and a thing to do
    link to Google Maps."""
    out = [(SUGGESTIONS, "h1"), (f"{MARK} on {today:%d.%m.%y}, from the plan above, and written again whenever the doc "
                                 "changes: move what you want to keep above this heading.", "note")]
    if data["things_to_do"]:
        out.append(("Things to do", "h2"))
        for p in data["things_to_do"]:
            out.append((p["place"], "place", (len(p["place"]), maps_link(p["place"]))))
            for i in p["items"]:
                text = f"{i['name']}: {i['why']}" if i["name"] and i["why"] else i["name"] or i["why"]
                out.append((text, "item", (len(i["name"]), maps_link(i["name"], p["place"])) if i["name"] else None))
    if data["itinerary"]:
        out.append(("Itinerary", "h2"))
        out += [(f"{d['date']:%a %d.%m}{', ' + d['place'] if d['place'] else ''}: {d['plan']}", "day") for d in data["itinerary"]]
    return [(line + (None,))[:3] for line in out]


def suggestion_requests(doc, lines):
    """Requests that replace tripmail's Suggestions section with lines, or add one at the end of the doc."""
    out, sec, body = [], section(doc), doc["body"]["content"]
    if sec:
        at, end, at_end = sec
        if end > at:
            out.append({"deleteContentRange": {"range": {"startIndex": at, "endIndex": end}}})
        lead, tail = "", "" if at_end else "\n"  # at the end the doc's last newline closes the last line
    else:
        last = body[-1]
        at, tail = last["endIndex"] - 1, ""
        lead = "\n" if "paragraph" in last and _ptext(last) else ""
    text = lead + "\n".join(t for t, _, _ in lines) + tail
    out.append({"insertText": {"location": {"index": at}, "text": text}})
    base = at + _len(lead)
    stop = base + _len("\n".join(t for t, _, _ in lines))
    out.append({"updateTextStyle": {"range": {"startIndex": base, "endIndex": stop}, "textStyle": {}, "fields": "bold,italic,link"}})
    out.append({"deleteParagraphBullets": {"range": {"startIndex": base, "endIndex": stop + 1}}})
    named = {"h1": "HEADING_1", "h2": "HEADING_2", "place": "HEADING_3"}  # the doc's own styles, nothing on top
    i, bullets = base, []
    for t, kind, link in lines:
        end = i + _len(t)
        out.append({"updateParagraphStyle": {"range": {"startIndex": i, "endIndex": end + 1},
                                             "paragraphStyle": {"namedStyleType": named.get(kind, "NORMAL_TEXT")}, "fields": "namedStyleType"}})
        if link:
            out.append({"updateTextStyle": {"range": {"startIndex": i, "endIndex": i + _len(t[:link[0]])},
                                            "textStyle": {"link": {"url": link[1]}}, "fields": "link"}})
        if kind in ("item", "day"):
            if bullets and bullets[-1][1] == i:
                bullets[-1][1] = end + 1
            else:
                bullets.append([i, end + 1])
        i = end + 1
    out += [{"createParagraphBullets": {"range": {"startIndex": a, "endIndex": b}, "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}}
            for a, b in bullets]
    return out


if __name__ == "__main__":
    if sys.argv[1:] == ["auth"]:
        d = Path.home() / ".flightmail"  # tripmail's folder: by its older name for an install from before the rename
        d = d if d.is_dir() else Path.home() / ".tripmail"
        authorize(d / "google_client.json", d / "google_token.json")
    elif sys.argv[1:2] == ["template"] and len(sys.argv) == 3:
        d = Path.home() / ".flightmail"
        d = d if d.is_dir() else Path.home() / ".tripmail"
        print(make_template(Google(d / "google_client.json", d / "google_token.json"), sys.argv[2]))
    else:
        sys.exit("usage: python mail/tripdocs.py auth | template <id of a trip doc to copy the layout of>")
