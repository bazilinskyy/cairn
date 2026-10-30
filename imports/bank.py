#!/usr/bin/env python3
"""Your bank and card payments into Cairn: what you spent on each trip's days (beyond the stays your booking emails
price), and payments abroad on days nothing else in Cairn knows where you were, to check as trips that may be missing.

Reads the CSV statements banks let you download, as they come, any number and mixed:
  - Revolut (Accounts > Statement > Excel/CSV): Type, Started Date, Description, Amount, Currency, State
  - N26 (Statements > Download CSV): Booking Date, Partner Name, Type, Amount (EUR), Original Currency; card refunds too
  - ING (NL), ABN AMRO, Rabobank, bunq: their "download transactions" CSV
  - any other CSV with a date, an amount and a description column (found by their names)

  python imports/bank.py ~/Downloads/account-statement_*.csv ~/Downloads/NL12INGB*.csv
  python imports/bank.py ~/Downloads/*.csv --send mini:repos/contrail/data/transactions.json

Writes data/transactions.json: [{"date": "YYYY-MM-DD", "amount" (negative: spent), "currency", "description",
"country" (ISO alpha-2, when the payment says where: "ALBERT HEIJN LEIDEN NLD", Revolut's foreign currency)}]; only card
payments and cash withdrawals (not transfers, salary or rent), each once across statements; a card refund (a booking
cancelled) with a positive amount and "refund": true. No network.
"""
import argparse
import csv
import io
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ISO 3166 alpha-3 -> alpha-2, for the country at the end of a card payment's description ("... MADRID ESP")
A3 = dict(x.split(":") for x in (
    "AUT:AT BEL:BE BGR:BG HRV:HR CYP:CY CZE:CZ DNK:DK EST:EE FIN:FI FRA:FR DEU:DE GRC:GR HUN:HU IRL:IE ITA:IT LVA:LV LTU:LT "
    "LUX:LU MLT:MT NLD:NL POL:PL PRT:PT ROU:RO SVK:SK SVN:SI ESP:ES SWE:SE GBR:GB NOR:NO CHE:CH ISL:IS UKR:UA TUR:TR "
    "USA:US CAN:CA MEX:MX BRA:BR ARG:AR CHL:CL JPN:JP CHN:CN KOR:KR IND:IN THA:TH VNM:VN IDN:ID MYS:MY SGP:SG AUS:AU NZL:NZ "
    "ISR:IL EGY:EG MAR:MA TUN:TN ZAF:ZA ARE:AE QAT:QA GEO:GE ARM:AM AZE:AZ SRB:RS MNE:ME BIH:BA MKD:MK ALB:AL XKX:XK MDA:MD "
    "BLR:BY RUS:RU KAZ:KZ UZB:UZ KGZ:KG CPV:CV LKA:LK NPL:NP PHL:PH TWN:TW HKG:HK MAC:MO CUB:CU DOM:DO PRI:PR CRI:CR PAN:PA "
    "COL:CO PER:PE ECU:EC BOL:BO URY:UY PRY:PY JOR:JO LBN:LB OMN:OM SAU:SA KEN:KE TZA:TZ ETH:ET MUS:MU SYC:SC MDV:MV").split())
# a currency used in one country only: a payment in it was made there
CURRENCY_COUNTRY = {"GBP": "GB", "CHF": "CH", "SEK": "SE", "NOK": "NO", "DKK": "DK", "ISK": "IS", "PLN": "PL", "CZK": "CZ",
                    "HUF": "HU", "RON": "RO", "BGN": "BG", "UAH": "UA", "TRY": "TR", "GEL": "GE", "AMD": "AM", "AZN": "AZ",
                    "RSD": "RS", "MKD": "MK", "ALL": "AL", "BAM": "BA", "MDL": "MD", "ILS": "IL", "EGP": "EG", "MAD": "MA",
                    "TND": "TN", "JPY": "JP", "CNY": "CN", "KRW": "KR", "INR": "IN", "THB": "TH", "VND": "VN", "IDR": "ID",
                    "MYR": "MY", "SGD": "SG", "AUD": "AU", "NZD": "NZ", "CAD": "CA", "MXN": "MX", "BRL": "BR", "ARS": "AR",
                    "CLP": "CL", "ZAR": "ZA", "AED": "AE", "QAR": "QA", "CVE": "CV", "LKR": "LK", "NPR": "NP", "PHP": "PH",
                    "TWD": "TW", "HKD": "HK", "JOD": "JO", "KZT": "KZ", "UZS": "UZ", "KGS": "KG", "USD": "US"}
SPEND = re.compile(r"card|pas|betaalautomaat|geldautomaat|atm|cash|bea|gea|pos|kaart|payment", re.I)
NOT_SPEND = re.compile(r"transfer|overschrijving|overboeking|salary|salaris|rent|huur|topup|top-up|exchange|incasso|savings|sparen", re.I)


def number(s):
    """'-12,50', '1.234,56', '-1,234.56', '12.5' -> float, or None."""
    s = (s or "").strip().replace("−", "-").replace(" ", "")
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def day(s):
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y%m%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s[:len(datetime(2000, 1, 1).strftime(fmt))] if fmt != "%Y%m%d" else s[:8], fmt).date().isoformat()
        except ValueError:
            continue
    return None


def country_of(text, currency):
    m = re.search(r"\b([A-Z]{3})\s*$", (text or "").strip())
    if m and m.group(1) in A3:
        return A3[m.group(1)]
    m = re.search(r"\b([A-Z]{3})\b(?!.*\b[A-Z]{3}\b)", text or "")
    if m and m.group(1) in A3 and m.group(1) not in ("EUR", "ATM", "POS", "BEA", "GEA"):
        return A3[m.group(1)]
    m = re.search(r"\b\d+[.,]\d{2}\s+([A-Z]{3})\b", text or "")  # ING: "... 12,50 USD Koers ..."
    if m and m.group(1) in CURRENCY_COUNTRY:
        return CURRENCY_COUNTRY[m.group(1)]
    return CURRENCY_COUNTRY.get((currency or "").upper())


def rows_of(data):
    text = data.decode("utf-8-sig", "replace")
    sample = text[:4000]
    delim = max([";", ",", "\t"], key=sample.count)
    return list(csv.reader(io.StringIO(text), delimiter=delim))


def read_file(rows):
    """The spending of one statement: [{date, amount, currency, description, country}]."""
    if not rows:
        return []
    head = [h.strip().lower() for h in rows[0]]
    has_head = any(re.search(r"date|datum|amount|bedrag|description|omschrijving", h) for h in head)
    body = rows[1:] if has_head else rows
    col = lambda *names: next((i for i, h in enumerate(head) for n in names if n in h), None) if has_head else None  # noqa: E731
    out = []
    if has_head and "started date" in head and "type" in head:  # Revolut
        i = {h: k for k, h in enumerate(head)}
        for r in body:
            if len(r) < len(head) or r[i["state"]].strip().upper() not in ("COMPLETED", ""):
                continue
            kind, amount = r[i["type"]].upper(), number(r[i["amount"]])
            if kind not in ("CARD_PAYMENT", "ATM") or amount is None or amount >= 0:
                continue
            cur, desc = r[i["currency"]].strip(), r[i["description"]].strip()
            out.append({"date": day(r[i["started date"]]), "amount": amount, "currency": cur, "description": desc, "country": country_of(desc, cur)})
        return [x for x in out if x["date"]]
    if has_head and "partner name" in head and "amount (eur)" in head:  # N26: card payments (and their refunds) and card fees, in euros
        i = {h: k for k, h in enumerate(head)}
        for r in body:
            if len(r) < len(head):
                continue
            kind, amount = r[i["type"]].strip(), number(r[i["amount (eur)"]])
            if amount is None or kind not in ("Presentment", "Presentment Refund", "Fee") or (amount >= 0) != (kind == "Presentment Refund"):
                continue
            cur, desc = r[i["original currency"]].strip(), " ".join(x for x in (r[i["partner name"]], r[i["payment reference"]]) if x.strip()).strip()
            t = {"date": day(r[i["booking date"]]), "amount": amount, "currency": "EUR", "description": re.sub(r"\s+", " ", desc),
                 "country": country_of(desc, cur if cur and cur != "EUR" else "")}
            if kind == "Presentment Refund":
                t["refund"] = True
            out.append(t)
        return [x for x in out if x["date"]]
    if not has_head and rows and len(rows[0]) >= 7 and day(rows[0][0]):  # ABN AMRO tab file: account, cur, date, ..., amount, description
        for r in rows:
            amount = number(r[6]) if len(r) > 7 else None
            desc = " ".join(r[7:]) if len(r) > 7 else ""
            if amount is not None and amount < 0 and SPEND.search(desc) and not NOT_SPEND.search(desc):
                out.append({"date": day(r[2]), "amount": amount, "currency": r[1] or "EUR", "description": desc.strip(), "country": country_of(desc, r[1])})
        return [x for x in out if x["date"]]
    d, a = col("transactiedatum", "datum", "date", "boekingsdatum", "booking"), col("bedrag", "amount", "betrag")
    desc_cols = [i for i, h in enumerate(head) if re.search(r"omschrijving|description|naam|name|mededeling|memo|details|merchant|tegenpartij", h)]
    sign, kind_col, cur_col = col("af bij", "debit/credit", "af/bij"), col("mutatiesoort", "code", "type"), col("munt", "currency", "valuta")
    if d is None or a is None:
        return []
    for r in body:
        if len(r) <= max(d, a):
            continue
        amount = number(r[a])
        if amount is None:
            continue
        if sign is not None and len(r) > sign and r[sign].strip().lower() in ("af", "debit", "d"):
            amount = -abs(amount)
        desc = " ".join(r[i] for i in desc_cols if i < len(r)).strip()
        kind = r[kind_col] if kind_col is not None and kind_col < len(r) else ""
        if amount >= 0 or NOT_SPEND.search(kind) or (not SPEND.search(kind + " " + desc) and kind):
            continue
        cur = r[cur_col].strip() if cur_col is not None and cur_col < len(r) and r[cur_col].strip() else "EUR"
        out.append({"date": day(r[d]), "amount": amount, "currency": cur, "description": re.sub(r"\s+", " ", desc), "country": country_of(desc, cur)})
    return [x for x in out if x["date"]]


def read(paths):
    seen, out = set(), []
    for p in map(Path, paths):
        for f in ([p] if p.is_file() else sorted(p.rglob("*.csv"))):
            for t in read_file(rows_of(f.read_bytes())):
                key = (t["date"], round(t["amount"], 2), t["currency"], t["description"][:40])
                if key not in seen:
                    seen.add(key)
                    out.append(t)
    return sorted(out, key=lambda t: t["date"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="CSV statements, or folders of them")
    data_dir = HERE.parent / "data"
    ap.add_argument("--out", default=str(data_dir / "transactions.json" if data_dir.is_dir() else "transactions.json"))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp")
    args = ap.parse_args(argv)
    found = read(args.paths)
    out = Path(args.out)
    try:  # statements of other accounts or years read before are kept
        old = json.loads(out.read_text())
    except (OSError, ValueError):
        old = []
    keys = {(t["date"], round(t["amount"], 2), t["currency"], t["description"][:40]) for t in found}
    every = sorted([t for t in old if (t["date"], round(t["amount"], 2), t["currency"], t["description"][:40]) not in keys] + found, key=lambda t: t["date"])
    out.write_text(json.dumps(every, ensure_ascii=False))
    abroad = sum(1 for t in found if t.get("country") and t["country"] != "NL")
    print(f"{len(found)} card payments and withdrawals ({abroad} abroad); {len(every)} in {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
