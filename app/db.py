import sqlite3
from contextlib import contextmanager
from pathlib import Path

from flask import current_app, g

from .util import iso

SCHEMA = Path(__file__).with_name("schema.sql")


def connect(path):
    # isolation_level=None -> we control transactions explicitly (see tx()).
    conn = sqlite3.connect(path, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect(current_app.config["DATABASE"])
    return g.db


def close_db(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


@contextmanager
def tx(db):
    """BEGIN IMMEDIATE takes the write lock up-front, so check-then-insert sequences
    (e.g. 'has this person voted yet?') cannot interleave between workers."""
    db.execute("BEGIN IMMEDIATE")
    try:
        yield db
    except BaseException:
        db.execute("ROLLBACK")
        raise
    else:
        db.execute("COMMIT")


# Columns added after the first release. Existing databases are upgraded in place on start-up.
_ADDED_COLUMNS = [
    ("users", "listed", "INTEGER NOT NULL DEFAULT 1"),
    ("users", "department", "TEXT NOT NULL DEFAULT ''"),
    ("categories", "mode", "TEXT NOT NULL DEFAULT 'nominees' CHECK (mode IN ('nominees', 'directory'))"),
    ("categories", "allow_self_vote", "INTEGER NOT NULL DEFAULT 0"),
    ("nominees", "user_id", "INTEGER REFERENCES users(id)"),
]


def migrate(db):
    for table, column, ddl in _ADDED_COLUMNS:
        existing = {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            if (table, column) == ("users", "listed"):
                db.execute("UPDATE users SET listed = 0 WHERE role = 'admin'")  # admins are not candidates by default
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_nominees_person ON nominees(category_id, user_id) "
               "WHERE user_id IS NOT NULL")


def sync_directory(db, category_id=None):
    """Make sure every open-vote category has a candidate row for every active, listed person.

    Rows are created up-front (when a category or person is added), never when a vote arrives,
    so neither the existence nor the creation time of a row says anything about who was voted for.
    """
    sql = ("INSERT INTO nominees(category_id, name, bio, image, user_id, created_at) "
           "SELECT c.id, u.name, u.department, NULL, u.id, ? FROM categories c "
           "JOIN users u ON u.active = 1 AND u.listed = 1 "
           "WHERE c.mode = 'directory' AND NOT EXISTS "
           "(SELECT 1 FROM nominees n WHERE n.category_id = c.id AND n.user_id = u.id)")
    params = [iso()]
    if category_id is not None:
        sql += " AND c.id = ?"
        params.append(category_id)
    db.execute(sql, params)


def refresh_person(db, user_id):
    """Keep the displayed name and department of a staff-list candidate in step with the account."""
    db.execute("UPDATE nominees SET name = (SELECT name FROM users WHERE id = nominees.user_id), "
               "bio = (SELECT department FROM users WHERE id = nominees.user_id) WHERE user_id = ?", (user_id,))


def init_db(db):
    db.executescript(SCHEMA.read_text(encoding="utf-8"))
    with tx(db):
        migrate(db)
        sync_directory(db)
        db.execute("INSERT OR IGNORE INTO settings(key, value) VALUES ('results_public', 'true')")


def get_setting(db, key, default=None):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(db, key, value):
    db.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
