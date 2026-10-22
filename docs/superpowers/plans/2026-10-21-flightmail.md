# flightmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every hour on the Mac mini, read new Gmail messages, find the owner's flight legs, and create, update or delete them in the Google calendar "Travel" and in Contrail, with no LLM or paid API.

**Architecture:** Contrail (Node/Express) moves to mini, listens on 127.0.0.1:3000 and gains PUT/DELETE. A Python package in `mail/` has three modules: `parse.py` (pure: email to legs), `sync.py` (pure decisions against two store interfaces) and `flightmail.py` (I/O: IMAP, EventKit, Contrail HTTP, Discord, state, entry point). launchd runs it hourly through a calsplit-style AppleScript applet that holds the Calendar permission.

**Tech Stack:** Node 22 + Express (existing), Python 3.12 stdlib + pyobjc-framework-EventKit, micromamba env `contrail` on mini, launchd.

**Spec:** `docs/superpowers/specs/2026-10-21-flightmail-design.md`

## Global Constraints

- Contrail is a public repo: never commit names, addresses, IPs, booking codes, real emails, flight data, `config`, `secret` or `data/`. Fixtures are anonymised (fake names, codes, routes, dates).
- Nothing runs on the laptop: the laptop edits, commits and pushes branch `feature/flightmail`. Every test and run happens on mini:
  `ssh mini 'cd ~/repos/contrail && git pull -q && <command>'` (from Task 2 on; before Task 2 the checkout does not exist, so Task 1's tests run in a scratch clone on mini, see Task 1).
- IMAP is read-only: `EXAMINE`, `BODY.PEEK[]`. Never change flags, labels or messages.
- The applet must never exit non-zero: `main()` catches everything, alerts, returns 0.
- Settings in the `"flightmail"` sections of `config` and `secret` (templates `default.config` / `default.secret` committed with empty values):
  - config: `gmail_user`, `passenger_names` (list), `calendar_account` (`"Google"`), `calendar_title` (`"Travel"`), `lookback_days` (`365`), `contrail_url` (`"http://127.0.0.1:3000"`)
  - secret: `gmail_app_password`, `discord_webhook`
- Event format: title `Flight: KL 1234 from MAD to AMS`; event time zone = departure airport zone; location `<airport name>, <city>`; notes lines in order `Confirmation Code: <PNR>`, `Booking: <agency> <number>` (if any), `flightmail <key>`, then change notes; one alarm 15 min before.
- Contrail flight: `date` `YYYY-MM-DD HH:MM:SS` local departure, `from`, `to`, `flight_number` `KL1234`, `airline` from `airlines.dat`, `duration` `HH:MM`; other fields empty.
- State: `~/.flightmail/state.json`; log: `~/.flightmail/run.log`.
- Python tests: plain `test_*` functions with `assert`; each test file ends with a runner that calls every `test_*` function and prints `OK n tests`, so `python mail/test_x.py` works without pytest.

## Review Focus

1. Overnight flights (arrival after local midnight, often shown as `+1`): the arrival date is the next day and the duration is still right. Test in Task 5.
2. Flights across a DST change (Europe switches 25 Oct 2026; a 29 Oct leg is after it): offsets come from `zoneinfo` per date, not a fixed offset. Test in Task 4.
3. The same email read twice, or the same confirmation resent: no duplicate events or flights, and no extra change-note lines. Test in Task 6.
4. A round trip or a connection in one email: every leg becomes its own event and flight, in order. Test in Task 5.
5. Gmail unreachable or app password wrong: one Discord alert, exit 0, `last_uid` not advanced so nothing is skipped. Test in Task 7.

---

### Task 1: Contrail server: listen address, PUT and DELETE

**Files:**
- Modify: `app.js` (config `host`; routes after `app.post('/api/flights', ...)`; `app.listen` at the end)
- Modify: `default.config` (add `"host": "127.0.0.1"`)
- Create: `test/api.test.js`
- Modify: `package.json` (`"test": "node --test test/"`)

**Interfaces:**
- Produces: `PUT /api/flights/:id` (body = fields to merge; `id` cannot change; recompute `distance` when `from`/`to` change and no distance is given; 404 for unknown id; returns the flight) and `DELETE /api/flights/:id` (404 for unknown id; returns `{deleted: id}`). Both call `saveFlights()`. The server listens on `config.host`.

- [ ] **Step 1: Write the failing test** `test/api.test.js` with `node:test`. It copies `app.js`, `default.config` and `public/` into a temp dir, writes `config` there (`port` 0 is not supported by the code, so pick a free port such as 39123, `data_dir` temp, `flights_file` temp file seeded with two flights, `airports_file` a 3-line airports.dat fixture with AMS, MAD, LIS), writes `secret` `{}`, and starts `node app.js` with `NODE_PATH` pointing to the repo's `node_modules`. Tests:
  - `test('PUT merges fields and keeps id')`: PUT id 1 `{flight_number: 'KL1234', to: 'MAD'}` → 200, body id 1, `to` MAD, distance recomputed (> 0); GET shows the change.
  - `test('DELETE removes the flight')`: DELETE id 2 → 200 `{deleted: 2}`; GET has 1 flight; the flights file on disk has 1 flight.
  - `test('unknown id gives 404')`: PUT and DELETE id 999 → 404.
  - `test('listens on 127.0.0.1 only')`: connecting to the machine's LAN address on that port is refused (skip if no non-loopback IPv4 exists).
- [ ] **Step 2: Run it on mini to see it fail.** mini has no contrail checkout yet: `git push -u origin feature/flightmail`, then `ssh mini 'rm -rf /tmp/contrail-t && git clone -q -b feature/flightmail https://github.com/bazilinskyy/contrail /tmp/contrail-t && cd /tmp/contrail-t && export PATH=$HOME/micromamba/envs/crowd/bin:$PATH && npm ci --silent && npm test'`. Expected: FAIL (404 from PUT, connection to LAN address accepted).
- [ ] **Step 3: Implement** the two routes, `config.host` in `app.listen(config.port, config.host, ...)` and its log line, and `host` in `default.config`. README: document `host` under the config parameters.
- [ ] **Step 4: Run the same command.** Expected: all 4 tests PASS.
- [ ] **Step 5: Commit** `git add app.js default.config package.json test/ README.md && git commit -m "contrail: PUT/DELETE flights, listen address from config"` and push.

### Task 2: Contrail runs on mini

No code beyond the plist and README; the deliverable is the running server with the owner's data.

**Files:**
- Create: `mail/contrail.plist.template` (launchd, label `nl.tue.contrail`, `KeepAlive` true, `RunAtLoad` true, `WorkingDirectory` the checkout, `ProgramArguments` the env's `node` + `app.js`, stdout/stderr to `~/.flightmail/contrail.log`)
- Modify: `README.md` (new section "Running on mini": env, launchd, tunnel `ssh -N -L 3000:localhost:3000 mini`, the laptop copy is no longer used)

- [ ] **Step 1: Make the env** on mini: `~/.local/bin/micromamba create -y -n contrail -c conda-forge python=3.12 nodejs=22 pip && ~/micromamba/envs/contrail/bin/pip install -q pyobjc-framework-EventKit`. Check: `~/micromamba/envs/contrail/bin/python -c "import EventKit"` exits 0; `.../bin/node --version` prints v22.
- [ ] **Step 2: Clone and install:** `ssh mini 'git clone -q -b feature/flightmail https://github.com/bazilinskyy/contrail ~/repos/contrail && cd ~/repos/contrail && PATH=$HOME/micromamba/envs/contrail/bin:$PATH npm ci --silent'`.
- [ ] **Step 3: Copy the owner's files once** from the laptop (only scp, nothing runs on the laptop): `scp ~/repos/contrail/{config,secret} mini:repos/contrail/ && ssh mini mkdir -p repos/contrail/data && scp ~/repos/contrail/data/{flights.json,airports.dat} mini:repos/contrail/data/`. On mini set `"host": "127.0.0.1"` and `"port": 3000` in `config` and `chmod 600 config secret`.
- [ ] **Step 4: Install the service:** fill the template into `~/Library/LaunchAgents/nl.tue.contrail.plist`, `launchctl bootstrap gui/$(id -u)` it. Check on mini: `curl -s 127.0.0.1:3000/api/flights | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"` prints the same count as the laptop's `flights.json`; from the laptop `curl -m 5 http://<mini's campus address>:3000/` fails (refused/timeout).
- [ ] **Step 5: Tunnel check:** run `ssh -N -L 3000:localhost:3000 mini` in a terminal tab for the owner; `curl -s localhost:3000/api/flights` on the laptop returns the list. Close the tab.
- [ ] **Step 6: Commit** the template and README; push; `ssh mini 'cd ~/repos/contrail && git pull -q'`.

### Task 3: Anonymised fixtures

Must be done in a session that has the Gmail connector (read only). No raw email is written to disk anywhere.

**Files:**
- Create: `mail/fixtures/*.eml` and `mail/fixtures/README.md` (one line per file: which real layout it copies, what was changed)

- [ ] **Step 1: Find one real example per layout** with the Gmail connector (`search_threads`, then `get_thread` FULL_CONTENT): eDreams NL confirmation, KLM NL booking confirmation, easyJet booking, Gotogate schedule change, Booking.com flights confirmation, a Wizz Air/Gotogate check-in or info mail (ignore case), Booking.com "Check in to your … flight" (ignore case), Google Flights price alert (ignore case), and any real cancellation and rebooking if one exists.
- [ ] **Step 2: Write each as a minimal `.eml`** (headers From, Subject, Date, Content-Type; HTML part, plus the text part when the original has one; JSON-LD kept if present). Replace: every name with `Jan Testers` (or `Anna Testers` for a second passenger), booking codes with `ABC123`/`DEF456`, agency numbers with `11112222333`, phone and email with fake ones, links with `https://example.com/`, and move dates and routes to other real airports and dates (keep the structure, tables and Dutch wording). Keep one overnight leg, one round trip, and one leg on 29 Oct 2026 across the DST change among the fixtures.
- [ ] **Step 3: Synthetic fixtures** for missing cases, named `synthetic_*.eml`: a cancellation (`geannuleerd`, Dutch) and a rebooking (same code, new flight number), and an email for another passenger only (`Anna Testers`).
- [ ] **Step 4: Privacy check:** a grep of `mail/fixtures` for the owner's names, Gmail address, phone number and every real booking code finds nothing. Commit `mail/fixtures` and push.

### Task 4: parse.py: reference data, HTML text, JSON-LD

**Files:**
- Create: `mail/parse.py`, `mail/test_parse.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Airport: name: str; city: str; tz: str`
  - `load_airports(path) -> dict[str, Airport]` (OpenFlights airports.dat, CSV, IATA in column 4, tz database name in column 11; rows without IATA or tz skipped)
  - `load_airlines(path) -> dict[str, str]` (airlines.dat; IATA code → name; active `Y` rows first)
  - `@dataclass(frozen=True) class Leg: flight: str; dep: str; arr: str; dep_local: datetime | None; arr_local: datetime | None; codes: tuple[str, ...]; agency: str = ""` with property `complete -> bool` (all fields set) and method `instants(airports) -> tuple[datetime, datetime]` (aware datetimes via `zoneinfo`). `flight` has no space (`KL1234`); `codes` holds the airline PNR first, then the agency number; `agency` is like `eDreams 11112222333`.
  - `@dataclass class Parsed: kind: str; legs: list[Leg]; passengers: list[str]; looks_like_flight: bool` (`kind` in `"booking" | "change" | "cancel" | "other"`)
  - `html_to_text(html: str) -> str` (html.parser; block tags and `<br>` become newlines, table cells separated by ` | `, whitespace collapsed per line)
  - `jsonld_legs(html: str, airports) -> list[Leg]` (schema.org `FlightReservation`, single object, list or `@graph`; `reservationFor.flightNumber` + `airline.iataCode`, `departureAirport.iataCode`, `departureTime`, `arrivalTime`, `reservationNumber`; times with an offset are converted to the airport's local time)

- [ ] **Step 1: Write failing tests** in `mail/test_parse.py`, using a tiny inline airports.dat string (AMS, MAD, LIS, PDL, FAO, EIN, JFK):
  - `test_load_airports`: `AMS.tz == "Europe/Amsterdam"`, `PDL.tz == "Atlantic/Azores"`.
  - `test_html_to_text_tables`: `<table><tr><td>16:10</td><td>MAD</td></tr></table>` → a line `16:10 | MAD`.
  - `test_jsonld_flight`: an inline JSON-LD `FlightReservation` for `KL1234` MAD→AMS on `2026-11-16T16:10:00+01:00`, arrival `19:15+01:00`, number `ABC123` → one complete Leg with `codes == ("ABC123",)` and `dep_local == datetime(2026,11,16,16,10)`.
  - `test_instants_dst`: a Leg LIS→PDL on 2026-10-29 10:00 → 11:45 local gives UTC 10:00 and 12:45 (Lisbon is UTC+0 and Azores UTC−1 after 25 Oct), and the same leg on 2026-10-21 gives UTC 09:00 and 11:45.
- [ ] **Step 2: Run** `ssh mini 'cd ~/repos/contrail && git pull -q && ~/micromamba/envs/contrail/bin/python mail/test_parse.py'`. Expected: ImportError.
- [ ] **Step 3: Implement** the interfaces above in `mail/parse.py`.
- [ ] **Step 4: Run again.** Expected: `OK 4 tests`.
- [ ] **Step 5: Commit** and push.

### Task 5: parse.py: text rules, kind, passengers

**Files:**
- Modify: `mail/parse.py`, `mail/test_parse.py`

**Interfaces:**
- Consumes: Task 4's `Leg`, `Parsed`, `html_to_text`, `jsonld_legs`, `load_airports`, `load_airlines`.
- Produces:
  - `parse_email(msg: email.message.Message, airports, airlines) -> Parsed` (JSON-LD legs first; text rules only when JSON-LD gives none)
  - `is_passenger(passengers: list[str], names: list[str]) -> bool` (True when `passengers` is empty or any entry matches any name: case-, accent- and order-insensitive, `SURNAME/GIVEN MR|MRS|MS` handled)

Text rules: flight number `\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{1,4})\b` only when the airline code is in `airlines`; airport codes only when in `airports`; dates in English and Dutch (`16 november 2026`, `MAANDAG 16 NOVEMBER 2026`, `29 Oct 2026`, `2026-11-16`; Dutch month names januari … december and abbreviations); times `HH:MM`; a `+1` next to an arrival time, or arrival earlier than departure, means the next day; booking codes after labels `PNR`, `booking reference`, `booking`, `confirmation code`, `boekingscode`, `reserveringsnummer`, `Referentie van luchtvaartmaatschappij`, `airline reference`, and agency numbers after `eDreams-reserveringsnummer`, `Order`, `Reservation Number`. Kind: cancel for `cancelled|canceled|geannuleerd|annulering`; change for `schedule change|has changed|gewijzigd|wijziging|rescheduled|modified the time`; booking for `confirmed|bevestigd|booking reference|e-ticket|itinerary|reisplan`; anything else, and check-in reminders, surveys, price alerts and newsletters, is other. `looks_like_flight` = a valid flight number or a booking-code label appears. Sender-specific helpers are allowed where generic rules fail, one small function per sender.

- [ ] **Step 1: Write failing tests**, one per fixture, asserting the full leg list (flight, dep, arr, dep_local, arr_local, codes), kind and passengers, for example:
  - `test_edreams_nl`: kind `booking`, one leg, codes `("ABC123", "11112222333")`, agency `eDreams 11112222333`.
  - `test_round_trip`: two legs in date order.
  - `test_overnight`: arrival on the next day, duration from `instants()` equals the stated one.
  - `test_gotogate_change`: kind `change`, the new times.
  - `test_synthetic_cancel`: kind `cancel`, legs carry flight and codes (times may be None).
  - `test_ignored`: check-in reminder, price alert and Wizz info mail are kind `other`.
  - `test_other_passenger`: `is_passenger(parsed.passengers, ["Jan Testers"])` is False; `is_passenger([], [...])` is True; `is_passenger(["TESTERS/JAN MR"], ["Jan Testers"])` is True.
- [ ] **Step 2: Run** `.../python mail/test_parse.py` on mini. Expected: failures for the new tests.
- [ ] **Step 3: Implement** `parse_email`, the rules and `is_passenger`.
- [ ] **Step 4: Run again.** Expected: `OK` with all tests.
- [ ] **Step 5: Commit** and push.

### Task 6: sync.py: decisions

**Files:**
- Create: `mail/sync.py`, `mail/test_sync.py`

**Interfaces:**
- Consumes: `Leg`, `Parsed`, `is_passenger`, `Airport` from `parse.py`.
- Produces:
  - Protocol `Calendar`: `has_flight(flight: str, day: date) -> bool`, `create(leg: Leg, notes: list[str]) -> str` (event id), `update(event_id: str, leg: Leg, note: str) -> None` (appends one note line), `delete(event_id: str) -> None`
  - Protocol `Contrail`: `has_flight(flight: str, dep: str, arr: str, day: date) -> bool`, `add(leg: Leg) -> int`, `update(cid: int, leg: Leg) -> None`, `delete(cid: int) -> None`
  - `apply(parsed: Parsed, source: str, state: dict, cal: Calendar, con: Contrail, names: list[str], now: datetime) -> list[str]` returns alert lines (empty when nothing to report); mutates `state["legs"]`: list of `{"codes": [...], "flight", "dep", "arr", "dep_local" (ISO), "arr_local", "event_id" | None, "contrail_id" | None}`. `source` is `"<sender name> <YYYY-MM-DD>"` for notes and alerts.

Rules (from the spec): skip `other`; skip when not `is_passenger`; act only on legs departing after `now`; an owned leg = state entry with the same flight and any shared code. booking/change: owned and unchanged → nothing; owned and changed → update both, note `Updated YYYY-MM-DD: schedule change (<sender>)`; not owned but an owned entry shares a code and route with another flight or date → delete that entry in both places and create the new leg with note `Rebooked from <old flight> on <old date>`; otherwise create in each place that lacks it (`has_flight` false), store ids (None where it existed already); a `change` for a leg that exists only as someone else's event → alert. cancel: owned → delete both and drop the entry; not owned → alert. `looks_like_flight` with kind other than `other` and no complete leg and no owned match → alert `Could not read flight: <sender> | <subject> | <date>` (the caller passes subject and date in `source`).

- [ ] **Step 1: Write failing tests** with in-memory fakes of both protocols:
  - `test_new_booking_creates_both`; `test_existing_event_not_duplicated` (fake calendar `has_flight` True → no create, contrail still added).
  - `test_same_email_twice_is_noop`: apply twice → one event, one flight, no note lines (Review Focus 3).
  - `test_schedule_change_updates_and_notes`; `test_cancel_deletes_both`; `test_rebooking_replaces_with_note`.
  - `test_past_leg_ignored`; `test_other_passenger_ignored`; `test_change_for_unowned_alerts`; `test_unreadable_booking_alerts`.
- [ ] **Step 2: Run** `.../python mail/test_sync.py` on mini. Expected: ImportError.
- [ ] **Step 3: Implement** `apply`.
- [ ] **Step 4: Run again.** Expected: `OK 10 tests`.
- [ ] **Step 5: Commit** and push.

### Task 7: flightmail.py: I/O and entry point

**Files:**
- Create: `mail/flightmail.py`, `mail/test_flightmail.py`
- Modify: `default.config`, `default.secret` (empty `"flightmail"` sections with the keys in Global Constraints)

**Interfaces:**
- Consumes: `parse.parse_email`, `parse.load_airports/load_airlines`, `sync.apply` and the two protocols.
- Produces: `main(argv) -> int` (always 0) with `--dry-run` (parse and log decisions, write nothing, state untouched) and `calendars` (list EventKit calendars); classes `EventKitCalendar(account, title, airports)` and `ContrailHTTP(url, airports, airlines)` implementing the protocols; `fetch_new(cfg, sec, state) -> list[tuple[int, email.message.Message]]`.

Details: IMAP `imap.gmail.com:993`, login with app password, find the folder with the `\All` special-use flag, `EXAMINE`, `UID SEARCH UID <last+1>:*` (or `SINCE <today − lookback_days>` when no state), skip messages from `gmail_user` (sent), fetch `BODY.PEEK[]`. Download `data/airlines.dat` from `https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat` when missing. EventKit: calendar lookup and access request as calsplit does (`requestFullAccessToEventsWithCompletion_`); `has_flight` searches the day for titles containing `KL 1234` or `KL1234`; `create` sets title, start/end from `leg.instants`, `setTimeZone_` departure zone, location, notes, one `EKAlarm.alarmWithRelativeOffset_(-900)`, saves with `EKSpanThisEvent`; ids are `eventIdentifier()`. State saved after each message (atomic write via temp file + rename), so a crash mid-run never re-applies or skips. Alerts: one Discord post per run combining all alert lines (first run: one summary post), and run failures with the traceback tail; message format as vibe-work's `alert.py` (User-Agent header required). Log lines to stdout (the applet appends them to `run.log`).

- [ ] **Step 1: Write failing tests** (no network, no EventKit): `test_failure_alerts_and_keeps_state` (monkeypatch `fetch_new` to raise `imaplib.IMAP4.error`, and `send_discord` to record → `main([])` returns 0, one alert recorded, `state.json` in a temp `FLIGHTMAIL_HOME` unchanged; Review Focus 5); `test_dry_run_writes_nothing` (fake fetch returns the eDreams fixture → stores not called, state unchanged).
- [ ] **Step 2: Run** `.../python mail/test_flightmail.py` on mini. Expected: ImportError.
- [ ] **Step 3: Implement** per the interfaces and details; `FLIGHTMAIL_HOME` env var overrides `~/.flightmail` (tests only).
- [ ] **Step 4: Run all three test files.** Expected: each prints `OK`.
- [ ] **Step 5: Commit** and push.

### Task 8: Install, first run, docs

**Files:**
- Create: `mail/install.sh` (modelled on vibe-work `calsplit/install.sh`: makes `~/.flightmail`, builds `~/.flightmail/flightmail.app` once with `osacompile` running `~/micromamba/envs/contrail/bin/python <checkout>/mail/flightmail.py ${FLIGHTMAIL_ARGS:-}` appended to `~/.flightmail/run.log`, Info.plist `CFBundleIdentifier nl.tue.flightmail`, `LSUIElement`, `NSCalendarsFullAccessUsageDescription`, ad-hoc `codesign`; writes and bootstraps `~/Library/LaunchAgents/nl.tue.flightmail.plist` with `StartInterval` 3600 and the applet's `Contents/MacOS/applet`; also installs `nl.tue.contrail.plist` from Task 2's template if missing)
- Modify: `README.md` (section "flightmail": what it does, config/secret keys, app password, install, Allow, dry run, logs, how to remove)

- [ ] **Step 1: Settings on mini.** Fill mini's `config` `flightmail` section (passenger name, Gmail address) by ssh; copy the Discord webhook on mini from `~/repos/vibe-work/secret` (`alert.discord_webhook`) into contrail's `secret` with a small python one-liner that prints nothing. The owner creates a Gmail app password (myaccount.google.com/apppasswords) and types it into `~/repos/contrail/secret` on mini themselves; it never goes through chat.
- [ ] **Step 2: Install:** `ssh mini 'cd ~/repos/contrail && git pull -q && mail/install.sh'`. Check: `launchctl print gui/$(id -u)/nl.tue.flightmail` shows the job.
- [ ] **Step 3: Allow (owner, via RustDesk, screen unlocked):** `open -W --env FLIGHTMAIL_ARGS=--dry-run ~/.flightmail/flightmail.app; tail ~/.flightmail/run.log`, click Allow. Check: the log lists the future legs found in the last 12 months (a known upcoming booking among them) and no errors.
- [ ] **Step 4: First real run:** `open -W ~/.flightmail/flightmail.app` over ssh. Check: Travel has the new events (via the Google Calendar connector, read only), `curl 127.0.0.1:3000/api/flights` on mini contains them, a second run creates nothing new, and the Discord summary lists only emails it could not read.
- [ ] **Step 5: Commit** install.sh and README; push. Then open a PR from `feature/flightmail` to `main`.
