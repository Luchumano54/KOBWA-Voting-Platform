import secrets

from flask import Blueprint, g, jsonify, request

from . import audit
from .db import get_db, get_setting, tx
from .security import auth, public_user
from .util import ApiError, iso

bp = Blueprint("voting", __name__, url_prefix="/api")


def image_url(name):
    return f"/media/{name}" if name else None


def nominee_dict(row):
    return {"id": row["id"], "category_id": row["category_id"], "name": row["name"],
            "bio": row["bio"], "image_url": image_url(row["image"])}


def results_public(db):
    return get_setting(db, "results_public", "true") == "true"


@bp.get("/bootstrap")
@auth()
def bootstrap():
    db = get_db()
    me = g.user["id"]
    # Open-vote categories list the staff directory: active, listed people (and not yourself,
    # unless the category allows it). Hand-made nominees are listed as they are.
    nominees = {}
    for n in db.execute(
            "SELECT n.*, c.mode FROM nominees n JOIN categories c ON c.id = n.category_id "
            "LEFT JOIN users u ON u.id = n.user_id "
            "WHERE c.mode = 'nominees' OR (u.active = 1 AND u.listed = 1 AND (c.allow_self_vote = 1 OR u.id != ?)) "
            "ORDER BY n.id", (me,)):
        nominees.setdefault(n["category_id"], []).append(nominee_dict(n))
    voted = {r["category_id"] for r in db.execute("SELECT category_id FROM ballots WHERE user_id = ?", (me,))}
    categories = []
    for c in db.execute("SELECT * FROM categories ORDER BY id"):
        people = nominees.get(c["id"], [])
        if c["mode"] == "directory":
            people.sort(key=lambda p: p["name"].lower())
        categories.append({
            "id": c["id"], "title": c["title"], "description": c["description"],
            "max_votes": c["max_votes"], "active": bool(c["active"]), "mode": c["mode"],
            "allow_self_vote": bool(c["allow_self_vote"]),
            "has_voted": c["id"] in voted, "nominees": people,
        })
    return jsonify({"user": public_user(g.user), "settings": {"results_public": results_public(db)},
                    "categories": categories})


def cast_ballot(db, user, category_id, nominee_ids):
    """The single code path that records a vote (used by the API and the demo seeder)."""
    if not isinstance(nominee_ids, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in nominee_ids):
        raise ApiError(422, "Select at least one nominee.")
    if len(set(nominee_ids)) != len(nominee_ids):
        raise ApiError(422, "Each nominee can only be selected once.")
    with tx(db):
        cat = db.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
        if not cat:
            raise ApiError(404, "Category not found.")
        if not cat["active"]:
            raise ApiError(409, "Voting is closed for this category.")
        if db.execute("SELECT 1 FROM ballots WHERE user_id = ? AND category_id = ?", (user["id"], category_id)).fetchone():
            raise ApiError(409, "You have already voted in this category.")
        if not 1 <= len(nominee_ids) <= cat["max_votes"]:
            limit = "1 nominee" if cat["max_votes"] == 1 else f"between 1 and {cat['max_votes']} nominees"
            raise ApiError(422, f"Select {limit} in this category.")
        marks = ",".join("?" * len(nominee_ids))
        chosen = db.execute(
            "SELECT n.id, n.user_id, u.active, u.listed FROM nominees n LEFT JOIN users u ON u.id = n.user_id "
            f"WHERE n.category_id = ? AND n.id IN ({marks})", (category_id, *nominee_ids)).fetchall()
        if len(chosen) != len(nominee_ids):
            raise ApiError(422, "One or more selections are not available in this category.")
        if cat["mode"] == "directory":
            if not cat["allow_self_vote"] and any(r["user_id"] == user["id"] for r in chosen):
                raise ApiError(422, "You can't vote for yourself in this category.")
            if any(not (r["active"] and r["listed"]) for r in chosen):
                raise ApiError(422, "One or more of those people are no longer available. Refresh the list and choose again.")
        db.execute("INSERT INTO ballots(user_id, category_id, selection_count, created_at) VALUES (?,?,?,?)",
                   (user["id"], category_id, len(nominee_ids), iso()))
        shuffled = list(nominee_ids)
        secrets.SystemRandom().shuffle(shuffled)
        for nid in shuffled:
            db.execute("INSERT INTO votes(id, category_id, nominee_id) VALUES (?,?,?)",
                       (secrets.token_hex(16), category_id, nid))
        # The audit entry records THAT a ballot was cast, never WHAT was chosen.
        audit.record(db, "BALLOT_SUBMITTED", f"{cat['title']} ({len(nominee_ids)} selection(s))",
                     actor=(user["email"], user["role"]))


@bp.post("/categories/<int:category_id>/ballot")
@auth()
def submit_ballot(category_id):
    data = request.get_json(silent=True) or {}
    cast_ballot(get_db(), g.user, category_id, data.get("nominee_ids"))
    return jsonify({"ok": True, "category_id": category_id}), 201


def compute_results(db):
    out = []
    for c in db.execute("SELECT * FROM categories ORDER BY id"):
        rows = db.execute(
            "SELECT n.id, n.name, n.image, COUNT(v.id) AS votes FROM nominees n "
            "LEFT JOIN votes v ON v.nominee_id = n.id WHERE n.category_id = ? "
            "GROUP BY n.id ORDER BY votes DESC, n.name COLLATE NOCASE", (c["id"],)).fetchall()
        total = sum(r["votes"] for r in rows)
        ballots = db.execute("SELECT COUNT(*) n FROM ballots WHERE category_id = ?", (c["id"],)).fetchone()["n"]
        if c["mode"] == "directory":
            rows = [r for r in rows if r["votes"] > 0]  # only people who received votes; the staff list can be long
        top = rows[0]["votes"] if rows else 0
        nominees, rank, previous = [], 0, None
        for i, r in enumerate(rows, start=1):
            if r["votes"] != previous:  # competition ranking: ties share a rank
                rank, previous = i, r["votes"]
            nominees.append({"id": r["id"], "name": r["name"], "image_url": image_url(r["image"]),
                             "votes": r["votes"], "percentage": round(r["votes"] * 100 / total, 1) if total else 0,
                             "rank": rank})
        out.append({"id": c["id"], "title": c["title"], "active": bool(c["active"]), "mode": c["mode"], "total_votes": total,
                    "ballots": ballots, "nominees": nominees,
                    "leader_ids": [n["id"] for n in nominees if top > 0 and n["votes"] == top]})
    return out


@bp.get("/results")
def results():
    db = get_db()
    public = results_public(db)
    user_is_admin = g.user is not None and g.user["role"] == "admin"
    active_cats = db.execute("SELECT COUNT(*) AS c FROM categories WHERE active = 1").fetchone()["c"]
    total_ballots = db.execute("SELECT COUNT(*) AS b FROM ballots").fetchone()["b"]
    if not public and not user_is_admin:
        return jsonify({
            "public": False,
            "hidden": True,
            "categories": [],
            "active_categories": active_cats,
            "total_ballots": total_ballots,
        })
    return jsonify({
        "public": public,
        "hidden": False,
        "categories": compute_results(db),
        "active_categories": active_cats,
        "total_ballots": total_ballots,
    })
