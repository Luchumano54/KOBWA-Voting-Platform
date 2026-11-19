import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from flask import current_app, g

from .util import iso

SCHEMA = Path(__file__).with_name("schema.sql")
SCHEMA_PG = Path(__file__).with_name("schema_pg.sql")

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.extensions import TRANSACTION_STATUS_INTRANS
except ImportError:
    psycopg2 = None
    TRANSACTION_STATUS_INTRANS = 2

_INSERT_RE = re.compile(r"^\s*INSERT\s+INTO\s+([a-zA-Z0-9_]+)", re.IGNORECASE)


def is_postgres(target=None):
    if target is None:
        if current_app:
            target = current_app.config.get("DATABASE")
        else:
            return False
    return isinstance(target, str) and (
        target.startswith("postgresql://") or target.startswith("postgres://")
    )


def _sqlite_to_pg(sql):
    """Converts ? parameter placeholders to %s placeholders outside string literals."""
    out = []
    in_quote = False
    quote_char = None
    i = 0
    while i < len(sql):
        c = sql[i]
        if in_quote:
            out.append(c)
            if c == quote_char:
                if i + 1 < len(sql) and sql[i + 1] == quote_char:
                    out.append(sql[i + 1])
                    i += 1
                else:
                    in_quote = False
        else:
            if c in ("'", '"'):
                in_quote = True
                quote_char = c
                out.append(c)
            elif c == "?":
                out.append("%s")
            else:
                out.append(c)
        i += 1
    return "".join(out)


class PGCursorWrapper:
    def __init__(self, cursor, lastrowid=None):
        self._cur = cursor
        self.lastrowid = lastrowid

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def __iter__(self):
        return iter(self._cur)

    @property
    def rowcount(self):
        return self._cur.rowcount


class PGConnectionWrapper:
    def __init__(self, conn):
        self.conn = conn
        self._in_tx = False
        self.conn.autocommit = True

    @property
    def in_transaction(self):
        return self._in_tx or self.conn.get_transaction_status() == TRANSACTION_STATUS_INTRANS

    def execute(self, sql, params=()):
        cur = self.conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        pg_sql = _sqlite_to_pg(sql)
        lastrowid = None

        m = _INSERT_RE.match(pg_sql)
        needs_returning = False
        if m:
            table = m.group(1).lower()
            if table in ("users", "categories", "nominees", "ballots", "audit_log") and "returning" not in pg_sql.lower():
                pg_sql = pg_sql.rstrip().rstrip(";") + " RETURNING id"
                needs_returning = True

        cur.execute(pg_sql, params)

        if needs_returning and cur.description:
            row = cur.fetchone()
            if row:
                lastrowid = row[0]

        return PGCursorWrapper(cur, lastrowid=lastrowid)

    def executescript(self, script):
        with self.conn.cursor() as cur:
            cur.execute(script)

    def close(self):
        self.conn.close()


def connect(path_or_url):
    if is_postgres(path_or_url):
        if not psycopg2:
            raise RuntimeError("psycopg2 is required to connect to PostgreSQL. Run: pip install psycopg2-binary")
        url = path_or_url
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        conn = psycopg2.connect(url)
        return PGConnectionWrapper(conn)

    # isolation_level=None -> we control transactions explicitly (see tx()).
    conn = sqlite3.connect(path_or_url, timeout=15, isolation_level=None)
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
    """BEGIN IMMEDIATE / transaction management taking the write lock up-front,
    so check-then-insert sequences cannot interleave between workers."""
    if hasattr(db, "conn"):
        is_outer = not db._in_tx
        if is_outer:
            db._in_tx = True
            db.conn.autocommit = False
        try:
            yield db
            if is_outer:
                db.conn.commit()
        except BaseException:
            if is_outer:
                db.conn.rollback()
            raise
        finally:
            if is_outer:
                db._in_tx = False
                db.conn.autocommit = True
    else:
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
    if hasattr(db, "conn"):
        with db.conn.cursor() as cur:
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS listed INTEGER NOT NULL DEFAULT 1")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT ''")
            cur.execute("ALTER TABLE categories ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'nominees' CHECK (mode IN ('nominees', 'directory'))")
            cur.execute("ALTER TABLE categories ADD COLUMN IF NOT EXISTS allow_self_vote INTEGER NOT NULL DEFAULT 0")
            cur.execute("ALTER TABLE nominees ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)")
            cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_nominees_person ON nominees(category_id, user_id) WHERE user_id IS NOT NULL")
    else:
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
    if hasattr(db, "conn"):
        db.executescript(SCHEMA_PG.read_text(encoding="utf-8"))
    else:
        db.executescript(SCHEMA.read_text(encoding="utf-8"))
    with tx(db):
        migrate(db)
        sync_directory(db)
        db.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO NOTHING",
            ("results_public", "true"),
        )


def get_setting(db, key, default=None):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(db, key, value):
    db.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
