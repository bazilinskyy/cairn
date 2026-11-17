<h1 align="center"><img src="docs/logo.svg" width="48" alt="" align="top">&nbsp;Cairn</h1>

<p align="center">
  <b>A self-hosted atlas of your life on the move.</b><br>
  Flights, trains, stays, rides, photos, towns, climbs and trips on one map, told day by day, on your own machine.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-22c55e"></a>
  <img alt="Node.js 18+" src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white">
  <img alt="Python 3.9+" src="https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python&logoColor=white">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-your%20data%20stays%20home-0f172a">
  <img alt="One dependency" src="https://img.shields.io/badge/npm%20dependencies-1-38bdf8">
  <img alt="Data in plain JSON" src="https://img.shields.io/badge/data-plain%20JSON-94a3b8">
  <a href="https://github.com/sponsors/bazilinskyy"><img alt="Sponsor on GitHub" src="https://img.shields.io/badge/sponsor-GitHub-ea4aaa?logo=githubsponsors&logoColor=white"></a>
  <a href="https://ko-fi.com/bazilinskyy"><img alt="Support on Ko-fi" src="https://img.shields.io/badge/support-Ko--fi-ff5e5b?logo=kofi&logoColor=white"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#highlights">Highlights</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#using-cairn">Guide</a> ·
  <a href="#tripmail">tripmail</a> ·
  <a href="#api">API</a>
</p>

<p align="center"><img src="docs/map-screenshot-clustered.jpg" alt="Cairn's map: flights, trains, stays, activities, climbs and countries" width="900"></p>

## What is Cairn?

A cairn is a pile of stones that marks where someone has been. **Cairn** does that for your whole travelling life: it gathers what you already have scattered over booking emails, Garmin, Strava, your photo library, Google Maps Timeline, Last.fm and Spotify, Apple Health, Apple Wallet, your GitHub commits, your to-dos and trip docs, and turns it into one map, a page per trip told day by day, a page per town and per famous cycling climb, and statistics you did not know you could have (days by the sea, nights above 2,000 m, the farthest you went each way).

It runs on your own computer (a Mac mini in a cupboard is ideal). Everything is kept in plain JSON files in `data/`; nothing is uploaded anywhere. It began as **Contrail**, a replacement for [openflights.org](https://openflights.org/); flights are now one layer among many.

Two parts:

- **Cairn** (`app.js`, `public/`): a small Node/Express web app (one npm dependency) with the map, trips, towns, climbs, sports, statistics, planning and the flight list.
- **tripmail** (`mail/`): a Python job that reads your booking emails every hour and keeps Cairn, your travel calendar, your to-dos and a Google Doc per trip up to date by itself. Reading email uses no LLM and no paid service.

## Highlights

<table>
<tr><td width="50%" valign="top">🗺️ <b>One map of everything</b><br>Flights on great circles, trains and buses along real tracks, car journeys along the likeliest roads, stays, rental cars, photos (clusters or a heatmap), Timeline, activities and explored tiles, climbs, World Heritage sites and national parks, towns and countries (ISO, sovereign, or the Travelers' Century Club). In 2D, or 3D on a globe with real terrain.</td><td width="50%" valign="top">🧳 <b>Trips, found by themselves</b><br>Runs of days away, from all your data. A page per trip with its map (photo-to-photo moves along the roads, drives while you had a car) and a day-by-day story: flights, trains, rides with their weather, photos, where and how you slept, the song of the day.</td></tr>
<tr><td width="50%" valign="top">🏙️ <b>Towns</b><br>Every town you have been to, with a page: its map, each visit, the stays, flights, activities, photos, the music you played and the code you wrote there.</td><td width="50%" valign="top">⛰️ <b>Climbs</b><br>1,091 famous cycling climbs: which you rode and which way up, your times against your FTP of that day and the record, a coloured profile, the weather and the photos you took on the way up.</td></tr>
<tr><td width="50%" valign="top">🚴 <b>Sports and body</b><br>Garmin or Strava: Eddington numbers, records, best efforts, explored tiles; sleep and resting heart rate per day; the weather on every ride.</td><td width="50%" valign="top">📊 <b>Stats and curiosities</b><br>Per country and per year (a year in review), days by the sea and in the mountains, extremes, capitals, how far by each means, days per country and Schengen's 90 in 180, spending on stays, where you wrote code (even in the air). All of it, trip by trip, as a PDF to keep or print.</td></tr>
<tr><td width="50%" valign="top">📅 <b>Planning</b><br>Coming trips: what is booked, what is missing (a check-in, a bed, the way there), the forecast, climbs and saved places nearby; a morning alert. A wish list of places, climbs and countries.</td><td width="50%" valign="top">🧹 <b>Your data, kept right</b><br>Add what nothing knows (even with only the year), suggestions from photos, albums and to-dos, one-click fixes for duplicates and gaps, backups in one file.</td></tr>
</table>

<details open>
<summary><b>Screenshots</b></summary>

<table>
<tr><td width="50%" valign="top"><img src="docs/map-randstad.jpg" alt="The map up close: the Randstad and Eindhoven, photos off" width="100%"><br><sub>Up close: the Randstad and Eindhoven, photos off</sub></td><td width="50%" valign="top"><img src="docs/map-screenshot.jpg" alt="The map in light mode" width="100%"><br><sub>The map in light mode</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/map-photos-heatmap.jpg" alt="Photos as a heatmap" width="100%"><br><sub>Photos as a heatmap</sub></td><td width="50%" valign="top"><img src="docs/map-grey-bold.jpg" alt="A grey map with bold lines, countries counted as the Travelers' Century Club does" width="100%"><br><sub>Grey, bold lines; countries the Travelers' Century Club way</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/globe-3d.jpg" alt="3D: the globe with real terrain and every layer" width="100%"><br><sub>3D: the globe with real terrain</sub></td><td width="50%" valign="top"><img src="docs/flat-arcs-3d.jpg" alt="3D: a flat, tilted map with flights along their rough path through the air" width="100%"><br><sub>3D: tilted, flights through the air</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/stats.jpg" alt="The Stats tab: flights, airports, countries, airlines, flights per year" width="100%"><br><sub>Stats: flights, airports, countries, per year</sub></td><td width="50%" valign="top"><img src="docs/sports.jpg" alt="The Sports tab: activities, Eddington numbers, records, explored tiles" width="100%"><br><sub>Sports</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/flights.jpg" alt="The Flights tab: every flight, searchable and sortable" width="100%"><br><sub>Flights: every flight, searchable</sub></td><td width="50%" valign="top"><img src="docs/airport.jpg" alt="An airport's page: its routes, airlines and flights" width="100%"><br><sub>An airport's page</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/trips.jpg" alt="The Trips tab: every trip found in all the data, as cards with a cover photo and a sketch of the route" width="100%"><br><sub>Trips: every trip found in all the data, as cards or a table</sub></td><td width="50%" valign="top"><img src="docs/trip.jpg" alt="A trip's page: its cover, its map with the drives along the roads, and its numbers" width="100%"><br><sub>A trip's page</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/trip-story.jpg" alt="A trip day by day: rides with their weather, trains, where you slept, sleep and heart rate" width="100%"><br><sub>A trip day by day</sub></td><td width="50%" valign="top"><img src="docs/year.jpg" alt="A year in review" width="100%"><br><sub>A year in review</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/city.jpg" alt="A town's page with its own map and photos" width="100%"><br><sub>A town's page</sub></td><td width="50%" valign="top"><img src="docs/country.jpg" alt="A country's page: its flag, its map with everything there, its towns" width="100%"><br><sub>A country's page</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/climb.jpg" alt="A climb's page: the ways up, your ride up coloured by gradient, your times against your FTP, a top climber and the record" width="100%"><br><sub>A climb's page: its ways up, your times, the record</sub></td><td width="50%" valign="top"><img src="docs/map-stays.jpg" alt="Where you slept: the stays alone, by kind of bed (hotels, hostels, Airbnb, friends' places, Couchsurfing, camping)" width="100%"><br><sub>Where you slept, by kind of bed</sub></td></tr>
<tr><td width="50%" valign="top"><img src="docs/spending.jpg" alt="What you spent: on stays, and by card and cash, per year, country, town and trip" width="100%"><br><sub>What you spent: stays, card and cash</sub></td><td width="50%" valign="top"><img src="docs/place-photos.jpg" alt="Placing photos that have no place: by day, in a town or on the map, or by Cairn itself" width="100%"><br><sub>Placing photos that have no place</sub><br><br><img src="docs/airline.jpg" alt="An airline's page: its logo and codes, a map of its routes, your flights, distance and hours in the air with it" width="100%"><br><sub>An airline's page</sub><br><br><img src="docs/activity.jpg" alt="An activity's page: its route on the map, with its numbers, profile, climbs, photos and music below" width="100%"><br><sub>An activity's page</sub></td></tr>
</table>

<p align="center"><img src="docs/replay.jpg" alt="A trip's replay: the trip drawn on the map day by day, a photo where it was taken" width="900"><br><sub>A trip's replay, to watch or save as a video</sub></p>

<p align="center"><img src="docs/years.jpg" alt="The years side by side" width="900"><br><sub>The years side by side</sub></p>

<p align="center"><img src="docs/curiosities.jpg" alt="Curiosities: days by the sea and above 1,000 m, the extremes, capitals, how far by each means" width="900"><br><sub>Curiosities</sub></p>

<p align="center"><img src="docs/report.jpg" alt="The report as a PDF: its cover with every town on a world map, what it all adds up to, and a trip with its map, travel, beds and photos" width="900"><br><sub>The report as a PDF: the cover, all of it at a glance, a trip</sub></p>

<p align="center"><img src="docs/settings-imports.jpg" alt="Settings: imports from each service's data download, and the report" width="440"><br><sub>Settings: imports and the report</sub></p>

<sub>Made from real data with the dates shifted, flight numbers, hotels and prices changed.</sub>

</details>

## Quick start

```bash
git clone https://github.com/bazilinskyy/cairn.git && cd cairn
npm install
cp default.config config && cp default.secret secret
node app.js
```

Open [http://localhost:3000](http://localhost:3000) and add a flight, or import your history: an [openflights.org CSV](#importing-from-openflightsorg), your [Garmin export](#sports-activities), your [photos](#the-map) or [Timeline](#the-map). For everything to keep itself up to date, run it on an always-on Mac with [tripmail](#tripmail) (see [Running on an always-on Mac](#running-on-an-always-on-mac)).

## How it works

### Where the data comes from, and where it goes

Everything Cairn knows arrives as a file in `data/`, written by an importer or by the server itself, and every page is built from those files. Arrows out of Cairn are the only things that leave your machine: lookups to open services (below) and what tripmail writes to your own calendar, to-dos and Drive.

```mermaid
flowchart LR
  subgraph sources["Your sources"]
    gmail["Gmail<br>booking emails"]
    exports["Booking.com, Airbnb<br>exports, trip docs"]
    you["You: + Add,<br>openflights CSV, TripIt"]
    garmin["Garmin Connect<br>and its export"]
    strava["Strava"]
    photos["Apple Photos,<br>Google Takeout"]
    timeline["Google Maps<br>Timeline"]
    lastfm["Last.fm"]
    things["Things to-dos"]
    downloads["Data downloads: Spotify,<br>Apple Health, bank, check-ins,<br>calendars, OV-chipkaart, Goodreads"]
    wallet["Apple Wallet"]
    github["GitHub commits"]
  end

  subgraph importers["Importers"]
    fm["tripmail<br>(hourly)"]
    once["one-off imports<br>and the Add tab"]
    gpy["imports/garmin.py<br>(nightly 02:30)"]
    srv["Cairn's own fetchers<br>(Strava, Last.fm, weather)"]
    ppy["imports/photos.py,<br>timeline.py, saved_places.py"]
    ipy["Settings → Imports<br>(imports/*.py)"]
  end

  subgraph data["data/ (plain JSON)"]
    trav["flights, ground,<br>stays"]
    acts["garmin, strava, tracks,<br>wellness, weather"]
    pics["photo_points, timeline,<br>saved_places"]
    more["lastfm, climb_ascents,<br>drives"]
    life["payments, check-ins,<br>books, music, code, health"]
  end

  subgraph cairn["Cairn server"]
    places["Every place<br>on every day"]
    build["Towns, countries, trips,<br>climbs, curiosities"]
  end

  subgraph pages["What you see"]
    map["Map and 3D"]
    tp["Trips, towns,<br>climbs"]
    st["Sports, stats,<br>year in review"]
    plan["Coming trips,<br>wish list, Fix"]
  end

  gmail --> fm --> trav
  exports --> once --> trav
  you --> once
  garmin --> gpy --> acts
  strava --> srv --> acts
  lastfm --> srv --> more
  photos --> ppy --> pics
  timeline --> ppy
  downloads --> ipy --> life
  wallet --> ipy
  github --> once
  things -. read-only .-> build
  trav & acts & pics & more & life --> places --> build
  build --> map & tp & st & plan
  fm -. writes .-> out["Calendar events, check-in to-dos,<br>trip docs, Discord alerts"]
```

### How towns, countries and trips are built up

Cairn never asks where you were: it works it out. Every source is reduced to **a place on a day**; towns, countries and trips are built from those.

```mermaid
flowchart TB
  f["✈️ Flights<br>both airports, not where<br>you only changed planes"] --> pd
  g["🚆 Trains, buses, ferries<br>both stations"] --> pd
  s["🏨 Stays and rental cars<br>every night of the stay"] --> pd
  a["🚴 Activities<br>where each started"] --> pd
  p["📷 Photos<br>where and when each was taken"] --> pd
  t["🧭 Timeline<br>each visit, every day of it"] --> pd
  pd(("A place<br>on a day")) --> town["🏙️ Its town<br>GeoNames towns over 1,000 people:<br>the one that pulls hardest,<br>population over distance², within 25 km,<br>in the nearest town's country"]
  town --> cities["Cities<br>days there, separate visits,<br>first and last day"]
  town --> countries["🌍 Countries<br>the town's state or province (Natural Earth)<br>in the list you chose: ISO, sovereign, TCC"]
  pd --> away{"A day away?<br>outside your home countries,<br>or a night in a stay"}
  away -->|"days in a row"| run["A run of days away"]
  run -->|"a night in a stay, a flight or a train,<br>or three days or more"| trip["🧳 A trip<br>named after its countries"]
  trip --> story["Day by day, in time order:<br>flights, trains, activities (with the weather),<br>photos, where you slept, sleep, music"]
  trip --> moves["Moves between photos, activities and stays<br>with nothing of yours connecting them:<br>10 km or more along the roads (OSRM),<br>a drive while you had a car"]
  pd --> curio["📊 Curiosities<br>by the sea (Natural Earth coast),<br>heights (AWS Terrain Tiles),<br>extremes, capitals, distances"]
```

Not every place counts for its day. Check-ins posted in one go (three or more within an hour, over 300 km apart: a list of the places you had been, added later) and photos that cannot have been where they are at their time (over 100 km from the photo just before or after, faster than a plane: scans and old photos placed by hand, which keep the day they were scanned) are on the map but give no place for their day.

The same days feed **where you were on any day** (your stay that night, else the end of that day's last flight or ride, else Timeline or photos), the **suggestions** (photos that jump between towns with nothing connecting them, albums whose names give a place and year, "trip to …" to-dos with no trace) and **coming trips** (each night needs a bed, each journey a check-in).

### Tracks and places: how a line on the map is found

```mermaid
flowchart LR
  name["'Zurich central station<br>(Sihlquai car park)'"] --> geo["Photon (OpenStreetMap)<br>the town first, then its station;<br>biased to where you just were"]
  geo --> tt{"Transitous<br>timetables"}
  tt -->|found| track["The timetable's track"]
  tt -->|"not found: retry<br>from the nearest stations"| rail{"Train?"}
  rail -->|yes| br["BRouter rail profile<br>(long ones in pieces)"]
  rail -->|bus| osrm["OSRM road route"]
  br & osrm --> track2["A best guess, said so"]
  br -->|"no railway"| straight["A straight line, dashed"]
```

A **🚡 cable car** needs no lookup: it is a straight line between its two stations. A timetable's track can have straight pieces where its shape only joins the stops: a train's piece over 20 km is put on the railway between its two ends (a long night train's missing stretch, a line the railway map lacks), a bus's or a lift's over 15 km on the roads (a coach whose timetable only joins its stops), when that way is not more than two and a half times the straight piece. Trips drawn before this are done once more in the background.

A railway guess may be at most about twice the straight distance, or as far as the train could go in its own hours (from its departure and arrival times) when that is more: a line round the mountains between two valleys.

### The open services it uses

No account is needed for any of these; each is asked at most about once a second and the answer is kept.

| What | Service | For |
|---|---|---|
| Places | [Photon](https://photon.komoot.io) (OpenStreetMap) | stations, ports, towns of trips and stays |
| Timetabled tracks | [Transitous](https://transitous.org) | trains and coaches |
| Rails and roads | [BRouter](https://brouter.de), [OSRM](https://project-osrm.org), [FOSSGIS routing](https://routing.openstreetmap.de) | best-guess train lines, bus routes, drives; bike routes to climbs |
| Terrain | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | climbs' ways up, heights, 3D |
| Weather | [Open-Meteo](https://open-meteo.com) | the weather on your rides, forecasts for coming trips |
| Money | [Frankfurter](https://frankfurter.dev) (ECB), [currency-api](https://github.com/fawazahmed0/exchange-api) | stays' prices in euros |
| Maps and borders | [OpenStreetMap](https://www.openstreetmap.org), [Natural Earth](https://www.naturalearthdata.com), [GeoNames](https://www.geonames.org) | base map, countries and coasts, towns |
| Airports | [OpenFlights](https://github.com/jpatokal/openflights) | airports and airlines |
| Climbs | Wikipedia, [Wikidata](https://www.wikidata.org) | the 1,091 climbs and their summits |
| World Heritage, national parks | [Wikidata](https://www.wikidata.org) | the 1,257 World Heritage sites and 3,416 national parks, in `unesco.json` and `parks.json` (`node sites.js build` makes them again) |
| Optional, with a key | [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox), [Last.fm](https://www.last.fm/api), Strava | flight lookup, music, activities |

### What runs when

| When | What |
|---|---|
| Every hour | tripmail reads new booking emails; Cairn looks up places and tracks of new trips |
| 02:30 | Garmin: new activities, timed tracks, FTP and weight, sleep and resting heart rate |
| 03:30 | The photo index from Photos (where and when, the albums, the photos with no place) and the calendars' events (`imports/nightly.sh`, LaunchAgent `nl.tue.cairn-nightly`) |
| 2nd of the month, 04:20 | Google's landmark detection for photos with no place, 950 at most (`nl.tue.cairn-landmarks`) |
| 07:30 | Coming trips: what is missing and not a to-do yet goes to the alerts channel |
| Every 6 hours | New Last.fm scrobbles; weather for rides now in Open-Meteo's history |
| In the background | Climbs' ways up, trips' road routes, heights, album places, euro rates: each once |

## Contents

- [Quick start](#quick-start) · [How it works](#how-it-works)
- [Project layout](#repository-layout)
- [Setup](#setup) · [Running Cairn](#running-cairn) · [Running on an always-on Mac](#running-on-an-always-on-mac)
- [tripmail](#tripmail)
- [Using Cairn](#using-cairn): [the map](#the-map), [sports](#sports-activities), [coming trips](#coming-trips), [on this day](#on-this-day), [how it looks](#how-it-looks), [replay and export](#replay-and-export), [days per country](#days-per-country-and-schengen), [where you write code](#where-you-write-code), [data downloads](#more-of-your-life-data-downloads), [spending](#spending), [year in review](#year-in-review), [report (PDF)](#report-pdf), [wish list](#wish-list), [fix](#fix), [adding](#adding-by-hand-and-from-your-photos), [backup](#backup)
- [Data](#data) · [API](#api) · [Tests](#tests) · [Privacy](#privacy) · [Troubleshooting](#troubleshooting)
- [Support Cairn](#support-cairn) · [Acknowledgements](#acknowledgements) · [License](#license)

## Repository layout

| Path | What it is |
|---|---|
| `app.js` | Cairn server (Express): REST API, AeroDataBox lookup, imports |
| `ground.js` | places and tracks of trains, buses and ferries (Photon, Transitous, OSRM) |
| `activities.js` | all sports activities from every source (Garmin, Strava), each once |
| `strava.js` | Strava sign-in, the activity list and each activity's explored tiles (Strava's API needs a paid subscription) |
| `cities.js` | most visited cities: places and days put in their towns (GeoNames) |
| `regions.js`, `country-lists.json` | countries as a list counts them: ISO codes, sovereign countries or the Travelers' Century Club's 330 (Natural Earth states and provinces) |
| `public/index.html` | Cairn web page (map, stats, list) |
| `public/sports.js` | the Sports tab: cards, charts and tables of your Strava activities |
| `public/city.js` | a town's report page, opened from a city on the map, with its map |
| `trips.js`, `public/trips.js` | trips found in all the data, their moves along the roads (OSRM), the Trips tab and a page per trip |
| `tripexport.js`, `public/replay.js` | a trip as KML, GPX or a page to share; its replay on a map, to watch or save as a video |
| `onthisday.js` | where you were on today's date in the years before, for the Trips tab and the morning message |
| `photos.js` | every photo's place and time (`data/photo_points.json`), its thumbnail and the whole photo |
| `prep.js` | the coming trips: what is booked and missing, and the morning alert |
| `spending.js` | what the stays cost, in euros |
| `review.js`, `public/review.js` | a year in review |
| `public/wish.js`, `imports/saved_places.py` | the wish list, and Google Maps' saved places |
| `public/airline.js` | an airline's page: its logo, codes, routes and your flights with it |
| `public/placephotos.js`, `imports/photos_place.py` | placing photos with no place by hand, and writing those places into the Photos library |
| `imports/photos_dedupe.py` | photos in the Photos library more than once (the same file imported twice) down to one |
| `imports/photos_recognise.py`, `imports/photos_landmarks.py` | places for photos with no place from what they show: the towns of a known trip (CLIP, on this machine), and landmarks anywhere (Google Cloud Vision, within its free 1,000 a month) |
| `imports/checkins.py`, `calendar_events.py`, `bank.py`, `ovchipkaart.py`, `spotify.py`, `health.py` | data downloads: check-ins, posts and rides; calendars; bank payments; OV-chipkaart journeys; Spotify's streaming history; Apple Health's workouts and steps |
| `things.js`, `todotrips.js` | your Things to-dos (read-only), and the trips they mention that nothing else knows |
| `activitypage.js`, `public/activity.js` | an activity's page: its route, numbers, profile, climbs, photos and music |
| `code.js`, `imports/github.py` | your GitHub commits, in the towns and countries you wrote them in |
| `wallet.js` | your Apple Wallet's passes (read-only): boarding passes, train and bus tickets, tickets to events |
| `backup.js` | a backup of all imported and added data, and restoring one |
| `albums.js` | trips the names of your Google Photos albums give, for albums without places |
| `suggestions.js`, `public/add.js` | the Add tab beyond flights: trains, buses, ferries and stays by hand, and the legs your photos suggest |
| `stats.js`, `public/curiosities.js` | the curiosities: days by the sea and up in the mountains, extremes, capitals, distances, beds, ride weather, sleep, time zones and jet lag |
| `weather.js` | the weather on your rides (Open-Meteo's history) |
| `lastfm.js` | your Last.fm scrobbles (and Spotify's plays on the days Last.fm has none), for the music on trips and towns |
| `books.js` | your Goodreads library export or data download, for the books on the map, trips and towns |
| `uploads.js` | the imports in Settings: a data download's files uploaded, then read by its import script |
| `report.js` | the report of everything to print or keep as a PDF: the page, its trip sketches and the PDF made by Chrome |
| `public/climb.js`, `climb_records.json` | a climb's page: its map, your times with a profile, predictions, and the best known times (with sources) |
| `public/terrain.js` | the 3D view: globe or flat map with terrain (MapLibre GL), the 2D map's layers, flights through the air (deck.gl) |
| `climbs.js`, `ascents.js`, `climbs.json`, `climbs_extra.json` | famous cycling climbs, their ways up (roads and terrain heights) and which your rides went up |
| `sites.js`, `unesco.json`, `parks.json` | UNESCO World Heritage sites and national parks (from Wikidata) and the days you were at each |
| `public/layers.js` | the map's stays, rental cars, photos, Timeline, Strava activities and tiles, countries, trips, period and "where on" |
| `imports/photos.py`, `imports/timeline.py` | photo places and Google Timeline into Cairn (see [The map](#the-map)) |
| `imports/garmin.py`, `imports/install_garmin.sh` | Garmin activities into Cairn: the data export, the sign-in and the nightly sync (see [Sports activities](#sports-activities)) |
| `imports/test_imports.py`, `imports/fixtures/` | tests of the import scripts, and a made-up Garmin activity file |
| `default.config`, `default.secret` | committed templates for `config` and `secret` (see [Setup](#setup)) |
| `test/*.test.js` | tests of the Cairn API, `ground.js`, `strava.js`, `cities.js` and the Sports tab's numbers |
| `mail/tripmail.py` | tripmail entry point: Gmail, calendar, Cairn and Discord |
| `mail/parse.py` | reads flight legs out of an email (no network) |
| `mail/ground.py` | trains, buses and ferries: operator rules and station time zones (no network) |
| `mail/sync.py` | decides what an email changes; AeroDataBox enrichment (no network) |
| `mail/plan.py` | check-in to-dos, busy blocks and trip banners from the flights you are on (no network) |
| `mail/stays.py` | hotel, Airbnb and rental car bookings out of an email (no network) |
| `mail/tripdocs.py` | trip docs in Google Drive: Google client, the docs' tables, what goes where, the suggestions by Claude; `auth` signs in once |
| `mail/test_*.py`, `mail/fixtures/` | tripmail tests and anonymised test emails |
| `mail/install.sh`, `mail/cairn.plist.template` | install tripmail and the Cairn service on a Mac (launchd) |
| `docs/superpowers/` | design and implementation plan of tripmail (then called flightmail) |

## Setup

Requirements: Node.js 18+ for Cairn; for tripmail also Python 3.10+ on macOS with `pyobjc-framework-EventKit`.

### 1. Install dependencies

In the folder you cloned:

```
npm install
```

This installs Express, the only dependency.

### 2. Configure

Settings live in `config` and keys in `secret`. Both are JSON files, both are gitignored, and the server does not start without them. Copy the templates:

```
cp default.config config
cp default.secret secret
```

`config`:

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | address the server listens on: `127.0.0.1` is this machine only, `0.0.0.0` opens it to the network |
| `hosts` | none | more names Cairn answers to besides `localhost`, `127.0.0.1` and `[::1]` (a reverse proxy's, for example); any other name is refused, so a website whose name points at this machine cannot read your data through your browser |
| `port` | `3000` | port the server listens on |
| `data_dir` | `data` | folder for runtime data (gitignored) |
| `flights_file` | `data/flights.json` | the flight list |
| `airports_file` | `data/airports.dat` | OpenFlights airport database, downloaded on first run |
| `csv_backup` | `""` | openflights.org CSV export to import on first run (see [Importing](#importing-from-openflightsorg)) |
| `backup_copy_dir`, `backup_copy_days` | `""`, `14` | a folder (a synced one: OneDrive, iCloud Drive, Dropbox) Cairn writes its backup to every `backup_copy_days` days, the full one as **Download backup** makes it; only the newest stays there (see [Backup](#backup)) |
| `ground_file`, `stays_file`, `photos_file`, `timeline_file`, `strava_file`, `strava_token_file` | `data/…` | where the map's other data is kept (see [Data](#data)) |
| `wallet_dir` | `"auto"` | `"auto"` to read this Mac's Apple Wallet (read-only; iCloud keeps the passes in `~/Library/Passes/Cards`); a folder of passes; `""` for none |
| `things_db` | `""` | `"auto"` to read your Things 3 to-dos on this Mac (read-only), for the coming trips' checks and the trips your to-dos mention; or the path of its `main.sqlite` |
| `takeout_photos_dir` | `""` | your Google Takeout's Google Photos folder, for the album suggestions when there is no `data/photo_albums.json` (the Photos library's albums, from `imports/photos.py --albums`; see [Adding by hand, and from your photos](#adding-by-hand-and-from-your-photos)) |
| `chrome` | found | the Chrome or Chromium that prints the report as a PDF (see [Report (PDF)](#report-pdf)) |
| `ground_lookups` | `true` | look up places and tracks of trains, buses, ferries and stays (see [Ground trips](#ground-trips)) |
| `tripmail` | | tripmail settings (see [tripmail settings](#settings)) |

`secret`:

| Key | Meaning |
|---|---|
| `rapidapi_key` | RapidAPI key for AeroDataBox flight lookup (optional, see below) |
| `tripit_client_key`, `tripit_client_secret` | TripIt OAuth app (optional) |
| `strava_client_id`, `strava_client_secret` | Strava API app, for your activities on the map (optional, see [The map](#the-map)) |
| `lastfm_api_key`, `lastfm_user` | a Last.fm API key and your user name, for the music on trips and towns (optional, see [Music](#music)) |
| `tripmail` | tripmail's Gmail app password and Discord webhook (see [tripmail settings](#settings)) |

### 3. AeroDataBox key (optional, recommended)

Flight lookup by number and date uses the [AeroDataBox API](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) via RapidAPI. The free tier allows about 500 lookups per month, which is plenty for personal use.

1. Sign up at [rapidapi.com](https://rapidapi.com)
2. Subscribe to the AeroDataBox API (free tier)
3. Copy your `X-RapidAPI-Key` into `secret` as `rapidapi_key`

Without a key you can still add flights by hand, and tripmail falls back to what the email says.

## Running Cairn

```
node app.js
```

Then open [http://localhost:3000](http://localhost:3000).

On first run the app creates `data/`, downloads `airports.dat` from the [OpenFlights dataset](https://github.com/jpatokal/openflights) (about 6 MB, about 7,700 airports) and, if `csv_backup` is set, imports that CSV into `data/flights.json`. Later starts load `data/flights.json` directly.

## Running on an always-on Mac

Cairn and tripmail can run permanently on another Mac, here a Mac mini reached as `ssh mini`. Cairn listens only on that machine (`"host": "127.0.0.1"`), so nobody else on the network can see or change your flights and no login is needed. Nor can a website you visit: Cairn refuses what another site's page sends from your browser (it may only link to Cairn) and does not let itself be shown inside another site. That Mac's `data/flights.json` becomes the only copy in use.

1. Make an environment with Node, Python and EventKit, for example with micromamba:
   ```
   micromamba create -n contrail -c conda-forge python=3.12 nodejs=22 pip
   ~/micromamba/envs/contrail/bin/pip install pyobjc-framework-EventKit
   ```
2. Clone the repo, run `npm ci`, and copy `config`, `secret` and `data/` from the machine you used before (`chmod 600 config secret`).
3. Run `mail/install.sh`. It installs the Cairn server as the launchd service `nl.tue.cairn`, which restarts on crash and at login (log: `~/.tripmail/cairn.log`), and on its own when one of Cairn's `.js` files changes (10 s after the last change, and only when the changed files parse; `CAIRN_NO_RESTART=1` turns this off), and it installs tripmail (see [Install](#install)). `PYTHON` and `NODE` override the interpreters it uses.

Open Cairn from your laptop through an ssh tunnel. Use the same port on both ends so the TripIt sign-in callback keeps working:

```
ssh -N -L 3000:localhost:3000 mini
```

then browse to [http://localhost:3000](http://localhost:3000). Stop the tunnel with Ctrl-C.

## tripmail

tripmail reads your booking emails (flights, trains, buses, ferries, stays and rental cars) and keeps Cairn, your travel calendar, your to-dos and a Google Doc per trip up to date. It was called flightmail until October 2026, when it had long been reading more than flights.

In short:

- Reads new Gmail messages every hour, **read only**
- Finds the flights in booking emails from airlines and agencies, in English and Dutch (KLM, Ryanair, easyJet, eDreams, Gotogate, Booking.com, Air France-KLM and similar layouts)
- Creates one **calendar event per flight**, for example `✈️ KL1234: Amsterdam - Lisbon`. Events start and end at the right moment in each airport's time zone, with the booking code (PNR) in the notes.
- Adds the same flight to **Cairn**
- Also adds **trains, buses and ferries** to the calendar, for example `🚆 EC9236: Breda - Bruxelles Midi` or `🚌 Lisboa (Oriente) - Porto (Campanhã)`, and to Cairn's map
- Follows **schedule changes, rebookings and cancellations**
- Reads **hotel, hostel, Airbnb and rental car** bookings (Booking.com, Airbnb, Hostelworld, Trip.com, Hotels.com, Expedia, DiscoverCars, VIPCars, Localrent, Rentalcars.com, Holiday Autos, Hertz and other brokers) for the trip docs and Cairn's map
- Keeps **one Google Doc per trip** in a Drive folder: the Plan table gets each stay, the Transport table each flight, train, bus, ferry and rental car, without changing what you wrote (see [Trip docs](#trip-docs))
- **Suggests things to do and an itinerary** in the doc of each coming trip, by Claude, written again whenever the doc changes
- For every flight: a **check-in to-do in Things**, scheduled the day before, with the airline's check-in link; a **busy block in your work calendar** from 2 hours before departure to 1 hour after landing; and an all-day **trip banner** ("Tenerife", "Portugal") over each trip
- **Never duplicates** a flight that is already in the calendar or in Cairn, and never touches events it did not create
- Posts what it **could not read** to Discord, so a missed booking is not silent

### What it does

Every hour tripmail reads the Gmail messages that arrived since its last run. For each email:

| Email | What happens |
|---|---|
| **New booking** | One calendar event per flight leg and the same flight in Cairn. Only flights where you are a passenger (`passenger_names`); an email that lists no passengers counts as yours. Only flights that are still ahead. |
| **Schedule change** | The event and the Cairn flight get the new times; the event gets a dated note such as `Updated 2026-10-21: schedule change (Gotogate)`. |
| **Rebooking** | The old flight is deleted from both places and the new one created with a `Rebooked from KL1234 on 2026-11-16` note. |
| **Cancellation** | The event and the Cairn flight are deleted. |
| **Train, bus or ferry ticket** | One calendar event per journey and the same trip in Cairn, for the map. Cancellations delete both, also when the email gives only the booking number. |
| **Hotel, Airbnb or rental car** | Booking.com, Airbnb, Hostelworld, Trip.com and Hotels.com stays, Expedia, DiscoverCars, VIPCars and Localrent rental cars, and those of other car rental brokers and companies (Rentalcars.com, Holiday Autos, Argus Car Hire, eDreams Cars, Stressfree Car Rental, BSP Auto, EconomyBookings, QEEQ, Hertz, Thrifty, Goldcar), go into the trip docs (below) and to Cairn's map, not the calendar. Their cancellations undo that. |
| **Anything else** | Ignored: check-in reminders, boarding passes, price alerts, surveys, newsletters, "choose an option" emails, replies and forwards. |

Each event:
- **Title:** `✈️ <flight>: <departure city> - <arrival city>` for flights; `🚆` trains, `🚌` buses and `⛴️` ferries use the station names and, for trains, the train number: `🚆 EC9236: Breda - Bruxelles Midi`
- **Times:** start and end at the real departure and arrival moments; the event's time zone is the departure airport's
- **Location:** the departure airport or station
- **Notes:** `Confirmation Code: <PNR>`, the agency's number if any, and a `tripmail` marker line
- **Booking codes in the notes, also later:** every booking code tripmail knows for a flight, train, bus or ferry goes into its event's notes: `Confirmation Code: <PNR>`, `Booking: eDreams <number>` and a `Booking code: ...` line for the rest (Travelfrom's own code, Vliegwinkel's `VW-` number). Codes that come later (an e-ticket after the payment email) and codes missing from events tripmail did not make (Google's, your own; found by flight number around that day) are added each run, below the lines that already give codes or on top. Nothing else in the notes changes.
- **Alert:** one reminder 15 minutes before
- When an email gives no arrival time (SNCF Connect), the event lasts one hour and its notes say the end time is a guess.

A Cairn flight gets the date, route, flight number, airline and duration; the server computes the distance.

**Around each flight.** tripmail keeps a list of every future flight you are on (and of trains, buses and ferries, for busy blocks), also the ones whose events you made yourself, and on every run keeps three things in step with it. When a flight moves or is cancelled, they follow; things in the past are left alone.
- **Check-in to-do** in a Things project (`things_project`, default "✈️ Travel"), one per booking, for its first flight: `check in KL1234`, scheduled the day before departure (today if that has passed) with its deadline on that same day, with the check-in link (from the booking markup, else the airline's check-in page, else a web search) and the booking code in its notes. A cancelled flight cancels its to-do.
- **Busy block** in your work calendar (`work_calendar_account` / `work_calendar_title`) for each flight, train, bus or ferry that falls in working hours: `🛑 Vibe-busy`, from 2 hours before departure to 1 hour after arrival, made only when that time overlaps Monday to Friday 09:00–17:00 in `home_timezone`. Shown as busy, no alerts, with `[auto-split]` in its notes so [calsplit](https://github.com/bazilinskyy/vibe-work)'s nightly cleanup deletes it once past.
- **Trip banner**: an all-day event in the travel calendar from the day you leave a home airport (`home_airports`) to the day you are back, named after the place you stay ("Tenerife"), the country when you stay in several places ("Portugal"), or the countries ("Spain · France"). It is shown as free, with alerts at 15:00 the day before and 09:00 on the day. When an all-day event of yours already covers the trip, no banner is made. A trip without a known return gets no banner yet.

#### Trip docs

When `trip_docs_folder` is set and tripmail is signed in to Google (see [Install](#install)), it keeps one Google Doc per trip in that Drive folder, the docs you already keep there included. It reads and edits them through the Google Drive and Docs APIs on every run, with your own Google sign-in. Each doc has an Information heading, a Plan table (Place | Dates | Stay | Price | Comments; docs made before have "Accommodation" for Stay, which works too) and a Transport table (Transport | Date | Price | Comments).
- **Which doc:** the doc whose Plan or Transport dates overlap the booking or trip (a day of slack). With none, tripmail creates one with that layout, named after the trip and year: "Faro 2027", the country when it has several places ("Portugal 2026"), with " 2" added if the name is taken. A new doc has the styles of Google Docs' classic look as its own named styles (Normal text Arial 11, Heading 1 18 pt, Heading 2 14 pt, Heading 3 12 pt grey), its headings with nothing on top of them, on an A4 page with 1 cm margins in pageless view, so it looks like, and is edited like, docs made by hand. With a template doc (`trip_docs_template`), a new doc is a copy of it instead, so it has exactly that doc's styles, tables included (column widths, padding, font, and how far each table sits to the left, which the Docs API cannot set). `python mail/tripdocs.py template <doc id>` makes one from a trip doc whose look you like: a copy named "Trip template (tripmail)" in My Drive (not in the trips folder), emptied to its headings and three empty rows per table; it prints the id to put in `config`. Restyle that template doc by hand any time and new docs follow it. Without one, the doc is made from HTML and then given that look as far as the API allows: no spacing of its own on any paragraph, the Information, Plan and Transport headings centred, ordinary Google Docs tables with 5 pt cell padding, the column widths of the trip doc the template was made from and table text in Helvetica Neue. Text tripmail writes into a table is Helvetica Neue too. Its tables have three empty rows to write in, and anyone with its link can edit it (it is not listed or searchable), so you can share it straight away.
- **A to-do for a new trip:** when tripmail creates a trip's doc it also adds a to-do to the Things project (`things_project`), as you would by hand: `trip to Faro`, the doc's link in its notes, and a checklist (book flights, book accommodation, rent car, make plan) with what is already booked ticked. It is scheduled for the first Saturday after the doc is made, with its deadline on the last Sunday before the trip starts (when the trip starts before that Saturday: today, no deadline once that Sunday has passed). A to-do of yours that already has the doc's link is kept instead. Things' AppleScript cannot make checklists, so the to-do is made through its URL scheme (`things:///json`; Things > Settings > General > Enable Things URLs must be on), without opening Things. `"trip_todos": false` turns it off.
- **Empty tables:** a Plan or Transport table with no data yet, in the doc of a trip that is not over (by its dates, else by the years in its name), is given three empty rows.
- **Hotel or Airbnb:** the Plan row with that place and overlapping dates gets the Stay (the type, "Hotel", "Hostel", "Flat", "Room" or "House", linked to the booking) and the Price, but only cells that are empty. With no such row, the place, the dates written `22–23.10.26`, the stay and the price go in date order: into an empty row in that place, else a new row.
- **Cancelled hotel or Airbnb:** its Stay and Price cells are emptied; place and dates stay.
- **Rental car:** a Transport row of its own, in date order after that day's flights: `Rental car` linked to the booking, the days (`29.12–01.01.27`), the price, and the town with the booking code in Comments (`Nha Trang. Booking code: 2300000`). So its price counts in the Transport total. A cancelled rental car empties its row.
- **Flights, trains, buses and ferries:** one Transport row each, titled like the calendar event (`✈️ KL1234: Amsterdam - Lisbon`, `🚌 Faro - Albufeira`), with the departure (`07.12.26 16:10`) and its booking codes in Comments (`Booking code: QWE123, VW-12345678`; a code that comes later, such as the airline's from an e-ticket, rewrites that line and leaves your comments), in time order: an empty row in that place is filled, else a row is inserted. A cancelled or rebooked trip empties its row. A train, bus or ferry only joins a doc that covers its day; it never creates one, and waits until a flight or stay brings one.
- **A trip you planned before booking:** a Transport row of yours that names the same two ends in the same order (`Phú Quốc - Nha Trang`, accents and spaces aside; a station's name may hold its town's) with that day's date and no time (`28.12.26`) becomes the booked one when the ticket's email comes: its Transport and Date cells are rewritten (`✈️ 9G2952: Phuquoc - Nhatrang`, `28.12.26 12:10`), the price goes into an empty Price cell, and the booking code goes above your comments, which stay. A cancellation later empties the row but keeps your comments.
- **Prices of flights, trains, buses and ferries:** the booking's total (the first price after a line like `Total`, `Totaal`, `Amount paid`, `You paid`, else `Price` or `Fare`; from its PDF ticket when the email has none, as Travelfrom's, also a PDF inside a zip, as China Southern's; `Payment Amount` counts as a total) goes into the Price cell of the booking's first row; its other rows stay empty, so a return flight is not counted twice. A price read later (a second email, a rescan) is written into that cell when it is empty, without writing the row again. Neither does a change of the trip's name or dates (another flight joined the trip) write a row again: a row is only emptied and written anew when the booking itself changed.
- **Prices in euros:** under a price in another currency (`773760 VND`, `30 USD`, `$10`, `฿500`) tripmail adds a line `≈ 27.23€` in the same cell, at the day's rate from open.er-api.com (the ECB's rates have no dong or kip). Under each table with prices goes a line `Total: 131.04€`, with the prices it could not read named (`(not counted: 130+45)`); a part without a currency counts in the cell's other one (`20 USD + 5`). Done for the docs of trips not over yet, on the hourly run after a doc changes (not in the 30 minutes after an edit, like the suggestions). A line that is more than 5% off is written again (the price was changed), a smaller drift of the rate is left alone, and the total follows the prices. These lines are tripmail's own: they do not make Claude write new suggestions. `"trip_prices": false` turns it off.
- **Your text is never changed**: tripmail only writes into empty cells, adds rows, empties the cells it wrote, and keeps its own lines of euros. Bookings that are over are left alone.
- **Remembered:** `state.json` keeps which booking went into which doc, so a booking is written once, and a cancellation or change finds its row again.

**Suggestions.** When the doc of a trip that is not over yet changes, by your edits or by tripmail's, tripmail asks Claude for things to do and an itinerary and writes them into a **Suggestions** section of the doc:
- **When:** on each hourly run, for each doc in the folder whose Drive "modified" time moved since the last run, whose Plan or Transport dates reach today or later, and that was last changed more than 30 minutes ago (you may still be typing; tripmail's own edits of that run wait for the next one too). The doc's text without the Suggestions section is compared with the last time; when only the suggestions or the formatting changed, Claude is not asked again. At most three docs per run; the others follow an hour later. A coming trip's doc that has no Suggestions section yet gets one on the first run.
- **What Claude gets:** the doc as text (Information notes, the Plan and Transport tables; links reduced to their text and booking codes left out), today's date, where you have been near the trip's places before it (below), and the request: 3 to 6 specific things to do around each place you sleep (the Plan's places; where the flights go when the Plan is empty), within about an hour's drive when you have a rental car, none for a town you only land in; new to you, so not what a first visit is about where you spent days before, nor the famous sights of an area you know well; following your notes and comments; and one line or two per day from today (or the first day) to the last, each day from and back to where you sleep, following the stays' dates and transport times.
- **Where you have been before:** from Cairn, for each of the trip's places (the Plan's places and where the Transport rows go, each matched to the town of that name nearest where the trip's flights land, and those airports themselves; none near a home airport): the towns within 50 km you were in before the trip, most days first, with their days, visits, years and activities (`Sintra (9 days on 3 visits, 2019–2024: 2 hikes, 1 run)`), and the famous climbs you rode there; and what you still want to do there: the famous climbs within 50 km you have not ridden (the highest five, for a ride or two) and the places saved in your wish list. Without Cairn, the suggestions are made without it.
- **What goes in the doc:** in the doc's own styles, with no bold or italics on top: a Suggestions heading (Heading 1), a line with the date, **Things to do** (Heading 2) with each place as a Heading 3 and its things as bullets, and **Itinerary** (Heading 2) with a bullet per day (`Thu 12.11, Faro: ...`). Places and things link to Google Maps. The section runs from its heading to the next top-level heading, or to the end of the doc, and is tripmail's own: it is replaced as a whole each time, so move what you want to keep above it. Delete the section and it comes back on the next change of the doc.
- **How:** with the [Claude Code](https://claude.com/claude-code) command line (`claude -p`, model `suggestions_model`, default Sonnet, no tools), signed in on the Mac, so it uses that account's plan; about a minute per doc. When Claude fails (not signed in, a usage limit), the run logs it and tries again an hour later. `"trip_suggestions": false` turns it off.

**Never twice.** A train, bus or ferry is already in the calendar when any event starts within five minutes of it, whatever its title. A flight that is already in the calendar is not added again. That means an event on the same day whose title holds the same flight number with any airline prefix: `EJU1234`, `U21234` and `U2 1234` are the same flight. In Cairn, a flight on the same day with the same route or the same flight number counts as already there. A rental car from a booking email takes over the car you added by hand (or from a trip doc or the calendar) for the same days, a day either way, when there is one such car; a counter contract (Goldcar's, one day) joins the car that covers its day instead of being a car of its own. tripmail never changes or deletes events or flights it did not create.

**Alerts** go to a Discord webhook:
- emails about a trip still ahead that look like a flight booking but could not be read (not an airline's "useful information", reminder or check-in mail about a flight already booked)
- changes or cancellations for flights tripmail did not create
- run failures

An alert gives the sender, subject and date, never the email body. Each is posted once: reading the same mail again (`--rescan-days`) does not post it again (`alerted` in `state.json`, kept a year).

The mailbox is only read (IMAP `EXAMINE`, `BODY.PEEK`): nothing is marked, moved or deleted.

### How it works

1. **Gmail** (`fetch_new`): IMAP with an app password. It reads the All Mail folder, without sent mail, through a broad Gmail search for flight words in several languages. The first run looks back `lookback_days`; later runs read messages newer than the last one seen.
2. **Reading the email** (`parse.py`), in this order:
   - the schema.org `FlightReservation` markup (JSON-LD or microdata) that many airlines embed;
   - labelled blocks (`From:` / `To:` / `Flight number:` / `Departure:` / `Arrival:`, with the old and new sections of a rebooking);
   - otherwise, flight numbers with the airports, dates and times around them; a date heading a few lines above a flight's table is that flight's (China Southern).
   - the one flight of an email that has no airport codes at all gets the airports named in words within 15 lines of its flight number: an airport's name without "International Airport" or the town of a town with one airport, accents and spaces ignored ("Tan Son" "Nhat", "Phú Quốc", "Đà Nẵng"), in the email, else in its PDF (Vliegwinkel, whose emails name the towns in Dutch: "Ho Chi Minhstad").

   A flight number counts only when its airline exists in OpenFlights' `airlines.dat` and an airport or a flight word is nearby, so codes like `V33IPW` or an IBAN are not mistaken for flights. Dates and times are read in English and Dutch. Booking codes come from labels such as PNR, booking reference, boekingscode, boekingsnummer or reserveringsnummer, and agency numbers from eDreams, Booking.com, Gotogate, Vliegwinkel (`VW-12345678`) and China Southern's web shop (`Your Booking (Go2600...)`). When an email gives only such a number, the airline's code is looked for in its PDF (Vliegwinkel's e-ticket: `Online inchecknummer`). An email with codes but no flight (an e-ticket after the booking) adds its codes to the booking that shares one; codes from several emails about one booking are kept together. The email is classed as booking, change, cancellation or other.
3. **AeroDataBox** (`sync.enrich`): for every future leg, tripmail asks Cairn's `/api/flights/lookup` for the airports and scheduled local times of that flight number leaving on that day, and these win over the email. This fixes layouts that give only city names or put details in odd places. Each flight and day is looked up once (cache `~/.tripmail/lookups.json`), at most `lookup_monthly_limit` times per month. Flights AeroDataBox does not know keep the email's data. Airports come from OpenFlights' `airports.dat`; one it lists without a time zone (newer ones such as Beijing Daxing) gets the zone of the nearest town in GeoNames' list (below).
4. **Deciding** (`sync.apply`): the rules above, against a state file that remembers which events and Cairn flights tripmail created.
5. **Trains, buses and ferries** (`ground.py`): recognised by the sender (NS International, SNCF Connect, Deutsche Bahn, Eurostar, Trainline, FlixBus, redBus, Rede Expressos, 12Go, ferry operators and more) or by schema.org `BusReservation` / `TrainReservation` / `BoatReservation` markup, which is read first. NS International, SNCF Connect, redBus, Rede Expressos and Atlânticoline (the Azores' ferries) have their own text rules. When a train, bus or ferry email's text gives no journey, its PDF attachments are read too, with macOS PDFKit (Atlânticoline sends its journeys only in the PDF ticket); Atlânticoline's ports are put in the Azores' time zone. A station's time zone comes from the [GeoNames](https://www.geonames.org/) list of towns over 1,000 people (`data/cities1000.txt`, downloaded once, CC BY 4.0): the biggest town whose name starts the station name ("Bruxelles Midi" → Brussels), else `home_timezone`.
6. **Writing:** calendar events go through macOS Calendar (EventKit), so any calendar macOS sees works, for example a Google calendar added in System Settings. Cairn flights go through its REST API.
7. **Trip docs** (`tripdocs.py`): the Drive API lists the docs in the folder; the Docs API reads each one's tables (found by their header rows, `Place` and `Transport`) and writes cells and rows with `batchUpdate`. What should be in the docs (every stay, rental car, flight, train, bus and ferry not over yet) is compared with what was written last time (`state.json`), and only the difference is written. Then the suggestions: Drive's Markdown export of each changed doc of a coming trip goes to `claude -p`, whose JSON answer is written as the Suggestions section. Before that, the prices: each changed doc of a coming trip gets its lines in euros (rates fetched once a day).

Time zones come from the airport database: every local time is placed in its airport's zone, including across daylight-saving changes and for flights that land after midnight.

### Settings

In the `"tripmail"` sections of `config` and `secret`:

| Key | File | Meaning |
|---|---|---|
| `gmail_user` | config | the Gmail address to read |
| `passenger_names` | config | your name(s) as on tickets, e.g. `["Jan Testers"]` |
| `calendar_account`, `calendar_title` | config | the calendar to write to, as macOS Calendar names them (default `Google` / `Travel`); `mail/tripmail.py calendars` lists them |
| `lookback_days` | config | how far the first run looks back (default 365) |
| `cairn_url` (the older `contrail_url` works too) | config | Cairn's address (default `http://127.0.0.1:3000`) |
| `lookup_monthly_limit` | config | maximum AeroDataBox lookups per month (default 100) |
| `home_timezone` | config | time zone for stations that match no known town (default `Europe/Amsterdam`) |
| `things_project` | config | Things project for check-in and trip to-dos (default `✈️ Travel`) |
| `trip_todos` | config | a Things to-do with a checklist for each trip that gets a new doc (default `true`) |
| `work_calendar_account`, `work_calendar_title` | config | calendar for busy blocks (default `TUe` / `Calendar`) |
| `home_airports` | config | airports a trip starts from and returns to (default `AMS`, `EIN`, `RTM`) |
| `trip_docs_skip` | config | booking codes that never go into a trip doc (for example a work trip) |
| `trip_docs_template` | config | id of a Google Doc that new trip docs are copies of (`python mail/tripdocs.py template <doc id>` makes one); empty: made from HTML |
| `trip_docs_folder` | config | id of the Google Drive folder for trip docs (the part after `folders/` in its link); empty: no trip docs |
| `trip_prices` | config | a line in euros under each price in another currency and a total in euros under each table, in the docs of coming trips (default `true`) |
| `trip_suggestions` | config | things to do and an itinerary by Claude in the docs of coming trips (default `true`) |
| `suggestions_model` | config | the Claude model for them, as `claude --model` takes it (default `sonnet`) |
| `claude_path` | config | the `claude` command (default: found in `PATH`, else `~/.local/bin/claude`) |
| `gmail_query` | config | optional Gmail search that preselects mail; empty uses the built-in one |
| `gmail_app_password` | secret | a Gmail [app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification) |
| `discord_webhook` | secret | Discord webhook for alerts; empty sends nothing |

### Install

On the always-on Mac, from the checkout:

```
mail/install.sh
```

macOS gives calendar access per app and silently refuses it to a bare Python started by launchd. So the script builds a small AppleScript app, `~/.tripmail/tripmail.app`, which holds the Calendar permission and runs `tripmail.py`. It builds the app only once, because a rebuild changes its signature and macOS would ask again. The script then schedules the app every 60 minutes (launchd `nl.tue.tripmail`) and installs the Cairn service if it is missing.

Then fill in the `tripmail` settings and, **with the screen unlocked**, run a dry run and click Allow on the Calendar prompt (and, on the first real run that makes a to-do, on the prompt to control Things):

```
open -W --env TRIPMAIL_ARGS=--dry-run ~/.tripmail/tripmail.app; tail -40 ~/.tripmail/run.log
```

A dry run reads the mail and logs what it would create, update or delete, without changing anything. Only lookups happen, and they are cached. Read the list, then run once for real:

```
open -W ~/.tripmail/tripmail.app; tail -40 ~/.tripmail/run.log
```

The first run reads a year of matching mail and takes about ten minutes; later runs take seconds.

**Installed before the rename?** An install from when tripmail was flightmail keeps `~/.flightmail/` and its `flightmail.app` (a new app would need the Calendar and Things permissions again), which runs `mail/flightmail.py`, now a link to `tripmail.py`; its app reads `FLIGHTMAIL_ARGS` instead of `TRIPMAIL_ARGS`. Running `mail/install.sh` again renames the hourly job to `nl.tue.tripmail`, and the `"flightmail"` sections of `config` and `secret` still work.

**Trip docs (optional).** tripmail edits Google Docs with its own Google sign-in, made once:
1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (any name), then enable the **Google Drive API** and the **Google Docs API** (APIs & Services → Library).
2. APIs & Services → OAuth consent screen: user type **External**, fill in the app name and your email, add yourself as a test user, then **Publish app** (status "In production"). In testing status Google expires the sign-in after 7 days. The app stays unverified; that only means a warning when you sign in.
3. APIs & Services → Credentials → Create credentials → **OAuth client ID**, type **Desktop app**. Download the JSON and copy it to the Mac as `~/.tripmail/google_client.json`.
4. Sign in once. On the Mac itself: `python mail/tripdocs.py auth` and open the printed link. From another computer, keep a tunnel open so Google's redirect reaches the Mac: `ssh -L 8765:localhost:8765 <mac>`, run the command there, and open the link on your own computer. After you allow access (click past the "unverified app" warning), the refresh token is saved to `~/.tripmail/google_token.json` (mode 600).
5. Set `trip_docs_folder` in `config`, then do a dry run: it lists every cell it would write and every doc it would create.

The sign-in asks for full Drive access, because the trip docs you made yourself must be editable too.

**Suggestions (optional).** Install [Claude Code](https://claude.com/claude-code) on the Mac and sign in once (`claude`, then `/login`). tripmail runs it from the app started by launchd, which can read the login in the keychain (cron could not). Check with `echo 'Say hi' | ~/.local/bin/claude -p --model sonnet --tools ""`.

### Files

| File | What it is |
|---|---|
| `~/.tripmail/run.log` | log: each email acted on, each change, alerts and failures |
| `~/.tripmail/state.json` | last message read, the events and Cairn flights tripmail created, the stays, which booking went into which trip doc, and each doc's last suggestions (Drive modified time and a hash of its text) |
| `~/.tripmail/lookups.json` | AeroDataBox answers and this month's lookup count |
| `~/.tripmail/tripmail.app` | the app that holds the Calendar permission |
| `~/.tripmail/google_client.json`, `google_token.json` | the Google OAuth client and refresh token for the trip docs; never in the repo |

Other commands: `mail/tripmail.py calendars` lists the calendars EventKit sees. `mail/tripmail.py history [--days N] [--dry-run]` sends the stays, rental cars, trains, buses and ferries of past years (default 6000 days) from the mail into Cairn's map, never into the calendar or the trip docs; the hourly run only handles trips still ahead. A booking whose place, code or date could not be read is listed in its output and left out. It is safe to run again. Only one run works at a time (a lock file `run.lock` in tripmail's folder): a run started by hand while the hourly one is busy waits for it, as two runs editing the same doc put text at the wrong places. `--rescan-days N` reads all matching mail of the last N days again, for example after new rules were added (`open -W --env TRIPMAIL_ARGS="--rescan-days 365" ~/.tripmail/tripmail.app`); nothing is added twice.

To remove the hourly job:

```
launchctl bootout gui/$(id -u)/nl.tue.tripmail; rm ~/Library/LaunchAgents/nl.tue.tripmail.plist
```

### Limits

- **Languages:** English and Dutch text rules. Other languages (for example French Transavia emails) are read only through schema.org markup or AeroDataBox.
- **Attachments:** PDF attachments are read only for train, bus and ferry emails whose text gives no journey, and only on a Mac; flight e-tickets in PDFs are not read.
- **Not read:** trains, buses and ferries from operators without a rule or markup; add a rule in `ground.py` with a fixture and a test. Hotels and cars from other senders than those listed above; add a rule in `stays.py`.
- **Trip docs:** a cancelled rental car is only logged; remove it from the doc by hand. A changed booking is treated as cancelled and booked again.
- **Suggestions:** Claude answers from what it knows, without searching the web, so opening hours, prices and seasonal closures should be checked. An edit made while tripmail writes the suggestions waits for the doc's next change.
- **New layouts:** a layout none of the rules handle shows up as a "could not read" alert. To support it, add an anonymised copy to `mail/fixtures/`, a test in `mail/test_parse.py`, then a rule in `parse.py`.

## Using Cairn

Each tab has its own address, to share or bookmark: `/stats`, `/sports`, `/trips`, `/flights`, `/add` (and its parts `/add?travel`, `/add?stay`, `/add?check`, `/add?fix`); a page over a tab keeps its `#` part, as `/trips#trip=2024-05-01` or `/trips#place-photos`. Back goes to the tab before, and a page's ← button to the tab it was opened from (← Sports for an activity opened there). **+ Add → 📍 Place photos** opens Place photos too.

### The map

The legend at the top right shows or hides each layer, with how many it holds in the period shown:
- **Flights** (with their airports), **trains**, **🔁 commutes** (the trains between where you live and work; left out everywhere when the settings say not to count them), **buses**, **ferries**, hitchhiking, **🚙 car journeys** and **🚡 cable cars**: in the legend all under one **🚦 Transport** heading with the rental cars and scooters, folded like Stays and Activities (▸ shows each, its box turns them all on or off). Lines show as a line in the legend, markers as a dot, areas as a square.
- **Stays** (bigger for more nights), a group in the legend with a row per kind of bed, in three shades of one family: pink for hotels and other, and (a ring) friends' places and family; violet for hostels, and (a ring) Couchsurfing and BeWelcome; amber for Airbnb, and (a ring) camping. A filled dot is a bed you paid for, a ring a free one. The group's box turns them all on or off; and **rental cars** (yellow, at the pick-up place). tripmail sends every hotel, hostel, Airbnb and rental car booking it reads to Cairn, which finds the place with Photon and keeps it.
- **Photos**: where your photos were taken, about 1 km per dot, bigger for more photos. From `imports/photos.py` (below).
- **Timeline**: the places and daily paths of Google Maps Timeline. From `imports/timeline.py` (below).
- **Activities**: your sports activities (see [Sports activities](#sports-activities)), a group in the legend with a row per type, **Cycling**, **Running**, **Walks & hikes** and **Other sports** (orange, violet, magenta, yellow), and **Explored tiles**; the group's box turns them all on or off, a type's box shows it alone. Activities without a route (indoor, virtual, swims without GPS) are counted but not drawn.
- **Explored tiles**: the map squares your activities passed through, as [statshunters](https://www.statshunters.com) and VeloViewer count them: tiles at zoom 14 (about 1.5 km in the Netherlands), or squadratinhos at zoom 17 (about 200 m), as chosen in the settings. Zoomed in far enough, the grid of all tiles shows (can be turned off), so the unexplored ones you could ride or run to stand out. Darker: your **max cluster**, the biggest group of tiles whose four neighbours are explored too. Dashed: your **max square**, the biggest square of explored tiles; click it for the numbers. The legend shows the tile count and the square's size, for the period and the activity types shown.
- **Countries** you have been to, shaded, with your days there, first and last visit; the legend shows how many of the list's countries you have. A country counts when you were there on a day by any source: you landed or took off there (not only to change planes), took a train, bus or ferry there, stayed, rented a car, took a photo, started an activity or Timeline saw you there. Choose in the settings how countries are counted:
  - **ISO countries and territories** (250): every ISO 3166 country code, and Kosovo. Greenland, Puerto Rico, Hong Kong, Réunion and Svalbard count apart.
  - **Sovereign countries** (200): the 193 UN members, the Vatican and Palestine, Cook Islands, Niue, Kosovo, Taiwan and Northern Cyprus, as the Travelers' Century Club takes them. A territory (Greenland, Réunion) counts for none.
  - **[Travelers' Century Club](https://travelerscenturyclub.org/countries-and-territories)** (330): islands, parts of countries and claims count apart: the Canary Islands, Sicily, Scotland, Alaska, Russia in Asia, Turkey in Europe, Zanzibar, the Antarctic claims.

  Each place is put in its state or province from [Natural Earth](https://www.naturalearthdata.com)'s 1:10m map (`data/admin1.geojson`, 40 MB, downloaded on first use), and that in a country of the list (`country-lists.json`: whole countries, provinces, and boxes for islands Natural Earth does not draw apart). A point just off the coast goes to the province within about 20 km. Choices made for the Travelers' Century Club list: Russia is split at the federal districts (Urals and east are Asia); Crimea counts as Ukraine; the Amami islands stay Japan, not Ryukyu; Kashmir is the Indian-administered part; where the Antarctic claims overlap, the Argentine one counts.
- **Cities**: every town you have been to, sized by the days you were there, the ten most visited labelled; click one for its days, separate visits (a gap of more than a day starts a new one), and first and last day. A day counts in a town when, that day, you landed there or left from its airport (not when only changing planes), took a train, bus or ferry from or to it, slept there, picked up a rental car, took photos, started a Strava activity or Timeline saw you there. Each place goes to the town that pulls hardest, its population over the distance squared, within 25 km (GeoNames' towns over 1,000 people, `data/cities1000.txt`, which tripmail downloads); an airport goes to the city it is named for (Boryspil airport counts for Kyiv). The **Stats** tab lists the top ten of all time.
- **Your places**: your 🌱 hometown, 🏠 where you live and 💼 where you work, each a town picked in the settings (⚙️ → Your places: type a few letters and pick from the towns that come up, biggest first). All three marks are one size; one town can be two or all three of them (one mark with each); all are labelled and drawn above the other layers, and open their town's page. They are kept by Cairn (`data/home.json`, in the backup), not in the browser. **Where you lived before** (in `data/home.json` only, no settings page yet): a list of `lived` places, each `{ "name", "cc", "lat", "lon", "from", "to", "airports" }` (`from` the day you moved there, `to` the day you left; `airports` the ones your trips from there began and ended at). On those days that country is home: trips are counted from there (a flight from one of its airports until one lands back there; four days in its country are no trip), a room in that town is no night away, and the To check lists (trips with no way there or back, payments and Spotify abroad, quiet stretches) leave those days out. The day you moved counts both places as home. Example: `{ "name": "Lisbon", "cc": "PT", "lat": 38.72, "lon": -9.14, "from": "2010-09-01", "to": "2012-07-01", "airports": ["LIS"] }`. Below them, **Count the trains between where you live and work (commutes)**: on, they count as 🔁 commutes in the distances and show on the map; off, they are left out of both.
- **Climbs** (with any rides): 1,091 famous cycling climbs, the climbs in the cycle-racing categories of six Wikipedias (English, French, Italian, Dutch, German, Catalan; towns and buildings left out), with their summits from Wikidata (`climbs.json`), and 9 famous ones those categories miss, around Málaga, on Mallorca and on Tenerife, each at the top of its road (`climbs_extra.json`). Filled when one of your rides passed within 150 m of the top. A climb's **ways up** (Mont Ventoux from Bédoin and from Malaucène) are worked out in the background the first time a ride comes within 1.5 km of it: roads from the top down to the towns around (OSRM), heights along them from the open AWS Terrain Tiles; a way up starts where the road begins to climb (the next 2 km rise 3.5% or more) and ends at the road's high point. A ride counts for a way up when it rode that way's last 2 km up to the top, going up, and also the part that sets it apart from the climb's other ways (Bédoin and Sault share the last 6 km). A ride up a way not found is named after the nearest town 12 km before the top ("via Sault"). The popup lists each way up with its length, height gain and gradient, ✓ with your rides up it; the ways up you rode are drawn on the map. Kept in `data/climb_ascents.json`.
- **🏛️ World Heritage** and **🌲 National parks**: the 1,257 UNESCO World Heritage sites and 3,416 national parks Wikidata knows, each a dot where you have been (with your days there, first and last), the ones you have not as faint rings from zoom 6 in; the legend shows how many of them you have. A site is one or more places (a serial site such as the Struve Geodetic Arc has one per part, and any part counts), each with a reach: a circle of its area (at most 10 km; a park's 0.8 of that, at most 20 km), or 800 m (a park 2.5 km) without one. You have been on a day when a photo, check-in, stay, Timeline visit, the start of an activity or a point of its track is within it; a landing at an airport is not. A park is seldom round, so near its edge "been" can mean nearby.
- **Climb page**: "Open climb page →" in a climb's popup (or a climb's name in the Sports tab; address `#climb=<Wikidata id>`) shows its map with the ways up and your rides; **your ride up**, any effort, on the map and as a height profile coloured by speed, climbing speed (VAM), gradient, power, W/kg or heart rate; per way up your best time, what your FTP and weight now and on that day predict, a top climber (6 W/kg) and the **best known time** (`climb_records.json`: from race data, Wikipedia and watts2win.eu, each with its source and how it was measured), every ride up with its power, heart rate and the weather; the **photos you took on the way up** (during a ride up, or at the top within 20 minutes); and about the climb, from Wikipedia.
- **3D**: the button above the locate button opens the map in 3D with real terrain (MapLibre GL, AWS Terrain Tiles), tilted when zoomed in, with the layers of the 2D map (switched in its panel too: the same choice) for the period or trip chosen there. Two views: **🌍 Globe**, the earth as a ball, and **🗺️ Flat map**. Flights are drawn **✈️ In the air**, along their rough path: the great circle between the airports (which flights roughly follow), climbing over the first 300 km or so, cruising and coming down over the last 350, heights shown 10 times higher so they show at this scale, with their line on the ground faint beneath (deck.gl); or **〰️ On the ground**, that line alone. A route flown more often is drawn once, a little wider; click one for its dates. Right-drag (or ctrl-drag) to tilt and turn; the mountain button switches the terrain off and on; **← 2D map** (or Esc) goes back to the same place.
- **City report**: "Open report" in a city's popup opens a page for that town (in the period shown): days and separate visits, each visit with what happened in it, then the stays and rental cars (with the hotel), flights in and out, trains, buses and ferries from or to it, the sports activities that started there (click one for its route), photos per month and Google Timeline places, and a small map of the town you can drag and zoom with all of that, the photos and the famous climbs around it. Each visit links to its trip. Its address, `#city=<GeoNames id>`, can be bookmarked.
- **Airport page**: **Airport page →** in an airport's popup (or a code in the Flights list, or `#airport=AMS`): its flights in and out in the period shown, the airports it took you to and from (with how often and when last), the airlines, the distance, and a map of its routes.
- **Airline page**: an airline's name in the Flights list, the Stats tab or a page's flights (or `#airline=Ryanair`): its logo (from pics.avs.io once, kept in `data/airline_logos`), country, codes and call sign (OpenFlights' `data/airlines.dat`, else the code its flight numbers start with), and the flights you took with it in the period shown on a map of its routes: how many (and their share of all yours), the distance, the time in the air, the airports and countries, its routes both ways together, the longest and shortest, by year, the planes, the class, the seat (window, aisle or middle from the seat letter) and every flight.
- **Country page**: **Country page →** in a country's popup, a name in the Stats tab's country table, a flag on a town or trip page (or `#country=UA`): its flag ([flagcdn.com](https://flagcdn.com)), days and visits, its towns (sortable, each opening its page), the trips that went there, flights in and out, trains, buses and ferries, stays, sports, photos, the famous climbs in it you rode, the music you played there, and a map of its outline with its towns, sports activities, trains, buses and ferries, stays and rental cars, airports, climbs and photos, each a layer to switch off (top right). All time. It counts as the country list chosen for the map does: under the Travelers' Century Club, Japan's page leaves out Okinawa, which has a page of its own (a flag or `#country=JP` opens the place of that list where you spent most days in Japan).
- **Town flags**: a town's page shows its own flag, or its coat of arms when it has none, from [Wikidata](https://www.wikidata.org) (found by the town's GeoNames id; the image from Wikimedia Commons), looked up once and kept in `data/town_flags.json`.
- **Trips** (the tab): the runs of days you were away, by year. A day is away when anything (a flight, train, stay, activity, photo, Timeline) puts you outside your home countries (those of `home_airports`), or you slept in a stay; days in a row make a trip when it has a night in a stay, a flight, a train, bus or ferry, or lasts three days or more, so a ride over the border and back is none. Days between a flight out and a flight home count as away (up to 90 days). A trip's page (`#trip=<first day>`) has its map: flights, trains, buses and ferries, stays, activities, photos, and the **moves** between them as Polarsteps draws them: from photo to photo, activity to activity and stay to stay, when nothing of your own shows how you got there; moves of 10 km or more follow the likeliest road route (OSRM, looked up in the background, kept in `data/drives.json`), in yellow as a **drive** while you had a car: a rental car or a rented scooter or moped (🛵, `vehicle: "scooter"`; or one you added by hand) from its first day, or from your landing near it when you flew in or came off a ferry that day, until a flight or a ferry with its times, and again after a landing near it (a domestic flight while you kept it, the next island's car at the port), never after a landing at a home airport; a move counts from when you were last seen at the place you left (an evening in town, then the car the next morning: a drive, on that morning). On a car day a hop of 5 km or more is a drive however slow (a walk that long is an activity of its own), and the drive starts at the car's pick-up place only when you were not seen there already. On the main map a day's drives that follow on (stops at viewpoints, a short walk between) are one road trip, with the towns it stopped at. Then its numbers, **day by day** where you were (towns, linked to their pages), how you moved, what you did and where you slept, and its stays, flights, trains, activities and famous climbs. **🖨️ Journal** prints the trip (or saves it as a PDF from the print dialog): its map, numbers and day by day with the photos, on white, a day not split over two pages where it fits; printing the page any other way gives the same.

The box at the top left sets the period:
- **Years**: only what happened from one year to another.
- **Trip**: one trip of the Trips tab (above; until those have loaded, from leaving a home airport, `home_airports` in the `"tripmail"` section of `config`, until landing at one again). The map zooms to it; **page →** opens the trip's page.
- Where the activities come from: Garmin, with its last sync (or why it failed); Strava, when it is set up, with **fetch now** (else **Connect Strava**).
- **Where on**: a day. A marker shows where you were: your stay that night, else the end of that day's last flight or ride, else a Timeline place or photos. With nothing that day, the last place known before it.

**Photos.** On the Mac that has your Photos library, from a checkout of this repository (or just the script), with [uv](https://docs.astral.sh/uv/) so nothing gets installed (`pyobjc<13`: version 13 does not load on macOS 15):

```
uv run --with osxphotos --with 'pyobjc<13' python imports/photos.py --send mini:repos/contrail/data/photos.json
```

It reads the library at `~/Pictures/Photos Library.photoslibrary` (another with `--library`; a folder of files with `--folder`, which needs exiftool) and keeps only the places rounded to about 1 km, the number of photos and the days, per year: no file names, pictures or exact positions. `--send` copies the result to the Mac that runs Cairn; run it again after new photos.

**Google Photos** cannot be read through Google's API for this (since March 2025 it only gives apps the photos they uploaded themselves, and it never gave their places). Export it with [Google Takeout](https://takeout.google.com) instead: only Google Photos, as zip files. Then, with the zips as they came (no need to unpack them, or give the unpacked folder):

```
python imports/photos.py --takeout ~/Downloads/takeout-*.zip --send mini:repos/contrail/data/photos.json
```

Sources can be combined in one run, for example the laptop's library copied to mini and the Google Takeout: `--library ~/Pictures/Laptop.photoslibrary --takeout ~/Takeout/takeout-*.zip`. A photo that is in both (the same moment and place) counts once; each run replaces the file, so give every source each time.

Only the small `.json` file Google puts beside each photo is read (when it was taken and where, from the camera or a place you set in Google Photos), never the photo itself; a photo that is also in an album counts once. A new export replaces the last one, so export everything each time.

On the Mac that runs Cairn, with the photos in its own Photos library (Google's imported into it, for example with `osxphotos import`), `--points data/photo_points.json` also writes every photo's exact place, time and file for the photo layer, trips and town pages, and `--albums data/photo_albums.json` the library's albums for the album suggestions (below), so neither the Takeout folder nor any export is needed once the photos are in the library:

```
uv run --with osxphotos --with 'pyobjc<13' python imports/photos.py --points data/photo_points.json --albums data/photo_albums.json --unplaced data/photo_unplaced.json
```

`--unplaced data/photo_unplaced.json` lists the photos with no place, with the albums they are in, for **Trips → 📍 Place photos** (`#place-photos`): they are shown by trip (its name and dates as a heading, with a button for each of its main towns) and by day, each day with buttons for the towns Cairn has you in that day, likeliest first; select one or many (a click, shift-click for a run, a day's checkbox, or filter by album or year and select all shown), then place them in a town (search it, or the town Cairn has you in that day, one click) or drag them onto the map to put them at that exact spot. A double-click shows a photo whole. Photos with nothing to place (a screenshot, a scan, a photo of nothing) can be taken out instead: **🗑 Remove from Cairn** drops the selection from the page and from what Cairn places by itself, kept in `data/photo_removed.json` (and in the backup); Apple Photos keeps them as they are, and **Bring them all back** undoes every removal. Each placing or removal can be undone on the page. Places are kept in `data/photo_places.json`, are on the map and count for your days at once (not a photo marked `"undated": true` there, whose camera's date is wrong, nor a day of photos placed by hand that were copied or scanned in one go: two or more jumps of over 300 km within an hour, or 10 photos within 10 minutes over 300 km apart; those stay on the map), and are written into the Photos library itself in the background half a minute later (`imports/photos_place.py`, never while another job drives Photos; `"photos_write_back": false` in `config` keeps them in Cairn only). An undo after that only takes the place out of Cairn. From the laptop it works through the ssh tunnel (see [Running on an always-on Mac](#running-on-an-always-on-mac)).

Photos that are in the library more than once, byte for byte the same file (an export imported twice, the same Facebook photo in two of its albums), show up here twice. `uv run --with osxphotos --with 'pyobjc<13' python imports/photos_dedupe.py` says what it finds, and with `--apply` it keeps one of each: the one with a place (in Photos or given in Cairn), else the one in the most albums. That one is added to every album the others are in and takes their favourite mark, title and caption when it has none. The others go to the album "To delete: older copies (Cairn)", which Cairn leaves out; delete them there in Photos by hand (they wait 30 days in Recently Deleted), as Photos cannot delete by script. With `--similar` (add `--with pillow --with pillow-heif`) it also finds the same picture in files that differ, a resized or recompressed copy beside the original: two photos are copies when their perceptual hashes (in `data/photo_phash.json`) are close and no 8×8 block of the two at 64×64 differs by more than a little, so a burst of shots where someone moved is left alone. Of those the largest picture stays and takes a place only a copy had.

Photos whose dates are not when they were taken (an album uploaded to Facebook in one go) cannot be placed by their day, but they often show where they were. `imports/photos_recognise.py SPEC` places an album's photos in the towns of its trip: the spec lists each town with the day you were there and what can be seen there ("the Colosseum", "an aquarium with a manatee"); CLIP (open_clip, on this machine) compares each photo with those, and as the album keeps the order the photos were taken in, a photo of a meal or a hostel bed takes the town of the photos around it. `--sheets DIR` or `--all FILE` gives contact sheets to check by eye, `--fix` what you saw there (`{"30-41": "Milan"}`), `--apply` places them, at noon of each town's day so they count for the right day.

`imports/photos_landmarks.py` asks Google's Cloud Vision API which landmark a photo shows, with its latitude and longitude, for photos with no place anywhere. Within the free 1,000 a month: at most 950 go in a calendar month (counted in `data/vision_usage.json`), each photo once (the answers are kept in `data/photo_landmarks.json`), those CLIP finds most likely to show a landmark first (`--rank`, `data/photo_landmark_rank.json`). A photo is placed at its landmark when Google's score is at least 0.5 and its time is when it was taken, by the rule Cairn uses for placing photos itself; the others' landmarks are kept but not placed, as they would count for the wrong day. It needs a key, `"google_vision_key"` in `config` (a Google Cloud project with billing on and the Cloud Vision API enabled; the key best restricted to that API). On the always-on Mac the LaunchAgent `nl.tue.cairn-landmarks` runs it on the 2nd of each month (log `~/Library/Logs/cairn-landmarks.log`); `--dry-run` says what it would send, `--place-only` places again from the answers kept. On **📍 Place photos** a filter shows those Google found nothing in, the unlikely ones (CLIP's rank under 0.2, not sent yet) or those it found a landmark in but did not place (`#place-photos=nothing`, `=unlikely`, `=found` open it so): the ones left to place by hand after each month's run.

Both place photos as Cairn's own guesses (`"auto": "image"` and `"landmark"` in `data/photo_places.json`): on the map as placed by Cairn, not written into Photos, and taken back with **Take them back**.

Cairn can also place many of them by itself (**Place them** at the top of the page): a photo taken within half an hour of one with a place goes to that spot, and a photo on a day when everything else (flights, trips, stays, activities, other photos) puts you within 20 km of one town goes to that town, as does one on a day with none of these between days at most three before and after in the same town, and one on a day with none of these and no trip within a day of it, at the place you lived then (`lived` in `data/home.json`, else where you live now): with every trip in Cairn by now, a day away from them all was a day at home. Travel days are left to you, and so are photos whose time is not when they were taken: 40 or more within an hour, a run of ten or more each within 30 s of the one before (a batch copied or uploaded at once), an album named for another year, and profile and cover pictures. These guesses are kept in Cairn only (`"auto"` in `data/photo_places.json`), not written into Photos; they are on the map as "placed by Cairn", never count as evidence for placing more, and **Take them back** removes them all.

**Google Maps Timeline.** Export it on your phone (Android: Settings > Location > Location services > Timeline > Export Timeline data; iPhone: Google Maps > Settings > Personal content > Export Timeline data), or use an older Takeout of Location History, then:

```
python imports/timeline.py ~/Downloads/Timeline.json --send mini:repos/contrail/data/timeline.json
```

Every layout Google has used works: the phone's `Timeline.json` (Android and iOS), Takeout's "Semantic Location History" folder and `Records.json`. It keeps the places you stayed at, with their times and names, and each day's paths, simplified to about 50 m and cut where you flew.

Cairn reads both files again whenever they change; no restart is needed.

The **All layers** box at the top of the legend turns every layer on or off at once. Groups (Stays, Activities) are folded into their heading; ▸ shows their rows (remembered in this browser).

**Settings** (⚙️ in the top bar, kept in this browser apart from your places): kilometres and metres or miles and feet, everywhere (flight statistics and list, popups, the Sports tab: speeds in mph, paces per mile, the Eddington number in miles, ride best efforts at 30, 60, 100 and 125+ miles); tiles at zoom 14 or squadratinhos at zoom 17 (worked out in the browser from each route the first time, then kept); whether to show the tile grid; how countries are counted, on the map and in the Stats tab's Countries table; the **map**: following the light or dark theme, light grey or dark grey (lines and markers stand out, as on statshunters), OpenStreetMap in colour, topographic (OpenTopoMap) or satellite (Esri); and **lines and markers**: standard, bold (thicker, solid lines and bigger markers, best on a grey map) or fine. The browser also remembers which layers you show, where the map was, and whether airports are clustered. The button above the zoom buttons (bottom right) centres the map on where you are (the browser asks you to allow it the first time; it works on `localhost`, also through the tunnel, and on https).

### Sports activities

Your rides, runs and other activities come from Garmin, free of charge: your whole history from Garmin's data export, then new ones every night from Garmin Connect. Both are `imports/garmin.py`, run with [uv](https://docs.astral.sh/uv/) so nothing gets installed; it writes `data/garmin.json`, which Cairn reads again whenever it changes.

1. **Your history.** On garmin.com, Account > Data Management > **Export Your Data**; Garmin emails a link to a zip within a few days. On the Mac that runs Cairn, give it the zip as it came (or its unpacked folder):
   ```
   ~/.local/bin/uv run --with fitdecode python imports/garmin.py export ~/Downloads/<the export>.zip
   ```
   Each activity gets its name and type from Garmin's summary and its route, distance, time, climbing and heart rate from its own file (the full track, simplified to about 20 m for the map; its explored tiles from the full track). Activities without a file (manual ones) come from the summary alone. Running it again with a newer export adds and updates; nothing is added twice.
2. **Sign in to Garmin Connect once**, in a terminal (also over SSH): your email, password and, with two-step verification, the code. The password is not kept; a token in `~/.garminconnect` (readable by you only) lasts about a year:
   ```
   ~/.local/bin/uv run --with garminconnect python imports/garmin.py login
   ```
3. **The nightly sync**: `imports/install_garmin.sh` installs the LaunchAgent `nl.tue.cairn-garmin`, which runs `garmin.py sync` every night at 02:30 (on mini between the 01:30 backup and the jobs from 04:00; `HOUR=` and `MINUTE=` change it), with your cycling FTP and weight for the climbs (log `~/Library/Logs/cairn-garmin.log`). It fetches new activities with their files, and once a day lists them all again, so renamed, retyped and deleted ones follow. A plain sync only fetches activities up to 30 days older than the newest it has: older ones are the export's. Without an export, `garmin.py sync --all` fetches everything, one file a second (hours for thousands).

**Stop pressed too late.** When a run, walk or hike goes on at over 22 km/h (each minute's average) for 2 minutes, or a ride at over 55 km/h for 5 minutes on a road that is not going down, the activity probably went on in a car. The nightly sync then posts it to the alerts channel (tripmail's Discord webhook in `secret`): which activity, from which km, how far and how long at car speed, and a link to trim it in Garmin Connect. Activities from the export get the same check (`vehicle` in `data/garmin.json`) without alerts.

Indoor and virtual activities (a trainer, a treadmill, MyWhoosh or Zwift) keep their numbers but no route, so a virtual world's made-up coordinates do not land on the map, in the tiles or in your countries. Their files often carry a made-up local clock too (1989, 2046): an offset from UTC over 14 hours is ignored, and the activity's date comes from Garmin's summary instead.

The sync uses the unofficial Garmin Connect login ([python-garminconnect](https://github.com/cyberjunky/python-garminconnect)), which Garmin does not sanction: when Garmin changes its sign-in, the sync fails for a while (the map's box says so, with the error) until the library catches up; sign in again if the token has expired. The export always works.

**Strava** (optional): since 2026 Strava's API is only for subscribers. With a subscription, Cairn reads your activities through it, read only:
1. On [strava.com/settings/api](https://www.strava.com/settings/api), create an API application: any name and website, **Authorization Callback Domain** `localhost`.
2. Put its Client ID and Client Secret in `secret` as `strava_client_id` and `strava_client_secret` (no restart needed).
3. Open Cairn in a browser on the Mac that runs it, at `http://localhost:3000`, or from another machine through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 mini`, then `http://localhost:3000` there), and click **Connect Strava** in the box at the top left. Allow "View data about your activities", including private ones.

Cairn then fetches the list of all your activities (200 per request, each with its route as Strava draws it on the activity page) and stays in step every hour: new activities hourly, the whole list once a day so renamed, made private or deleted activities follow. A Garmin, Wahoo or other device that uploads to Strava ends up here the same way. The sign-in token is kept in `data/strava_token.json` (readable by you only) and renewed by itself; to disconnect, revoke Cairn under Strava's Settings > My Apps and delete that file.

An activity in both Garmin and Strava (Garmin uploads to Strava; started within two minutes, the same kind of sport) is kept once, Garmin's.

Made for thousands of activities (sites like statshunters can stall on the first load with 5,000): Cairn works out the explored tiles of each activity once, when it fetches it, not in the browser; the list reaches the browser gzipped, and not at all when it has not changed; the map is usable before the activities arrive; and routes and tiles are painted on canvas map tiles, only where the map is in view, not as one map object each. With 5,000 made-up activities (800,000 route points, 77,000 tiles) on mini: the list is 3.3 MB gzipped, everything is on the map 1.5 s after the page opens, a change of period takes under half a second, and a screenful of map tiles about 0.4 s at the most crowded zoom.

### Sleep, heart rate, weather and music

- **Sleep and resting heart rate**: `imports/garmin.py export` also reads the export's daily summaries and sleep (resting heart rate, steps, stress, Body Battery; sleep and its stages, Garmin's sleep score) into `data/wellness.json`, and every nightly sync adds the last days. They show on a trip's page (each day, and the trip against the month before it) and in the curiosities (away and at home). A night whose sleep was not really measured is left out: older watches give no sleep stages and call the whole time the watch lay still "deep" (12 to 13 hours, also when it lay on a table), so a night over 90% "deep" without REM does not count.
- **An activity's page**: click a ride or run on the map (within 12 pixels of its line; the pointer turns into a hand over one), then its name in the popup, or an activity named in the Sports and Stats tabs, a year's page or a town's, country's or trip's map (or `#activity=<id>`): its route on a map with the photos taken and the famous climbs it went up, distance, moving time, average and top speed, climbing and the highest and lowest point, heart rate, power, the weather, the night before's sleep, and the profile of its timed track (height, speed, heart rate and power along the way: move over it to read them at a point and see it on the map), then its climbs, photos, the music played while it lasted and the trip it was part of.
- **Weather on your rides**: Cairn looks up each ride in [Open-Meteo](https://open-meteo.com)'s history (free, no key), in the background, one a second, and keeps it in `data/weather.json`: the temperature (lowest to highest), rain, wind and its direction, the strongest gust and the sky, at the ride's start over the hours it lasted. A ride of the last 6 days waits, as the history is a few days behind. It shows in a ride's popup, on the trip and climb pages, and in the curiosities.

### Music

Your [Last.fm](https://www.last.fm) scrobbles show what you played on each trip (its soundtrack, and each day's most played track) and in each town (on your days there), and on the map as **🎵 Music**: each day's plays in the town you were in that day (Spotify's on the days Last.fm has none), as a heatmap or a pin per town with its plays and artists (the 🎵 button on the map switches). Create an API key (free: [last.fm/api/account/create](https://www.last.fm/api/account/create), any name and description) and put it with your user name in `secret`:

```
"lastfm_api_key": "…",
"lastfm_user": "your Last.fm name"
```

No restart is needed: Cairn fetches your whole history in the background a few minutes after it starts (or now, with `curl -X POST localhost:3000/api/music/sync`; about a minute per 10,000 scrobbles), then the new ones every six hours, and keeps them in `data/lastfm.json`. A scrobble counts on its day in UTC.

### Books

The books you read show where you were the day you finished each: a 📚 pin on the map (one per place, its books in the popup) and a list on each trip's and town's page. Export your library from [Goodreads](https://www.goodreads.com) (My Books → Import and export → Export library), or download your data (Account settings → Download your data: a zip), and pick the CSV or the zip, as it came, under ⚙️ Settings → Imports → 📚 Goodreads. A new file replaces the books of the last one but keeps what only the other kind knew. The place is the stay you slept in that night, or else the town you were seen in most that day (photos, rides, Timeline, check-ins); a day with neither has no pin.

The library export has the authors and pages and the day you finished each book, not the day you started it, nor the earlier times of a book read again. The data download has those days (each time you read it: "started" in the book lists), but no authors nor pages. Give both to have all; Goodreads has no API any more.

### Curiosities

The **Stats** tab's **Flights per year** has every year from your first flight to your last booked one, those without a flight too, so a gap shows as one; flights still to come stand lighter on top of those flown.

The **Stats** tab ends with curiosities from every day Cairn knows a place for (up to today): days by the sea (within 2 km of [Natural Earth](https://www.naturalearthdata.com)'s coastline, `data/coastline.geojson`, 10 MB, downloaded on first use) and days above 1,000, 2,000 and 3,000 m, the highest place, the highest you went on foot or by bike, the highest night (the ground's height at each place from the AWS Terrain Tiles, kept in `data/heights.json`; the first time takes a minute or two), the farthest you went north, south, east and west and from home, days in the southern and western hemispheres and the tropics, the capitals you have been to, how far you went by each means (trains between the towns you live and work in, from your places, count apart as 🔁 commutes; and how many times around the earth that is), the most countries in a day, the longest stay, nights per kind of bed (a friend's place and family each count apart), where each New Year's Eve was, the hottest, coldest, wettest and windiest rides, and your sleep, resting heart rate and steps away and at home. **Time zones**: how many hours your flights moved your clock (forward going east, back going west; each airport's zone on that day, summer time included), the trips that took you farthest from your home clock (each day's town against your first home airport) with the jet lag they are said to take (a day an hour going east, two thirds of one going west, from 3 hours), and what your sleep says about it: Garmin's sleep the 3 nights after a flight across 4 or more hours, against the 2 weeks before. It also counts the **World Heritage sites** and **national parks** you have been to (see the map's layers), the latest first, and lists them all under two folded lines, each linked to its UNESCO or Wikidata page.

### Days per country, and Schengen

The **Stats** tab's **Days per country, year by year**: a grid of the countries (your home countries first, then the 30 you spent most days in) by year, each cell as dark as the days there, with a row of the days abroad. Above it, the Schengen area's 90 days in any 180: the days in its countries other than the ones you live in in the last 180 days, and the most it comes to with what is booked ahead. (It applies to someone from outside the area; a citizen of it has no limit.)

### Where you write code

With your GitHub commits imported (`imports/github.py`, [below](#more-of-your-life-data-downloads)), the **Stats** tab's **Where you write code**: commits by country, town, year, hour and weekday, the trips you coded most on, the farthest from home and the commits made in the air; trip, town and country pages each get their own.

### On this day

The **Trips** tab shows where you were on today's date in the years before: the towns, the trip it was part of, flights, trains, buses and ferries, where you slept, sports, a few photos, the song you played most and the book you finished. **⚙️ Settings → On this day** sends it every morning at 08:00 to the alerts channel (tripmail's Discord webhook); off unless turned on (kept in `data/home.json`, the day last sent in `data/onthisday_sent.json`).

### How it looks

**⚙️ Settings → Map** picks the base map of every map: OpenStreetMap (toned to the theme, grey or in colour), topographic, satellite, or a **vector map** ([OpenFreeMap](https://openfreemap.org): sharp at every zoom, with clear labels, no key; dark, dark blue-grey, light grey, in colour, or following the theme). A vector map is drawn by MapLibre GL, loaded the first time; the 3D view and a browser without WebGL show OpenStreetMap instead. The **Trips** tab shows the trips as **cards** (a cover photo, a sketch of the route from town to town, the days) or as a **table** (▦ / ☰, remembered in this browser). A trip's page opens with its cover across the top: the middle photo of its day with the most photos, or the one you pick with **🖼️ Change cover** (kept in `data/trip_covers.json`). Each way of moving has its icon on its map colour wherever it is listed, and in the replay. Switching between the light and dark theme (☀️/🌙) takes the map with it: a dark base map becomes its light one and back (the one you last used with each theme), and the lines and markers take the colours made for it.

### Replay and export

A trip's page has **🎬 Replay**: the trip drawn on a map as it happened, day by day, the camera flying from place to place, the photos coming up where they were taken (four a day at most), a title at the start and the trip's numbers at the end, at most two minutes. Pick the map (dark, satellite or light: OpenStreetMap's or Esri's tiles, drawn by the page itself) and the shape (16:9, 9:16 for a phone, square); **⬇️ Save video** loads the map first, then plays it once and saves it with the browser's recorder (MP4 where it can, else WebM), so keep the window in front until it ends. **⬇️ Export** gives the trip as **KML** (Google Earth, Google My Maps), **GPX** (a track per line, a waypoint per stay) or a **page to share**: one HTML file with its map and day by day, without the stays' names, bookings, prices, health or photos.

### Coming trips

The **Trips** tab starts with your coming trips (and a trip's own page with **Getting ready**): its flights, each with whether its check-in is in hand, its trains, stays and rental cars, and what is still missing:
- **a check-in to-do** for a flight: one per journey (connecting flights share it); a to-do in Things (`things_db`) that names the flight, or is dated up to three days before it, counts, whether open, done or set aside;
- **a bed** for every night between arriving and leaving (a night flight or night train is one);
- **the way there or back**: a trip that starts or ends at an airport that is not one of your home airports, with nothing booked to or from it.

Each missing thing has **Add to Things** (a `things:` link that makes the to-do in ✈️ Travel, on the phone or laptop you open it on) and **Not needed**; one an open to-do is already about ("trip to Malaga" with "book flight to Malaga") says so. Below: the open to-dos that name the trip's towns, countries or flights, the weather forecast once the trip is within 16 days (Open-Meteo), places you saved nearby and the famous climbs within 40 km of your stays you have not ridden, each with a **GPX** of a bike route from the stay to its top and back (FOSSGIS's bicycle routing on OpenStreetMap, for your bike computer; it does not know which side of the climb is the famous one). **Every morning at 07:30** the missing things that are not a to-do yet and are due within two months, and not reported before, go to the alerts channel (tripmail's Discord webhook); what was sent is kept in `data/prep_alerts.json`.

### Spending

The **Stats** tab's **Spending on stays**: what your stays cost, from the price in their booking emails and trip docs ("43.50€", "4105.50 DKK"), in euros on the day of the stay (the ECB's rates through Frankfurter; for currencies the ECB does not publish, today's rate from the open currency-api), kept in `data/rates.json`: in all, per night, per year, country and town, the dearest and the cheapest nights. A trip's page says what its stays cost. Only stays with a price count, and how many is always said; flights, trains and card spending are not in it yet.

### Year in review

**Stats → Year in review** shows **the years side by side** first: a row a year with its days with a place, days away, trips, countries and towns (and how many new), the distance flown, overland (by train, 🔁 commute, bus, ferry, hitchhiking and 🚙 car: your car journeys and the drives while you had a car) and on your own power (rides, runs, walks), the nights in stays (by kind of bed, on hovering), photos, climbs ridden for the first time and what stays cost, each with a bar against the biggest year; click a heading to sort. A year's own page (a year there, or on the Trips tab; `#year=2025`): the year's trips, the countries and towns you went to for the first time, where you spent it, how far by each means and the nights per kind of bed, the climbs you rode (🆕 the first time), the music you played most, your photos, sleep and resting heart rate, the weather's extremes on your rides and what your stays cost.

### Report (PDF)

**Settings → Report → Download PDF** makes one PDF of it all, to keep or print (A4):
- **Cover:** a world map of every town you were in.
- **At a glance:** trips, days away, countries, towns and flights; how far by each means and the nights by kind of bed, as bars; the records from the curiosities (farthest north, south, east and west, highest and lowest, longest stay, most countries in a day…); the climbs you rode.
- **Countries:** each with its days, visits and years.
- **Year by year,** then a page of contents with links.
- **Every trip:** its countries and towns, a sketch of the way on the coast, how you got around (flights, trains, buses, ferries, drives), where you slept, your rides and runs, the music you played, the books you finished, what the stays cost and six of its photos.

Choose the years and whether photos are included. Trips still ahead are listed at the end. The PDF is printed by the Chrome or Chromium of this computer (`config.chrome`, the `CHROME` variable, or where it usually is; a minute or two for a few hundred trips, about 30 MB with photos). It waits for the curiosities when Cairn has only just started. Without Chrome, **Open as a page** shows the same report (`/report`), to save as a PDF from the browser's Print dialog.

```
curl -o cairn.pdf "localhost:3000/api/report.pdf?from=2020&to=2025"
```

### Wish list

**Trips → ⭐ Wish list** (`#wish`): the places you saved in Google Maps, on a map and by list; the famous climbs you have not ridden within 60 km of the towns you spend most days in; and the countries you have no day in yet. Saved places come from Google Takeout ("Maps (your places)" and "Saved"):

```
python imports/saved_places.py ~/Downloads/takeout-*.zip
```

which writes `data/saved_places.json` (the starred places with their position; a list's place with it when its link holds it). A coming trip shows the saved places within 30 km of where you stay.

### More of your life: data downloads

Each of these reads a data download as it comes (zip or unpacked folder) and writes a file in `data/` (in the backup); give several at once, mixed. Standard library Python, no network.

The easiest way is **⚙️ Settings → Imports**: a row per source (these, and Garmin's export, Google Timeline, Google Maps saved places and Goodreads), each with what to download, whether a new import adds to what is kept or replaces it, and how its last import went. Pick the files (several at once where a source has many) and Cairn uploads them, runs the import below on them in the background with [uv](https://docs.astral.sh/uv/) (`config.uv`, else `~/.local/bin/uv`) and removes the uploaded copies after. From the laptop it works through the ssh tunnel. The commands below do the same by hand.

| Source | How to get it | Then |
|---|---|---|
| **Facebook**: check-ins, posts and photos with a place | facebook.com → Settings → *Download your information* → choose JSON, all time, "Posts" (and "Check-ins" where offered) | `python imports/checkins.py ~/Downloads/facebook-*.zip` |
| **Instagram**: posts with a place | Instagram → Your activity → *Download your information* → JSON, all time, "Content" | `python imports/checkins.py ~/Downloads/instagram-*.zip` |
| **VK**: posts and photos with a place | vk.com/data_protection → *Request archive* (photos, wall) | `python imports/checkins.py ~/Downloads/Archive.zip` |
| **Google Maps reviews** | takeout.google.com → "Maps (your places)" | `python imports/checkins.py ~/Downloads/takeout-*.zip` |
| **Foursquare Swarm** check-ins | foursquare.com → Privacy settings → *Download my data* (`checkins1.json`, …) | `python imports/checkins.py ~/Downloads/foursquare-*.zip` |
| **Uber** | uber.com → Privacy → *Download your data* (`Rider/trips_data.csv`) | `python imports/checkins.py ~/Downloads/Uber\ Data` |
| **Bolt** | in the app: Profile → Privacy → *Request a copy of your data*; any ride CSV with pick-up and drop-off coordinates | `python imports/checkins.py ~/Downloads/bolt-rides.csv` |
| **Calendars** (Google, Outlook, Apple) | takeout.google.com → "Calendar" (an `.ics` per calendar); Outlook: *Save calendar* as `.ics`; or straight from the Mac's Calendar app: `mail/tripmail.py events --calendar Work` (run as the tripmail app, which may read calendars) writes `~/.flightmail/events-Work.json` | `python imports/calendar_events.py ~/Downloads/takeout-*.zip` (or the `events-*.json` files) |
| **Bank and card payments** | Revolut: Statement → CSV; ING, ABN AMRO, Rabobank, bunq: *Download transactions* as CSV | `python imports/bank.py ~/Downloads/*.csv` |
| **Spotify**: every song you played, and the country you played it in | Account → Privacy → *Download your data* → **Extended streaming history** (it comes within 30 days) | `python imports/spotify.py ~/Downloads/my_spotify_data.zip` |
| **Apple Health**: workouts with their routes, steps | Health app → your picture → *Export All Health Data* | `python imports/health.py ~/Downloads/export.zip` |
| **GitHub**: every commit you made, with its computer's clock | nothing to download: the GitHub CLI signed in (`gh auth login`) | `python imports/github.py` (on the Mac that runs Cairn: then every night by itself) |
| **Apple Wallet**: boarding passes, train and bus tickets, tickets to events | nothing to download on the Mac that runs Cairn: iCloud keeps every pass there, the expired ones too (`wallet_dir`); from a phone that shares no Wallet with it, a pass → ⋯ → *Share* | Settings → Imports → 🎫 Apple Wallet, the `.pkpass` files |
| **OV-chipkaart** | ov-chipkaart.nl → Mijn OV-chip → card → *Reishistorie* → CSV (18 months back at most; per card) | `python imports/ovchipkaart.py ~/Downloads/reizen*.csv` (sends to Cairn) |

Add `--send mini:repos/contrail/data/<file>.json` to copy the result to the Mac that runs Cairn. What they give:
- **📍 Check-ins** (`data/checkins.json`): places you were at a known time, a map layer of their own, counted for your towns, countries and trips like the rest. Those you were not at (a page's posts about an event you joined from afar, a friend's tag uploaded days later) go in `data/checkins.not-there.json`, as `"<unix time>|<name>"`, and count for nothing. A photo's own time and place come first, else its post's. Uber and Bolt give where each completed ride began and ended. Importing a source again replaces what it gave before; the other sources' stay. Posts with a place added later in one go (three or more within an hour, over 300 km apart) show on the map, marked so, but are not counted for their day. A place Facebook put in the wrong town can be put right in `data/checkin_fixes.json` (`{"name as Facebook gives it": [lat, lon]}`), kept over each import.
- **💼 Work trips** (`data/calendar.json`): events that last a day or more or have a place, each once (a repeating meeting only by its first). A trip with a work-like event (a conference, workshop, symposium, project meeting, defence, summer school…), or an event of several days in one of its towns, gets 💼 in the Trips list and the events under its name.
- **Card payments** (`data/transactions.json`, card payments and cash withdrawals only, not transfers or salary): a trip's page adds **Paid by card and cash**, in euros on each day's rate. **+ Add → 💡 To check → Payments abroad no trip explains** lists the payments in a country (from the payment's description, "… MADRID ESP", or its currency) on days nothing else puts you there: trips that may be missing. Left out: payments to online shops and services (hosting, airlines, booking sites, conference fees, visas), and payments within 3 days of a trip Cairn has (the country read from a shortened shop name is often wrong, "DSB Kastrup AUT", and a payment can be booked a day or two late). ✕ one that was a purchase online.
- **🎧 Spotify** (`data/spotify.json`): each day's country (where the phone or computer was connected from; plays made offline left out) lists **+ Add → 💡 To check → Days abroad on Spotify no trip explains**: days with 3 or more plays in a country nothing else in Cairn puts you in, not on a trip Cairn has or a day either side (a change of planes, a phone on the next country's network); ✕ one that was a VPN or someone else on your account. Its songs (played 30 s or more) count on towns' and trips' pages on the days Last.fm has none.
- **❤️ Apple Health** (`data/health.json`): workouts of the iPhone, the Watch and the apps that write to Health, with their routes, in the Sports tab and on the map; one Garmin or Strava has too is left to them (started within ten minutes; or as long and whole quarter hours off, as Garmin Connect writes some in the wrong time zone), and so is everything Garmin Connect wrote to Health. Its steps and floors fill the days Garmin has no steps for.
- **💻 GitHub** (`data/github.json`; the repositories' commits, no files, cached in `~/.cache/cairn-github`): every repository GitHub counts your contributions in, each commit by you once (by your account's emails and name). A commit keeps its computer's clock offset, so its day is the day where you were, and it counts in the town Cairn has you in that day. **Stats → Where you write code**: commits by country, town, year, hour on your clock and weekday, the trips you coded most on, the farthest from home and the commits made **in the air** (between a flight's take-off and landing, on a clock of either end). A trip's page adds **Code** (and 💻 on its days), a town's and a country's **Code written here**; the map a **💻 Code** layer, a pin per town with the commits made there in the period shown, or a heatmap (the 💻 button on the map switches). A commit whose clock is not the time zone you were in came from another computer (a server, a job at home while you were away): counted, but in no place. Where `data/github.json` is, Cairn fetches the new commits every night at 04:00.
- **🎫 Apple Wallet** (read as it is, never written): a boarding pass's barcode is the same for every airline (IATA's): the route, the flight, the seat and the booking code. Those that match a flight Cairn has (the same route a day either side; the few with no year on them by their day of the year) give it its **seat**, cabin and **booking code** in one go from **+ Add → 💡 To check → Your Wallet** (only where the flight has none; `flights.json` copied to `data/backups/` first), shown in the Flights tab. The rest of yours are **Boarding passes with no flight**: Add, ✕ when cancelled, or **Move** when Cairn has the flight a few days off (a wrong day, or a rebooking). Train and bus tickets on days Cairn has no train or bus like them are listed the same way. Passes in a name that is not one of your `passenger_names` (the people you travel with) only match. Tickets to concerts, films, museums and events show on their trip's page (**Tickets**, and the day in Days at a glance) and in On this day.
- **OV-chipkaart** journeys become trains (a station's name alone) and buses, trams and metros (a stop with its town: "Delft, Station"), counted per route and year: a daily commute is one line with how many times you took it, known to the year, so it makes no day of its own. Sending the file again updates the counts.

### Fix

**+ Add → 🩺 Fix** lists what looks wrong, each with its fix, or **Fine** to set it aside for good:
- **stays that copy another** (the same nights and place, from two sources: a booking email and the Booking.com export, a Couchsurfing request and its confirmation): **Remove the copies** keeps the one that knows most (its position, hotel, price) and deletes the others for good;
- **stays booked for the same nights** in different places (one cancelled, or a plan): keep the one you slept in (a night with a host, Couchsurfing, BeWelcome or Trustroots, comes first: it is kept before a hotel or Airbnb booked for the same night);
- **nights with no stay, where your runs and rides start**: a run, walk or ride that starts and ends at one spot mostly starts where you slept, and a ride from one place to another (a bike tour) leaves one bed in the morning and reaches the next in the afternoon, so nights away from home that no stay covers, with such spots, are offered as a stay there (one per run of nights at the same spot; a morning loop, or a one-way ride's start, counts for the night before, unless a flight, train or drive left from more than 50 km away earlier that day (up at five for the airport, the run after landing), a one-way ride's end in the afternoon for that night; a run of nights is not carried across a night with a loop elsewhere). Name the town or hotel, pick what it was (a friend's place, family, a hostel, Couchsurfing, …, which puts it in that layer of the map) and **Add stay**, or ✕; 📍 opens a small map at the spot, where you drag the marker (or click) to where you slept. Spots near your home places, spots you ran from for months (where you lived), a lone loop within 100 km of those, a lone hike out of town (a trailhead), a spot only one one-way ride gives (it may end at a station) and, near home, one only one-way rides give (a day's ride out, home by train) are left out, and so are swims, skiing and paddling;
- **trips and stays with no place found**: correct the name and look it up again;
- **trains and buses drawn straight**: look them up again;
- **flights without their airline's code** ("151" for "S4151"; **All fine** sets the whole list aside at once, for old flights with nothing to find their code by);
- **flights that do not follow on**: the same flight twice on a day (a copy, or booked twice), or one leaving from more than 300 km away from where the one before it landed within 36 hours, with no train, bus or drive in between (a rebooking whose old flight stayed, one not flown, or a connection a day off): ✕ deletes the one you did not take.

### Adding by hand, and from your photos

**+ Add** in the top bar adds what your emails, Garmin and photos do not know:
- **✈️ Flight**: by flight number and date, or by hand (below).
- **🚆 Train, bus, ferry, 👍 hitchhiking, 🚙 by car or 🚡 cable car**: from and to (towns, stations or ports, found like the others: see [Ground trips](#ground-trips)), and when, as well as you remember it: a day (and time), a month, or only a year. A trip known only to the month or year gets its line on the map and its distance counted, but no day is made up for it (it does not count for towns, countries or trips). **Times taken** makes one entry stand for a trip you made many times (each way), and **and back** adds the way back.
- **🏨 Stay**: where, from and until, and what (hotel, hostel, flat, friends, family, camping, Couchsurfing).
- **💡 To check**: trips your to-dos say you made (a "trip to X" to-do done in Things where nothing in Cairn puts you within 300 km of X in the 200 days either side), the trains, buses and ferries of your trip docs not on the map (`data/tripdoc_rows.json`), the albums below, and your photos, in the order you took them, put you in towns; where they jump from one town to another far away (60 km or more, within 6 days, at a speed a train or bus could do) and no flight, train, bus, ferry or ride of yours connects them, that leg is listed, grouped into journeys, with the last photo before and the first after. Choose how you went and **Add**, or **✕** when it was no trip (a photo's place is wrong, you drove); **None of these** for a whole journey. A flight opens the flight form with its date. Moves inside your home countries (to work, to family) and on days with a rental car are left out; your answers are kept in `data/suggestions.dismissed.json`. The older your photos in the index, the further back this reaches (see [The map](#the-map), Photos).

  Above them, **albums that say where you went**: old photos often have no place (and Google's export can give them the day they were uploaded instead of taken), so the moves cannot show; an album's name still says where and when ("Saint Petersburg - 2009", "Crimea 2011", "GA of EMA in Krakow"). Each album (of the Photos library, `data/photo_albums.json` from `imports/photos.py --albums`; else of the Google Takeout folder set as `takeout_photos_dir` in `config`, e.g. `"~/Takeout/Takeout/Google Photos"`) whose photos mostly have no place is listed with its cover, the number of photos, its dates when they look real, and the place and year its name gives: the place is looked up once in the background (Photon; only a place of exactly that name, the most specific one the name holds, Chernihiv before Ukraine; everyday words such as Autumn, Christmas or Gigs are not places), kept in `data/albums.json`. Albums for a place and year your flights, trains or stays already cover are left out. Fill in where you came from (and correct the place or year), choose how, and **Add** makes the trip there and back, known to the year.

  Then **where your albums' photos are**: every album's photos with no place of their own go on the map (the 📷 layer, "placed by its album" in their popup) at the town its name gives (a country or region is too vague: those wait for you), or where you put them: **Put it in…** (type a town, pick it), **Not a place**, **Reset**, or **Photos…** to tick some of its photos and put them in another town (an album "Paris, Toulouse, Pyrenees"). Your choices are kept in `data/album_places.json`. An album's dates count as the photos' own unless most of it falls on a day most of several albums fall on (the day Google got them): then its photos keep only the album's year, show in that year and make no day in towns, countries or trips.

**💡 To check** also lists **gaps**: trips abroad with no flight, train, bus, ferry, ride (20 km or more) or rental car around their first or last day (how did you get there or back?), and **quiet stretches** of 30 days or more nothing in Cairn has a place for. Add what is missing, or ✕ (a lift, your own car, a month at home).

With those imports, **💡 To check** also lists the [days abroad on Spotify](#more-of-your-life-data-downloads) no trip explains and **Your Wallet**: seats and booking codes for your flights, and boarding passes and tickets Cairn has no trip for.

On a phone the tabs scroll sideways (on a small one **+ Add** is a **+**), the cards stand two abreast, a trip's coming week of weather in one row, and the map's **Period** and **Layers** fold behind a button each. Elsewhere the number cards stand in even rows (six in one, eight in two of four). The map's standing labels (your places, the ten towns you spent most days in) never cover each other: where two would meet, the town further down the ten gives way until you zoom in. The tab you open first is drawn before the map, which takes a few seconds with a hundred thousand points; Cairn's bigger answers (the trains' tracks, the flights) are sent gzipped.

### Backup

**Settings → Backup → Download backup** saves everything you imported or added as one file, `cairn-backup-<date>.tar.gz`: flights, trains, buses and ferries, stays (and the ones you deleted), activities and their timed tracks, Strava, sleep and heart rate, photo places and the photo index, Timeline, ride weather, music, the climbs' ways up, trips' road routes and the suggestions you answered (about 14 MB). Not the photos themselves, nor what Cairn downloads or works out again by itself (airports, towns, country shapes, the coast, heights, thumbnails), nor keys and sign-ins (`config`, `secret`, the Strava token). Untick **with sports activities and their tracks** for a smaller one without them (Garmin's and Strava's activities and the rides' timed tracks; about 4 MB). From a terminal:

```
curl -o cairn-backup.tar.gz localhost:3000/api/backup
curl -o cairn-backup-no-activities.tar.gz "localhost:3000/api/backup?activities=0"
```

With `backup_copy_dir` set in `config`, Cairn keeps one there by itself: every 14 days (`backup_copy_days`) a new `cairn-backup-<date>.tar.gz`, and the one before it goes, so only the newest is kept. Point it at a synced folder (OneDrive, iCloud Drive, Dropbox) for a copy off this machine.

**Restore from backup…** puts one back: it checks it is a Cairn backup (only the files a backup holds, each readable), keeps the data as it is now in `data/backups/before-restore-<date>.tar.gz`, then replaces each file the backup has (files it does not have stay as they are; tracks are added). Cairn's service then starts it again to read them; run by hand, start it again yourself. The backup is an ordinary `.tar.gz` with a `manifest.json` saying when it was made and what it holds.

### Adding a flight

1. Click **+ Add** in the navigation bar (✈️ Flight is chosen)
2. Enter the flight number (e.g. `KL1234`) and the departure date
3. Click **Look Up Flight**: AeroDataBox fills in airports, airline, aircraft, distance and duration
4. Check the fields and click **Save Flight**

If the flight is not found (common for old flights), click **Fill Manually**. The minimum is **From**, **To** and **Date**.
A flight already there (the same day, and the same route or flight number) is not added twice unless you say so.

**✎** beside a flight in the list, or beside a trip or stay in its popup on the map, changes it (dates, places, flight number, where you stayed); **✕** deletes it, after asking. A trip or stay whose places change is looked up again.

### Importing from openflights.org

Export your flights from openflights.org as CSV and put the file in the repo folder. Set `csv_backup` in `config` to its file name, delete `data/flights.json` if it exists, and restart the server: the CSV is imported. The standard openflights.org format is understood:

```
Date,From,To,Flight_Number,Airline,Distance,Duration,Seat,Seat_Type,Class,Reason,Plane,Registration,Trip,Note,From_OID,To_OID,Airline_OID,Plane_OID
```

Missing distances are computed from airport coordinates (Haversine formula).

### Sports

The **Sports** tab shows your sports activities, cycling and running first (pick another sport, all sports, or a year at the top; the cards, the day calendar, the start times, the histograms, records and best efforts follow both; the per-year charts and tables show every year).
- **Cards**: activities and days out, distance (per sport), moving time, climbing (in Everests), **Eddington numbers** for cycling and running (the biggest E such that you rode or ran E km on E days, and how many more days the next one needs), the longest streak of days in a row, and explored tiles with the max square and cluster.
- **Distance per year**, cycling and running side by side.
- **Year race**: the distance through each year, day by day: the year picked (else the latest) in the accent colour, your best year in the sport's colour, the others muted.
- **Every day of a year**: a square per day, the darker the further you went; hover for the day.
- **When you go out**: weekday against hour of the start, the bigger the dot the more activities.
- **Eddington number**: days with at least n km against n, around E, where the bars cross the line.
- **Explored tiles** month by month, and the **max square** at the end of each year.
- **How far you go**: a histogram of distances per sport.
- **Records** per sport: longest, most climbing, longest moving time, fastest average (rides of 20 km or more, runs of 5 km or more, no trainer rides), highest average heart rate, most kudos, biggest week, month and year, longest streak. Click an activity to see it on the map, its route highlighted.
- **Best efforts**: the best average pace of your runs of about 5 km, 10 km, a half and a full marathon, and the best average speed of rides of 50, 100, 160 and 200+ km. Strava's activity list has no splits, so these are whole-activity averages.
- **Year by year**: activities, km, hours, climbing, longest and km a week.
- **Famous climbs** (with cycling shown and any rides): how many of the famous climbs you rode up, by country, which ones and which ways up (✓ / ✗ per way), and the nearest ones still to do from where your rides usually start. Click a column's heading to sort by it (heights, times, popularity and dates highest or latest first; names A to Z; again to turn it round). **Popularity** is in how many languages Wikipedia has an article about the climb (its Wikidata site links), so famous ski resorts rank high too.
- **Where you start** and **Countries**: the towns and countries your activities start in (all years), from GeoNames' towns as for the most visited cities.

Sport colours: orange cycling, violet running, magenta walks and hikes, yellow other sports (validated for colour-blind readers in both themes).

### Importing from TripIt

In **⚙️ Settings → Imports**, click **Import…** on the **🧳 TripIt** row.

- **Calendar link (no credentials):** on tripit.com go to Profile → Account → Email & Calendar, copy the link under *Subscribe to your travel schedule*, paste it into the dialog and click **Import**.
- **OAuth (more complete: cabin class, seat, aircraft):**
  1. Register a developer app at [tripit.com/developer](https://www.tripit.com/developer).
  2. Put its key and secret in `secret` as `tripit_client_key` / `tripit_client_secret`.
  3. Restart the server and click **Authorise with TripIt**.

Existing flights (same date, route and flight number) are never imported twice.

## Data

All flights are in `data/flights.json`, a JSON array; `data/` is gitignored. To back up, copy that file.

| Field | Description |
|-------|-------------|
| `id` | number, assigned by the server |
| `date` | departure date/time (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`, local time) |
| `from`, `to` | departure and arrival airport IATA codes |
| `flight_number` | e.g. `KL1234` |
| `airline` | airline name |
| `distance` | great-circle distance in km |
| `duration` | flight time `HH:MM` |
| `plane` | aircraft type (e.g. `Boeing 737 MAX 8`) |
| `seat`, `seat_type` | seat number; window/aisle/middle |
| `class` | cabin class (`Y` economy, `C` business, `F` first) |
| `reason` | trip reason (`B` business, `L` leisure) |
| `registration` | aircraft registration |
| `trip`, `note` | trip name or ID; free text |

### Ground trips

Trains, buses, ferries and car journeys are in `data/ground.json` (`ground_file`), apart from the flights so they never count in the flight statistics. tripmail adds them from ticket emails, like flights, and only for trips still ahead; older trips can be added with `POST /api/ground`. Cairn then looks each one up once, in the background, and keeps the result in the trip:

1. **Places** from [Photon](https://photon.komoot.io) (OpenStreetMap): towns, islands, stations, ports and airports, near where you were just before (the last flight or trip of the three weeks before), the destination near the departure. A name that is a town in GeoNames is looked up near the biggest town called so itself (not by another of its names: Bethlehem, not Belém): one of 100,000 or more always (Paris, not Paris in Tennessee), a smaller one unless the trip before points elsewhere. Photon's first answer wins, unless a place with exactly that name is bigger (the city Málaga over a house called Malaga), or as big and about as near. A bare "airport" is the airport nearest to the other end. A name that only resembles the result is accepted for typos ("Isntabul"), an unrelated one is not. A trip whose place is not found gets `unplaced` and no line: send a better name, or its coordinates, with `PUT /api/ground/:id`.
2. **Track** from [Transitous](https://transitous.org) (timetables of trains and coaches across Europe and beyond); a past trip is looked up on the same weekday in the coming week, as timetables cover only about a year ahead, and one known only by its day at 10:00 (the trains and buses of such days drawn before as a guess are looked up once more). A leg the timetable has no track for (a regional line in the middle of a long journey) is looked up on its own, so it follows its railway instead of a straight line. When no track is found from the places themselves (a town's middle can be too far to walk to its station), it is tried again from the nearest station, bus station or port at each end. A train no timetable knows (Ukraine, for instance) follows the likeliest railway line instead: OpenStreetMap's main lines within about 25 km of the road between its stations (60 km when those do not connect, then 150 km with the main lines alone; a train of before 2014 also on the main lines closed since (cut by a war or at a border), as those were its way; where two networks still do not meet, every track around the gap, sidings and disused lines too), from [Overpass](https://overpass-api.de) in pieces of about 120 km, and the shortest way along them, worked out by Cairn; else [BRouter](https://brouter.de)'s rail profile, when its public server answers. A best guess, said so in its popup. Buses it does not know, and hitchhiking, follow the roads ([OSRM](https://project-osrm.org)), up to three times the straight line plus 30 km (the road round the mountains is the way, even when it is two and a half times the straight line); a railway's track, and a train put on the road for want of one, at most 2.2 times plus 30 km. A car journey takes the likeliest road through where your photos and Timeline put you on the way (from leaving until arriving; a journey known only by its day, that day): those of them roughly between its ends, 10 km apart, at most 20; with none, the plain road route. After importing more photos, `POST /api/ground/reroute` looks the car journeys' roads up again. The drives on rental-car days (the moves between your photos, activities and stays, see [How towns, countries and trips are built up](#how-towns-countries-and-trips-are-built-up)) count as car journeys too, and are drawn with them on the map. A ferry goes from port to port: of the ferry terminals within 60 km of each end (nearer to it than to the other end), the two closest to each other, a little nearer to their places counting too (Tenerife to La Gomera: Los Cristianos to San Sebastián); then along OpenStreetMap's ferry line where OSRM's car route crosses by ferry, else straight across the water (drawn solid). Otherwise the line is straight and drawn dashed. When Overpass or BRouter turns requests away or is too slow, the trains waiting for them are tried again a few minutes later (each piece of railway Overpass gave is kept in `data/rail/`, so a lookup goes on from where it was); the other trips go on. Overpass is asked one question at a time (overpass-api.de gives each address two slots and turns a third away), at four public servers in turn (overpass-api.de, kumi.systems, private.coffee, mail.ru; the last three given two minutes each, overpass-api.de five). When one turns Cairn away (HTTP 429), that is not an outage: Cairn waits until its status page says a slot is free (at most 5 minutes) and asks the same server again, twice at most, before the next. When none answers, its railway and ferry guesses wait 5 minutes, then 15, an hour, 3 hours and 6 hours while the outage lasts (said once in the log, when it starts and when it ends); when they only time out on a stretch of several boxes at once, that is not an outage, and the boxes are asked for one by one. A trip whose lookup fails for another reason waits an hour, then 6 hours, a day and a week, while the others go on (said once in the log for each reason, also across restarts).

At most one request a second goes to each service; a service that is down is tried again an hour later. `"ground_lookups": false` in `config` turns the lookups off (the trips then have no lines).

| Field | Description |
|-------|-------------|
| `id` | number, assigned by the server |
| `date`, `arrival` | local departure and arrival (`YYYY-MM-DD HH:MM:SS`) |
| `mode` | `train`, `bus`, `ferry`, `drive` (by car), `hitch` (hitchhiking) or `cable` (cable car) |
| `service` | train or bus number, when known |
| `from`, `to` | station or place names as on the ticket or in the calendar |
| `event_id` | the calendar event tripmail made for it |
| `source` | where the trip came from, e.g. `flightmail` (a ticket email; tripmail's older name, kept in the data) |
| `from_lat`, `from_lon`, `to_lat`, `to_lon` | where the two places are |
| `path` | the track as an encoded polyline with 6 decimals; empty for a straight line |
| `path_source` | `transitous`, `rail` (the likeliest railway line), `osrm`, `stops` (along the roads through the stops you named), `clues` (through your photos on the way), `sea` (ferry lines), `cable` or `straight` |
| `distance` | km along the track |
| `approx` | `month` or `year` for a trip added by hand known only that well (`date` is then the 1st of it, and gives no day) |
| `times` | how many trips this one entry stands for (added by hand) |
| `unplaced` | `true` when a place was not found |

### Stays, photos and Timeline

- `data/stays.json` (`stays_file`): hotels, Airbnbs and rental cars, one per booking code: `code`, `what` (`stay` or `car`), `vehicle` (`scooter` for a scooter or moped; a car without it), `provider`, `place`, `country`, `start`, `end`, `type`, `price`, and `lat`, `lon` once found (`unplaced` when not).
- `data/photos.json` (`photos_file`): `[{"lat", "lon", "year", "count", "days"}]`, written by `imports/photos.py`.
- `data/timeline.json` (`timeline_file`): `{"visits": [{"lat", "lon", "start", "end", "name"}], "paths": [{"date", "path"}]}`, written by `imports/timeline.py`.
- `data/garmin.json` (`garmin_file`): `{"activities": [...], "last_sync", "last_full", "error", "error_at"}`, written by `imports/garmin.py`; each activity as for Strava below, with `source: "garmin"`.
- `data/wellness.json`: `{"days": {"YYYY-MM-DD": {"rhr", "steps", "stress", "bb_max", "bb_min", "sleep" (s), "deep", "light", "rem", "awake", "bed", "wake" (UTC), "score"}}, "last_sync"}`, written by `imports/garmin.py`.
- `data/weather.json`: `{activity id: {"temp", "tmin", "tmax" (°C), "rain" (mm), "wind", "gust" (km/h), "dir" (degrees, where it came from), "code" (WMO)}}`, kept by Cairn.
- `data/lastfm.json`: `{"user", "scrobbles": [[unix time, artist, track, album]], "last_sync"}`, kept by Cairn.
- `data/books.json`: `{"books": [{id, title, author, rating, pages, year, finished, started, added, read_count, reads: [{started, finished}]}], "imported"}`, from your Goodreads export or data download.
- `data/saved_places.json`: `[{"name", "lat", "lon", "list", "note", "url", "address", "saved"}]`, written by `imports/saved_places.py`.
- `data/rates.json`, `data/prep_alerts.json`, `data/tripdoc_rows.json`, `data/albums.json`, `data/albums.scan.json`: euro rates by currency and day; the missing things already sent to the alerts channel; the trip docs' trains, buses and ferries not on the map; album places and the last reading of the albums.
- `data/drives.json`, `data/heights.json`, `data/coastline.geojson`: road routes of a trip's moves, heights of places, the coastline; kept by Cairn, safe to delete (looked up again).
- `data/strava.json` (`strava_file`): `{"activities": [{"id", "name", "sport", "date", "start", "distance", "moving_time", "elevation", "path"}], "last_sync", "last_full"}`, `date` in the activity's local time, `distance` in km, `elapsed_time`, `heartrate` (average, when recorded), `prs`, `kudos`, `commute`, `trainer`, `path` an encoded polyline with 6 decimals, `at` its first point, `tiles` the zoom-14 tiles it passes through (x × 16384 + y). `data/strava_token.json` (`strava_token_file`): the sign-in token.

Moving to MongoDB later only needs the data layer in `app.js` (the `flights` array, `saveFlights()` and `init()`) replaced by a Mongoose model; the API routes stay the same.

## API

Answers of 16 kB or more go out gzipped to a client that asks for it (`Accept-Encoding: gzip`, as browsers do); smaller ones, and all for a client that does not, as plain JSON.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/flights` | all flights as a JSON array |
| `GET` | `/api/airports` | airport metadata for the airports in your flights |
| `POST` | `/api/flights/lookup` | look up a flight by number and date via AeroDataBox: `{ "flight_number": "KL1234", "date": "2026-11-16" }` (the day it leaves) → airports, airline, aircraft, distance, duration, local departure and arrival times |
| `POST` | `/api/flights` | add a flight (at least `from`, `to` and `date`); the distance is computed when missing. One already there (same day, same route or flight number) is refused with `409` and the one found, unless `force: true` |
| `PUT` | `/api/flights/:id` | change fields of a flight; the distance is recomputed when the route changes |
| `DELETE` | `/api/flights/:id` | delete a flight |
| `GET` | `/api/ground` | all trains, buses, ferries and car journeys |
| `GET` | `/api/drives` | the drives on rental-car days Cairn worked out, as car journeys (the first time after a start takes about half a minute) |
| `POST` | `/api/ground/reroute` | look the roads of every car journey (`{ "mode": "drive" }`, the default) up again, through the photos now known; `{ "ids": [112] }` those trips |
| `POST` | `/api/ground` | add a trip (at least `mode`, `from`, `to` and `date`); a trip with the same `event_id`, or the same departure minute and mode, is updated instead |
| `PUT` | `/api/ground/:id` | change fields of a trip; a new place name or position is looked up again |
| `DELETE` | `/api/ground/:id` | delete a trip |
| `GET` | `/api/stays` | all hotels, Airbnbs and rental cars |
| `POST` | `/api/stays` | add a stay or rental car (at least `code`, `place` and `start`); one with the same `code` is updated instead, and a rental car takes over the one added by hand for the same days (`ignored` for a counter contract of a car already there) |
| `PUT`, `DELETE` | `/api/stays/:id` | change or delete one; a new `place` or `country` is looked up again. A deleted stay's code is kept in `data/stays.removed.json`, so a mail sending that booking again (the history import) does not bring it back |
| `GET` | `/api/photos`, `/api/timeline` | the files the import scripts wrote (empty when there are none) |
| `GET` | `/api/photos/points` | every photo in `data/photo_points.json` as `[id, unix time, lat, lon, video]` (gzip) |
| `GET` | `/api/photos/unplaced` | the photos with no place not placed yet, `{photos: [{id, t, name, albums, video}], albums, days: {day: town Cairn has you in}, placed}` |
| `GET` | `/api/photos/unplaced/:id/thumb`, `/api/photos/unplaced/:id/full` | one of them as a JPEG |
| `GET` | `/api/photos/auto` | how many Cairn can place by itself, `{near, day, between, total, placed}` (`?list=1`: each with its guess) |
| `POST` | `/api/photos/auto` | places them (`{undo: true}`: takes all of Cairn's own places back) |
| `POST` | `/api/photos/place` | `{ids, lat, lon, name}` places those photos there; `{ids, undo: true}` takes the places back |
| `GET` | `/api/photos/:id/thumb`, `/api/photos/:id/small`, `/api/photos/:id/full` | a photo as a JPEG at most 360 px, at most 220 px (for the report), or whole (made with `sips`, kept in `data/photo_cache`); a video's first frame, or the video |
| `GET` | `/api/climbs/:id/photos` | the photos taken going up a climb: `id`, `t`, `lat`, `lon`, `video`, `ride`, `way` |
| `GET` | `/api/climbs/:id/gpx?from=lat,lon&name=` | a GPX of a bike route from a place (a stay, within 150 km) to the climb's top and back |
| `GET` | `/api/weather` | the weather on every ride looked up, by activity id |
| `GET` | `/api/wellness?from=&to=` | Garmin's days: sleep, resting heart rate, steps, stress, Body Battery |
| `GET` | `/api/music?from=&to=`, `/api/music/status` | the top artists and tracks of a period, with the most played track per day; whether Last.fm is set up and how many scrobbles are kept |
| `POST` | `/api/music/sync` | fetch the new scrobbles now |
| `GET` | `/api/books?from=&to=`, `/api/books/status` | the books finished in a period, newest first, each with where you were (`at`, `town`, `stay`); how many are kept |
| `POST` | `/api/books/import` | a Goodreads library export or data download (the CSV or the zip as the body); replaces the books kept, keeping what only the other kind knew |
| `GET` | `/api/imports` | the imports in Settings: each source with how its last import went (`last`), whether one runs, when its data last changed |
| `PUT` | `/api/imports/:source/:batch?name=` | one file of a data download (the body); `batch` 8–32 lowercase letters and digits |
| `POST` | `/api/imports/:source/:batch` | read the batch's files with the source's import, in the background |
| `GET` | `/api/backup?activities=0` | everything you imported or added, as a `.tar.gz` (see [Backup](#backup)); `activities=0`: without the sports activities and their tracks |
| `GET` | `/api/backup/summary` | what a backup would hold now: `files` (`name`, `bytes`), `tracks` |
| `POST` | `/api/backup/restore` | a backup (the `.tar.gz` as the body) back in place: `created`, `files`, `tracks`, `before` (the data before, in `data/backups/`), `restarting` |
| `GET` | `/api/coming` | the coming trips with their `flights` (and `checkin`), `stays`, `cars`, `ground`, `missing` (`kind`, `key`, `text`, `when`, `todo`), `todos`, `weather`, `climbs`, `saved` |
| `GET` | `/api/spending` | what the stays cost: `eur`, `nights`, `perNight`, `byYear`, `byCountry`, `byTown`, `byProvider`, `dearest`, `cheapest`, `priced` of `stays` |
| `GET` | `/api/review/years`, `/api/review/:year` | the years with anything in them; a year in review |
| `GET` | `/report?from=&to=&photos=0` | the report as a page to print (see [Report (PDF)](#report-pdf)): years from and to, without photos |
| `GET` | `/api/report.pdf?from=&to=&photos=0` | the same as a PDF (`cairn-<date>.pdf`), made by Chrome; 501 without one, 409 while another is being made |
| `GET` | `/api/review/by-year` | every year side by side: days, days away, trips, countries and towns (and new), distance by means, nights by kind of bed, photos, first climbs, € |
| `GET` | `/api/suggestions/gaps` | trips abroad with no way there or back (`unreached`), and runs of 30 days or more with no place (`quiet`) |
| `GET` | `/api/wishlist` | `saved` places, `climbs` to ride near where you go, `countries` still to go |
| `GET` | `/api/health` | what looks wrong: `copies`, `twice`, `unplaced`, `straight`, `flights`, `clashes` (flights that do not follow on), `photoJobs`, `bases` (nights with no stay where your runs and rides start) |
| `POST` | `/api/health/dedupe` | remove the stays that copy another |
| `POST` | `/api/ground/:id/retry`, `/api/stays/:id/retry` | look a trip's or a stay's place (and track) up again |
| `GET` | `/api/suggestions/todos`, `/api/suggestions/tripdocs` | trips your to-dos mention that nothing else knows; trip-doc rows not on the map |
| `GET` | `/api/suggestions` | legs your photos show and nothing else connects (a flight connects towns up to 100 km from its airports, a train or bus two towns its line passes within 20 km; each photo's day is the local one; photos taken from a plane, on the way of a flight within a few hours of it, are left out): `from`, `to` (towns, with ids, countries and places), `from_day`, `to_day`, `km`, `hours`, `photos` (counts), `last_photo`, `first_photo`, `mode` (a guess), `key` |
| `POST` | `/api/suggestions/dismiss` | `{ "key" }`: that leg (or album) was no trip |
| `GET` | `/api/suggestions/albums` | albums whose photos have no places: `key`, `album`, `photos`, `placed`, `place`, `year`, `first`, `last`, `lat`, `lon` (`{ "pending": true }` while they are read) |
| `GET` | `/api/suggestions/albums/cover?key=` | an album's cover photo, small |
| `GET` | `/api/curiosities` | the curiosities (`{ "pending": true }` while the first ones are worked out) |
| `GET` | `/api/trips` | the trips, newest first: `id` (the first day), `start`, `end`, `name`, `days`, `nights`, `countries` (`cc`, `days`), `towns`, counts of `flights`, `ground`, `activities`, `photos`, its `cover` (a photo id or `null`) and `route` (the town of each day, `[lat, lon]`) |
| `GET` | `/api/trips/:id` | one trip in full: as above plus its `flights`, `ground`, `stays`, `activities`, `photo_ids`, `moves` (`kind` `drive`, `road` or `move`, `km`, `t0`, `t1`, and `path` or `from`/`to`), `roads_pending`, `photos` (`[id, t, lat, lon, video]`), `body` (sleep and resting heart rate on the trip and the month before), `music`, `books`, `tickets`, `code` (`commits`, `days`, `repos`, `byDay`) and `dayList` (with each day's `body`) |
| `GET` | `/api/settings` | `home_airports`, for the trips on the map, and `home`: your places (`hometown`, `residence`, `work`, each `{ id, name, cc, lat, lon }` or `null`); `commutes`, `onthisday_discord` |
| `GET` | `/api/onthisday?date=` | the years before on that date (today by default), newest first: `day`, `years`, `trip`, `towns`, `flights`, `ground`, `stay`, `activities`, `photos`, `photo_ids`, `song`, `books`, `tickets` |
| `PUT` | `/api/trips/:id/cover` | `{ photo }`: the trip's cover photo, or `null` for Cairn's own choice |
| `GET` | `/api/trips/:id/export/:format` | the trip as a file: `kml`, `gpx` or `html` (a page to share) |
| `GET` | `/api/suggestions/spotify` | days abroad on Spotify no trip explains: `country`, `first`, `last`, `days`, `plays` |
| `GET` | `/api/suggestions/wallet` | your Wallet against Cairn: `passes`, `matched`, `flights` (boarding passes with no flight: `day`, `time`, `from`, `to`, `flight_number`, `seat`, `booking`, `close`: the flight Cairn has a few days off), `ground` (tickets with no trip), `fill` (`flights`, `seats`, `bookings` the passes would add) |
| `POST` | `/api/wallet/fill` | the seats, cabins and booking codes of your boarding passes into the flights that have none: `{ flights }` |
| `GET` | `/api/code` | your commits by place (`null` before imports/github.py): `commits`, `repos`, `first`, `last`, `placed`, `elsewhere` (another computer's clock), `awayCommits`, `countries` and `towns` (`commits`, `days`, `repos`), `years` (`commits`, `away`), `hours`, `weekdays`, `trips`, `air` (`flight`, `commits`, `repos`), `farthest`, `zones` |
| `GET` | `/api/code/places` | your commits by town and day, for the map: `day`, `id`, `name`, `cc`, `lat`, `lon`, `n`, `repos` (commits per repository) |
| `GET` | `/api/music/places` | your plays by day in the town you were in, for the map: `day`, `id`, `name`, `cc`, `lat`, `lon`, `n`, `artists` (the three played most) |
| `GET` | `/api/wallet/tickets?from=&to=` | tickets to events: `day`, `time`, `title`, `venue`, `org`, `at` |
| `PUT` | `/api/home` | set your places: `{ "hometown": <GeoNames id>, "residence": …, "work": … }`; `null` clears one, a role left out stays |
| `GET` | `/api/towns?q=` | towns whose name starts with `q`, biggest first (at most 10): `id`, `name`, `cc`, `lat`, `lon`, `pop` |
| `GET` | `/api/activities` | all sports activities, Garmin's and Strava's, each once (gzipped when asked, `304` when the browser has them) |
| `GET` | `/api/activities/status` | how many activities; Garmin's count, last sync and error; Strava's state |
| `GET` | `/api/strava/status` | whether Strava is set up and connected, how many activities, the last fetch and error |
| `GET` | `/api/cities?from=&to=` | every town visited in the period, most visited first (dates `YYYY-MM-DD`, both optional): `id` (GeoNames), `name`, `country`, `lat`, `lon`, `days`, `visits`, `first`, `last` |
| `GET` | `/api/country/:id?scheme=` | one country for its page, as a list counts countries (`scheme`: `iso`, the default, `un` or `tcc`): `:id` an ISO code or a place id of that list (an ISO code under another list: its place with most of your days in that country): `id`, `scheme`, `cc`, `name`, `shape`, `days`, `first`, `last`, `visits`, `towns`, `trips`, `flights`, `ground`, `stays`, `activities`, `photos`, `climbs`, `code`, `music` |
| `GET` | `/api/city/:id?from=&to=` | one town (GeoNames id, as `/api/cities` gives it) for its report page: `town`, `days`, `first`, `last`, `visits` (`start`, `end`, `days`), and the `stays`, `flights` (with `direction` `in` or `out`), `ground`, `activities`, `photos` (`day`, `count`) and `timeline` places there; `code`: your commits there (as on a trip) |
| `GET` | `/api/activity/:id` | one activity for its page: `id`, `name`, `sport`, `date`, `start`, `end`, `distance`, `moving_time`, `elapsed_time`, `elevation`, `heartrate`, `path`, `from` and `to` (towns), `loop`, `profile` (from its timed track: `points` with `km`, `s`, `alt`, `kmh`, `hr`, `w`; `km`, `maxKmh`, `hr`, `power`, `alt`), `weather`, `climbs`, `photos`, `music`, `trip`, `day` (sleep and heart rate) |
| `GET` | `/api/climbs` | the famous climbs with what you did on them ([] without rides): `id` (Wikidata), `name`, `country`, `lat`, `lon` (the road's high point once known), `ele`, `wiki`, `times`, `first`, `last`, `rides` (the newest 20: `id`, `date`, `name`), `ascents` (`from`, `length` km, `gain` m, `grade` %, `path`, `times`, `rides`, your `efforts` and `best`, predicted times `you` and `pro`, and the `record` from `climb_records.json`: `seconds`, `rider`, `year`, `event`, `measured`, `source`), `other` (ways up not among them: `via`, `times`, `rides`), `records` (best known times from a start that fits none of the ways up) |
| `GET` | `/api/sites` | `{ unesco: [...], park: [...] }`: every World Heritage site and national park, each `id` (UNESCO's number; a park's Wikidata id), `name`, `cc`, `year` (inscribed), `pts` (`[lat, lon, reach m]` of each place), `days` you were there and `at` (the place you came to) |
| `GET` | `/api/regions?scheme=&from=&to=` | the countries visited in the period, as the list `iso`, `un` or `tcc` counts them: `scheme`, `total` (countries on the list), `places`: `id`, `name`, `region` (TCC), `days`, `first`, `last`, `shape` (GeoJSON outline) |
| `GET` | `/api/countries/years` | `years`, `rows` (per country: `cc`, `home`, `total`, `byYear`), `abroad` (days per year) and `schengen` (`today`, `limit`, `window`, `peak`, `home`, `since`) |
| `GET` | `/api/countries?scheme=&from=&to=` | per country: `days`, `visits`, `towns`, `nights` in stays, `flights` in, `train`, `bus`, `ferry` from or to it, `cars`, `activities` and their `km`, `photos`, `first`, `last`; by the town's country code, or as `scheme` counts countries |
| `GET` | `/api/activities/places` | where activities start: the towns and countries per kind of sport (`ride`, `run`, `walk`, `sport`, `all`) |
| `POST` | `/api/strava/sync` | fetch new activities from Strava now |
| `GET` | `/auth/strava` | sign in to Strava (redirects back to `/auth/strava/callback`) |

## Tests

```
npm test                       # Cairn API (against a temporary copy with its own data) and its modules (trips, ground, books, uploads, report…), no network
python mail/test_parse.py      # reading emails (the fixtures in mail/fixtures)
python mail/test_ground.py     # trains, buses and ferries, station time zones
python mail/test_sync.py       # the change, rebooking, cancellation and duplicate rules
python mail/test_plan.py       # check-in to-dos, busy blocks, trip banners
python mail/test_stays.py      # hotel, Airbnb and rental car emails
python mail/test_tripdocs.py   # trip docs, against a fake Google Docs
python mail/test_tripmail.py # entry point, Cairn client, stays sent to Cairn, alerts
python imports/test_imports.py # photo places, Google Timeline and Garmin, on made-up exports (the Garmin activity file needs: uv run --with fitdecode python imports/test_imports.py)
```

The Python tests need no network, Gmail or calendar, and no pytest: each file runs on its own and prints `OK n tests`.

## Privacy

This repository is public, so nothing personal is committed:
- `config`, `secret` and `data/` are gitignored, along with tripmail's files in `~/.tripmail/`.
- The test emails in `mail/fixtures/` are anonymised copies of real layouts. Names, booking codes, agency numbers, flight numbers, routes, dates, prices and links are replaced with fake ones (`Jan Testers`, `ABC123`, `example.com`).
- tripmail reads the mailbox read only and keeps no copy of any email.
- For the suggestions, the text of a coming trip's doc (places, dates, accommodation types, prices, your notes and comments, flight numbers; no links or booking codes) goes to Anthropic through Claude Code. `"trip_suggestions": false` stops that.
- Garmin and Strava activities are kept in `data/` on your Mac, like the rest; nothing is sent back to Garmin, Strava or elsewhere. The Garmin token in `~/.garminconnect` and the Strava token in `data/` are readable by you only.
- Photos and Timeline stay on your own Macs: the photo script sends only places rounded to about 1 km with counts and days, and both files live in `data/` (gitignored). Your Timeline's places and paths are as personal as data gets; keep `data/` out of any shared folder.
- For the lines of trains, buses and ferries and the places of stays, Cairn sends their place names to Photon (photon.komoot.io) and their positions and departure times (of the coming week, for past trips) to Transitous (api.transitous.org) and OSRM (router.project-osrm.org), once per trip. `"ground_lookups": false` stops that.
- For the prices in euros, tripmail fetches the day's exchange rates from open.er-api.com, once a day; nothing about you or the trip is sent.

## Troubleshooting

**airports.dat download fails on first run.** Download it by hand:
```
curl -o data/airports.dat https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat
```
Without it the map still renders, but without route arcs and airport markers.

**"No RapidAPI key in secret file".** `secret` is missing or has an empty `rapidapi_key` (see [AeroDataBox key](#3-aerodatabox-key-optional-recommended)).

**Port already in use.** Change `port` in `config` and restart.

**CSV import does not find the backup.** `csv_backup` must match the exact file name, which must be in the repo folder.

**tripmail: "Empty username or password" or "AUTHENTICATIONFAILED".** Set `gmail_user` in `config` and a valid `gmail_app_password` in `secret`. A normal Google password does not work over IMAP.

**tripmail: "No calendar access".** Run the dry run once with the screen unlocked and click Allow. Otherwise allow tripmail in System Settings → Privacy & Security → Calendars. Never rebuild `tripmail.app`: a new signature needs a new Allow.

**tripmail: "Expected one calendar".** `calendar_account` and `calendar_title` must match macOS Calendar exactly; `mail/tripmail.py calendars` lists them.

**tripmail missed a booking.** Look for a "could not read" alert or the email's line in `run.log`. If the email has no flight words at all, widen `gmail_query`.

## Support Cairn

Cairn is free and stays free. If it is useful to you and you would like to give something back, you can
[sponsor it on GitHub](https://github.com/sponsors/bazilinskyy) (monthly or once) or
[buy me a coffee on Ko-fi](https://ko-fi.com/bazilinskyy). Bug reports, ideas and pull requests help just as much.

## Acknowledgements

Cairn stands on open data and open software: [OpenStreetMap](https://www.openstreetmap.org) and its contributors, [Photon](https://photon.komoot.io), [Transitous](https://transitous.org), [BRouter](https://brouter.de), [OSRM](https://project-osrm.org), [Open-Meteo](https://open-meteo.com), [Natural Earth](https://www.naturalearthdata.com), [GeoNames](https://www.geonames.org), [OpenFlights](https://openflights.org), the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), [Wikidata](https://www.wikidata.org), [Leaflet](https://leafletjs.com), [MapLibre GL](https://maplibre.org), [deck.gl](https://deck.gl), [Chart.js](https://www.chartjs.org), [Express](https://expressjs.com) and [osxphotos](https://github.com/RhetTbull/osxphotos).

## License

[MIT](LICENSE) © 2026 Pavlo Bazilinskyy. Use it, change it and share it; keep the copyright notice. Issues and ideas are welcome.
