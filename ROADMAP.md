# Roadmap

A growth path. Each phase is a discrete chunk of work — the v0 architecture (JSON file + adapters) carries you through v1 without rewrites.

## v0 (now)

Personal aggregator. JSON file as the data store. Daily ingest committed to the repo. One simple page rendering events grouped by day.

- 51 sources defined; ~4 enabled by default (Patch towns)
- 5 adapters: `ical`, `rss`, `eventbrite`, `patch`, `html-generic`
- Static Next.js page reading `public/events.json` at build time

**Open work in v0:** tune selectors per source, switch HTML scrapes to iCal where feeds exist, find correct Eventbrite organizer IDs for the venues that matter most.

## v1 — Filters

Same JSON, more useful. No DB yet.

- Client-side filters: town, category, date range, free-text search
- "This weekend" / "Next 7 days" quick filters
- Per-source `enabled: true/false` UI for personal curation (still committed via PR for now)

The data layer doesn't change — filtering happens entirely client-side off the same `events.json`.

## v2 — Database

When `events.json` outgrows JSON (probably once you exceed a few thousand active events, or want historical retention).

- SQLite via Turso, or libSQL embedded
- Replace `public/events.json` write with DB upserts keyed on `event.id`
- Ingest still runs as a script; only the write target changes
- Adapters don't change at all
- Add API routes (`app/api/events/route.ts`) for the page to query

## v3 — Email digest

Once you have stable data and curation.

- Subscriber model (DB table)
- Weekly digest email (Friday morning) of the upcoming weekend
- Provider: Resend or Buttondown — both are simple HTTP APIs
- Triggered via a second GitHub Actions workflow

## v4 — Light curation tools

- Per-event "hide" / "feature" flags stored in DB
- Tag overrides (so you can re-categorize events)
- Source health dashboard (last successful ingest, count over time)

## Things to defer

- Native mobile app — RSS/iCal output from this site is sufficient.
- User accounts. Email-only subscriptions are enough for v3.
- Map view. Tempting, but most MetroWest events cluster in 5 towns; a list grouped by town is more useful and cheaper.
- ML/NLP event extraction from news articles. Returns are low for personal scale.
