# DESYtrack

A full-stack web application for tracking **physical lab / material samples** through their
lifecycle, with **role-based collaboration** between an internal team and external industry
partners. Every sample carries a name, status, custodian, tests, and an immutable
chain-of-custody audit trail.

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite via Node's built-in `node:sqlite` — zero-config, file-based, **no native build tools required**; schema is portable to PostgreSQL
- **Auth:** JWT bearer tokens + bcrypt password hashing
- **Frontend:** single-page app in vanilla JS/HTML/CSS — **no build step**

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

Requires **Node.js 22 or newer** (uses the built-in `node:sqlite` module). On Windows
PowerShell, if `npm` is blocked by the script-execution policy, use `npm.cmd install` /
`npm.cmd start` instead. The database (`data/sampletrack.db`) is created and seeded
automatically on first run.

## Demo accounts

| Email | Password | Role | Sees |
|-------|----------|------|------|
| admin@lab.test | admin123 | admin | everything; manages users & partner access |
| tech@lab.test | member123 | member | everything; logs samples, tests, statuses |
| partner@acme.test | partner123 | partner | **only** samples explicitly shared with them |

## What each role can do

- **Admin** — full access; create users, grant/revoke partner access to specific samples.
- **Member** (internal staff) — create and edit samples, advance status, log tests, comment (internal or shared).
- **Partner** (external) — read-only view of *only* the samples shared with them; can post *shared* comments; never sees internal comments or unshared samples.

## Key features

- **Accessioning** — auto-generated sample codes (`SMP-2026-0001`).
- **Status workflow** — statuses and their allowed transitions are stored as *data* (a directed graph), so illegal jumps (e.g. `registered → completed`) are rejected by the API.
- **Chain of custody** — an append-only `custody_events` log records creation, status changes, custody transfers, tests, and notes, each stamped with the actor and time.
- **Tests / analyses** — typed results with method reference (e.g. `ASTM D638`) and pass/fail outcome.
- **Row-level partner sharing** — a partner sees a sample only if an explicit `sample_access` grant exists.
- **Dashboard** — live counts by status, scoped to what the user is allowed to see.
- **QR labels & scanning** — every sample shows a printable QR label built from its accession code; the **Scan QR** button opens a sample instantly by camera or USB barcode scanner. QR libraries are bundled locally (`public/vendor/`) so it works offline on the lab network.

### Notes on scanning

- **Camera scanning** needs a *secure context*: it works on `http://localhost` and on any `https://` deployment, but a browser will block the camera on a plain-`http` address other than localhost. Scanning from a **phone** therefore requires the app to be deployed (e.g. on a DESY `https` URL) so the phone can reach it — on `localhost` only the host PC's own webcam is available.
- **USB barcode scanners** work today with no camera: they type the scanned code into the focused box and press Enter. Just click **Scan QR** and scan.
- QR codes encode the bare accession code by default; the app also accepts a QR that encodes a full URL (`…/?code=SMP-2026-0001`), which lets a generic phone-camera app open the record directly once deployed.

## Project layout

```
backend/
  schema.sql   — full database schema (portable SQL)
  db.js        — DB bootstrap + seed data
  server.js    — Express API, auth, RBAC, all endpoints
public/
  index.html   — the entire single-page frontend
data/           — SQLite database file (created at runtime)
```

## Configuration

Environment variables (all optional):

- `PORT` — HTTP port (default `3000`)
- `JWT_SECRET` — **set this in production** (default is a dev placeholder)
- `DB_PATH` — path to the SQLite file

## Moving to PostgreSQL

The schema in `backend/schema.sql` is written in portable SQL with inline notes on the few
Postgres deltas (`BOOLEAN` instead of integer flags, `SERIAL`/`IDENTITY` for auto-increment,
`TIMESTAMPTZ` for timestamps). Swap `node:sqlite` for the `pg` driver and adjust the
auto-increment and `datetime('now')` calls to `NOW()`.
```
