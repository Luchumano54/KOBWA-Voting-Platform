"""Append-only, hash-chained audit trail.

Every row's hash covers the previous row's hash, so editing or removing a row in the
middle of the log breaks every hash after it. verify() recomputes the chain. Anchor the
latest head hash somewhere outside this database (print it, e-mail it, file it with the
audit working papers) to also detect truncation of the tail.
"""
import hashlib

from flask import g, has_request_context, request

from .util import iso

GENESIS = "0" * 64
_SEP = "\x1f"


def _digest(prev, ts, email, role, action, details, ip):
    payload = _SEP.join([prev, ts, email, role, action, details, ip])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def record(db, action, details="", actor=None, ip=None):
    """Write one audit row. Must run inside tx() so the chain stays strictly ordered."""
    if not db.in_transaction:
        raise RuntimeError("audit.record() must be called inside a transaction")
    if actor is None:
        user = g.get("user") if has_request_context() else None
        actor = (user["email"], user["role"]) if user else ("system", "system")
    if ip is None:
        ip = (request.remote_addr or "") if has_request_context() else "cli"
    email, role = actor
    row = db.execute("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
    prev = row["hash"] if row else GENESIS
    ts = iso()
    digest = _digest(prev, ts, email, role, action, details, ip)
    db.execute(
        "INSERT INTO audit_log(ts, actor_email, actor_role, action, details, ip, prev_hash, hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (ts, email, role, action, details, ip, prev, digest),
    )


def verify(db):
    """Recompute the whole chain and reconcile ballots against stored votes."""
    prev = GENESIS
    count = 0
    bad_id = None
    for r in db.execute("SELECT * FROM audit_log ORDER BY id"):
        expected = _digest(prev, r["ts"], r["actor_email"], r["actor_role"], r["action"], r["details"], r["ip"])
        if r["prev_hash"] != prev or r["hash"] != expected:
            bad_id = r["id"]
            break
        prev = r["hash"]
        count += 1

    reconciliation = []
    for c in db.execute("SELECT id, title FROM categories ORDER BY id"):
        ballots = db.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(selection_count), 0) s FROM ballots WHERE category_id = ?", (c["id"],)
        ).fetchone()
        votes = db.execute("SELECT COUNT(*) n FROM votes WHERE category_id = ?", (c["id"],)).fetchone()["n"]
        reconciliation.append({
            "category_id": c["id"],
            "title": c["title"],
            "ballots": ballots["n"],
            "expected_votes": ballots["s"],
            "votes": votes,
            "ok": ballots["s"] == votes,
        })

    return {
        "chain_ok": bad_id is None,
        "entries_checked": count,
        "first_bad_id": bad_id,
        "head_hash": prev,
        "reconciliation": reconciliation,
        "reconciliation_ok": all(r["ok"] for r in reconciliation),
    }
