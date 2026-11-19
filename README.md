# KOBWA VOTING PLATFORM: nominations, voting and results

Your single-file prototype, rebuilt as a real system: Flask + SQLite backend, server-side
voting rules, real sign-in, and an audit trail that can be independently verified.
The look and the three areas (Voting portal, Live results, Back-office admin) are unchanged.

## Run it locally

```bash
python -m venv .venv && . .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python manage.py create-admin you@example.org "Your Name"   # prompts for a password
python manage.py seed-demo                                  # optional: sample data + demo voters
python run.py                                               # http://127.0.0.1:5000
```

Everyone signs in with the account an administrator created for them. Accounts start with a
temporary password and must choose their own at first sign-in.

Tests: `pip install -r requirements-dev.txt && pytest` (36 tests: voting rules, open-vote categories, security, audit, uploads, upgrade path).

Upgrading from an earlier copy: just start the new version. The database is upgraded in place.

## Day-to-day use

1. **Admin → Voters → Add person / Import list.** Paste or upload `name,email` lines. The one-time
   temporary passwords are shown once, with Copy and Download CSV. Hand them out securely.
2. **Admin → Categories and nominees.** Create categories (type, votes per person, open/closed). For
   nominee categories, add nominees with photos. Open-vote categories need no setup (see below).
3. Voters select, confirm, and the ballot is final. One ballot per person per category, always.
4. **Live results** refreshes every 5 seconds. Admins can hide or publish results for voters.
5. **Admin → Audit log.** Search, export CSV, and **Verify integrity**.

## Two kinds of category

| | Nominee category | Open-vote category |
|---|---|---|
| Who is on the ballot | Nominees an admin adds (name, bio, photo) | Everyone on the staff list: each voter searches the list and picks a person |
| Set-up | Add nominees | None; people appear automatically |
| Votes per person | 1 to 50, per category | 1 to 50, per category |
| Voting for yourself | n/a | Off by default; optional per category |

The type is chosen when the category is created and cannot change afterwards.

**The staff list is the set of voter accounts** that are active and marked *appears in vote lists*
(Voters tab; imports and new voters are marked by default, administrators are not). Add a
department or job title (third column in the import file, or **Edit**) to tell people with similar
names apart. Anyone you disable or remove from the lists leaves the list immediately; votes they
already received stay counted. Open-vote results list only people who received votes.

## What changed from the prototype, and why

| Prototype | Now |
|---|---|
| Anyone could open the admin tab; "voter" was a dropdown | Real accounts, roles (voter/admin), scrypt password hashes, forced change of temporary passwords, lockout after 5 bad attempts, server-side revocable sessions |
| Votes in `localStorage`; one-vote rule enforced in the browser | Rules enforced in the database transaction: one ballot per person per category, `max votes` honoured, closed categories rejected, nominees must belong to the category |
| `userId` stored on every vote and "Voted for Sarah" in the log | **Secret ballot.** `ballots` records *that* someone voted; `votes` holds anonymous rows with no user, no timestamp. The log never names the nominee |
| "Clear logs" button, "Reset to factory data" button | Removed. The audit log is append-only (DB triggers) and **hash-chained**; demo data comes from `manage.py seed-demo` |
| Photos as base64 in the page state | Validated by decoding, resized to 900 px, EXIF stripped, stored under random names, served only to signed-in users |
| `innerHTML` with unescaped names and bios (XSS) | All DOM built with `textContent`; strict Content-Security-Policy (no inline script or style, no CDN) |
| Results visibility was a client toggle | Enforced by the API: hidden results return nothing to voters |
| Tailwind/Lucide/fonts from CDNs | Compiled and vendored; works on closed networks |

### Auditability

* **Hash chain.** Each audit row's hash covers the previous row, so editing or deleting anything
  in the middle is detected by *Verify integrity* (or `python manage.py verify-audit`, exit code
  non-zero on failure). Record the **chain head hash** outside the system when you close an
  election; that also exposes deletion of the newest entries, which a chain alone cannot.
* **Reconciliation.** Verify also checks, per category, that stored votes equal the sum of ballot
  selections, which catches votes added or removed directly in the database.
* A nominee that has votes cannot be deleted or moved; close the category instead. Deleting a
  category (and its votes) is allowed but recorded with counts.
* Limits worth knowing: someone with write access to the database file *and* the code can rebuild
  the whole chain; protect the host and anchor the head hash. Ballot secrecy holds against
  administrators using the application, not against someone who can read the database *and*
  correlate server logs or timing.

## Production

Serve behind HTTPS (nginx, IIS ARR, a load balancer). Then set `COOKIE_SECURE=1` and, if proxied,
`TRUST_PROXY=1`. See `.env.example` for all settings.

```bash
gunicorn -w 3 --timeout 120 -b 127.0.0.1:8000 wsgi:app      # Linux
waitress-serve --listen=127.0.0.1:8000 wsgi:app              # Windows
docker compose up -d --build                                 # or Docker
```

* **Back up** `DATABASE_PATH` (SQLite, WAL mode: use `sqlite3 file ".backup out.db"` while running)
  and `UPLOAD_DIR`.
* First admin in a container: set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` for the
  first start only (used only when no users exist; password must be changed at first sign-in).
* Lost admin password: `python manage.py reset-password admin@example.org`.
* Rate limiting of sign-in is per worker in memory; the per-account lockout is stored in the
  database and applies across workers.
* SQLite comfortably serves an organisation-sized election. For tens of thousands of simultaneous
  voters, move `db.py` to PostgreSQL.

## Layout

```
app/__init__.py   app factory, security headers, error handling
app/auth.py       sign-in, sign-out, change password
app/voting.py     bootstrap data, ballot rules (cast_ballot), results
app/admin.py      categories, nominees, people, settings, audit
app/audit.py      hash chain + reconciliation
app/security.py   sessions, CSRF guard, password hashing, rate limit
app/images.py     upload validation and processing
app/schema.sql    database schema
app/static, app/templates   the UI (app/static/js/app.js)
frontend/         build tooling only: `npm install && npm run build` after changing classes
manage.py         create-admin, reset-password, verify-audit, seed-demo
tests/            pytest suite
```

## API (JSON, cookie session, state-changing calls need `X-Requested-With: fetch`)

| | |
|---|---|
| `POST /api/auth/login` · `logout` · `change-password`, `GET /api/auth/me` | session |
| `GET /api/bootstrap` | categories, nominees, `has_voted` for the signed-in user |
| `POST /api/categories/<id>/ballot` `{nominee_ids:[…]}` | cast a ballot (final) |
| `GET /api/results` | tallies (empty for voters when hidden) |
| `/api/admin/categories`, `/nominees` | CRUD (`mode`: `nominees` or `directory`; multipart for photos) |
| `/api/admin/users`, `/users/import`, `/users/<id>/reset-password` | people |
| `PUT /api/admin/settings` | results visibility |
| `GET /api/admin/audit`, `/audit/verify`, `/audit/export.csv` | audit |
| `GET /healthz` | liveness |
