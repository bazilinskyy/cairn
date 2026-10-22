# flightmail: flights from Gmail into the Travel calendar and Contrail

Date: 2026-10-21. Status: design, not built.

## Intent

The owner gets flight bookings, schedule changes and cancellations in a personal Gmail account, from airlines and
agencies, often in Dutch (eDreams, KLM, easyJet, Gotogate/Wizz Air, Booking.com flights, LOT, ...). Apple's
found-in-mail feature turns only some of them into calendar events and fails on many Dutch emails. flightmail reads
new mail every hour and keeps two places current, with no manual step:

1. the Google calendar "Travel", one event per flight leg, in the right time zones, with the booking code (PNR);
2. Contrail's flight log (`data/flights.json`).

It must use no LLM or paid API (no tokens): rules and the data Contrail already has.

## Goals

- Detect flight legs in new emails in any of the owner's senders' layouts, English and Dutch.
- Create, update and delete Travel events and Contrail flights for those legs.
- Say loudly what it could not read: a missed booking must never be silent.

## Non-goals (v1)

- Hotels, trains, buses, cars.
- PDF attachments (e-tickets, invoices): body text and HTML only.
- Flights of other people (see Passengers).
- Touching events or Contrail flights that flightmail did not create.

## Anti-goals

- Committing anything private. Contrail is a **public** repo: no names, addresses, IPs, booking codes, real
  emails or flight history in the repo. Test emails are anonymised copies with fake names, codes, routes and dates.
- Changing the mailbox in any way (no read flags, labels, moves, deletes). IMAP access is read-only (`EXAMINE`).
- Duplicates: a flight already in Travel or Contrail is never added a second time.

## Constraints

- Runs on the Mac mini only. Nothing of it is installed, run or tested on the laptop; the laptop only edits and
  pushes. Tests also run on mini.
- Config/secret setup as in the rest of the repo: committed `default.config` / `default.secret` templates, gitignored
  `config` / `secret`. flightmail reads a `"flightmail": {...}` section of each.
  - config: Gmail address, `passenger_names` (list), calendar account and calendar title (`Google` / `Travel`),
    run interval, first-run look-back.
  - secret: Gmail app password, Discord webhook for alerts.
- Calendar access on macOS needs a TCC grant, and bare Python under launchd is refused silently. Follow calsplit's
  proven pattern (in the owner's vibe-work repo): an `osacompile` applet with `NSCalendarsFullAccessUsageDescription`,
  ad-hoc signed, allowed once by the owner on mini's unlocked screen (via RustDesk), and never rebuilt afterwards (a new
  signature needs a new Allow). The applet runs the Python script with arguments from an environment variable.
- An applet that exits non-zero shows a blocking dialog and launchd then never starts it again: the script catches
  every error, posts it to Discord and exits 0.
- mini has no Homebrew; use a micromamba env (python 3.12 with pyobjc EventKit, and nodejs for the server).

## Decided

### Contrail moves to mini

- Checkout `~/repos/contrail` on mini; the laptop's `data/flights.json`, `data/airports.dat`, `config` and `secret`
  are copied there once (scp) and mini's copy is the only one used from then on.
- The server runs permanently under launchd (KeepAlive) on a fixed port set in `config` and listens on
  `127.0.0.1` only (owner's choice: the flight history stays private, so no login is needed). The owner opens it from
  the laptop through an ssh tunnel (`ssh -N -L 3000:localhost:3000 mini`, then `http://localhost:3000`; the same port on both ends), so
  manual adding and the TripIt OAuth callback (`localhost:<port>`) keep working. The listen address goes in `config`
  (default `127.0.0.1`); the README documents the tunnel.
- New endpoints `PUT /api/flights/:id` (merge fields) and `DELETE /api/flights/:id`. flightmail writes to Contrail
  only through the API (the server keeps flights in memory and would overwrite direct file edits).

### Where the code lives

- In this repo, folder `mail/`: `flightmail.py` (one script), `test_flightmail.py`, `fixtures/` (anonymised `.eml`
  files), a section in the main README. Python, stdlib only apart from pyobjc: `imaplib`, `email`, `html.parser`,
  `json`, `zoneinfo`, `urllib`.

### Reading mail

- Gmail over IMAP with an app password (the owner creates it), folder All Mail, sent mail excluded. Each run reads
  messages with a UID above the last one seen (kept in the state file). Interval: every 60 minutes (launchd
  `StartInterval`).
- First run: messages of the last 12 months, but only legs that depart in the future are acted on (for both Travel
  and Contrail; Contrail already holds past flights from the openflights.org/TripIt imports).

### Detecting flights

In this order, per email:

1. schema.org `FlightReservation` markup (JSON-LD `<script type="application/ld+json">` and microdata), which many
   airlines and agencies embed.
2. Text rules on the HTML-to-text body: flight numbers (2-character airline code + 1-4 digits, with or without a
   space) whose airline code exists in OpenFlights `airlines.dat`; IATA airport codes that exist in Contrail's
   `airports.dat`; dates and times with English and Dutch month and day names (`7 december 2026`, `MAANDAG`, `vertrek`,
   `aankomst`, ...); booking codes near labels such as PNR, booking reference, confirmation code, boekingscode,
   reserveringsnummer, "Referentie van luchtvaartmaatschappij". A leg is complete with flight number, from, to, departure
   date and time, and arrival time. Sender-specific rules are fine where a generic rule fails.
3. Classify the email: booking/confirmation, schedule change, cancellation, or other (check-in reminder, survey,
   price alert, newsletter, invoice). Only the first three act.

Times in emails are local airport times; convert with the airport's tz database zone from `airports.dat`. Sanity
check: arrival after departure and the stated duration, if any, matching within 10 minutes.

### Passengers

`passenger_names` from config are matched case- and accent-insensitively, in any order and in airline forms such as
`SURNAME/GIVEN MR`. If an email lists passengers and none matches, its legs are skipped (logged, no alert). If it lists
no passengers, the owner is assumed to be one.

### Travel event

- Title `Flight: KL 1234 from MAD to AMS` (format of the owner's existing events).
- Start and end are the correct instants; the event's time zone is the departure airport's zone.
- Location: departure airport name and city from `airports.dat`.
- Description: `Confirmation Code: <PNR>`, then `Booking: <agency> <number>` when an agency number exists, then a
  marker line `flightmail` that identifies events it owns, then one dated line per change.
- One popup alarm 15 minutes before; no other settings changed.

### Contrail flight

`date` = local departure time `YYYY-MM-DD HH:MM:SS`, `from`, `to`, `flight_number` without space (`KL1234`),
`airline` (from `airlines.dat`), `duration` `HH:MM` from the two instants. Distance is filled by the server. Other
fields empty.

### Matching, changes, cancellations

- A leg's identity is PNR + flight number. The state file (`~/.flightmail/state.json` on mini) maps it to the Travel
  event identifier and the Contrail id, plus the last UID read.
- Duplicate check before creating: Travel has an event with the same flight number on the same departure date, or
  Contrail has a flight with the same date, route and flight number. Then nothing is created there; flights that
  flightmail did not create are never changed.
- Schedule change for a known leg: update times (and airports if changed) in both places; add a dated note line to
  the event, e.g. `Updated 2026-05-12: schedule change (Gotogate)`.
- Cancellation: delete the event and the Contrail flight.
- Rebooking (same PNR, same route, new flight number or date): delete the old leg in both places, create the new
  one; its description gets `Rebooked from <old flight> on <date>`.
- A change or cancellation for a leg flightmail does not own: no change, one Discord alert.

### Alerts and log

- Log: `~/.flightmail/run.log` on mini, one line per email acted on and per leg created/updated/deleted.
- Discord (webhook in secret, same channel as the owner's other job alerts): run failures, and every email that
  looks like a flight booking (flight number or booking-code label present) where no complete leg could be read and
  no matching event exists. The alert gives sender, subject and date, never the body.

### Tests

`mail/test_flightmail.py`, plain asserts runnable with `python -m pytest` or `python test_flightmail.py`: one
anonymised fixture per known sender layout (eDreams NL, KLM NL, easyJet, Gotogate schedule change, Booking.com
flights, a cancellation, a check-in reminder that must be ignored), checking the extracted legs, classification,
passenger filter and time-zone conversion. Run on mini.

### Sample emails (designer's call)

The builder reads the owner's real booking emails through the Gmail connector of the Claude session that builds
this (read only) and writes only anonymised fixtures (fake names, codes, routes, dates) into `mail/fixtures/`. No raw
copy is stored anywhere, on the laptop or in the repo. Cases with no real example in the mailbox (for example a
cancellation from a given sender) get a synthetic fixture, marked as such in its file name.

### Duplicate scope (designer's call)

Only the Travel calendar is checked: the owner's existing flight events (Apple's found-in-mail ones included) are
in Travel, and mini shows no Siri Suggestions calendar.

## Left to the builder

- Matching a leg on any of its booking codes (airline PNR or agency number), comparing Contrail dates by day, a
  single summary alert for the first run's backlog, finding All Mail by its special-use flag.
- Exact regexes, parser structure, IMAP search details, state file shape, launchd plist names and ports, the
  micromamba env name, how `airlines.dat` is fetched (once, into `data/`, like `airports.dat`), the README text.
