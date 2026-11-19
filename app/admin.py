import csv
import io
from pathlib import Path

from flask import Blueprint, Response, current_app, g, jsonify, request

from . import audit
from .db import get_db, refresh_person, set_setting, sync_directory, tx
from .images import delete_image, save_nominee_image
from .security import auth, hash_temp_password, revoke_sessions, temp_password
from .util import ApiError, clean_email, clean_text, iso, parse_bool, parse_int
from .voting import nominee_dict, results_public

bp = Blueprint("admin", __name__, url_prefix="/api/admin")
IMPORT_LIMIT = 250


def _payload():
    """Accept multipart/form-data (the UI) or JSON (scripts, tests)."""
    if request.mimetype == "application/json":
        return request.get_json(silent=True) or {}
    return request.form.to_dict()


def _upload_dir():
    return current_app.config["UPLOAD_DIR"]


def _require_nominee_category(cat):
    if cat["mode"] == "directory":
        raise ApiError(409, "This is an open-vote category: candidates come from the staff list, not from nominees.")
    return cat


def _get_category(db, cid):
    row = db.execute("SELECT * FROM categories WHERE id = ?", (cid,)).fetchone()
    if not row:
        raise ApiError(404, "Category not found.")
    return row


# ------------------------------------------------------------- categories
@bp.get("/categories")
@auth(admin=True)
def list_categories():
    db = get_db()
    nominees = {}
    for n in db.execute("SELECT * FROM nominees ORDER BY id"):
        nominees.setdefault(n["category_id"], []).append(nominee_dict(n))
    ballots = {r["category_id"]: r["n"] for r in db.execute("SELECT category_id, COUNT(*) n FROM ballots GROUP BY category_id")}
    votes = {r["category_id"]: r["n"] for r in db.execute("SELECT category_id, COUNT(*) n FROM votes GROUP BY category_id")}
    eligible = db.execute("SELECT COUNT(*) n FROM users WHERE active = 1").fetchone()["n"]
    candidates = db.execute("SELECT COUNT(*) n FROM users WHERE active = 1 AND listed = 1").fetchone()["n"]
    cats = [{
        "id": c["id"], "title": c["title"], "description": c["description"], "max_votes": c["max_votes"],
        "active": bool(c["active"]), "mode": c["mode"], "allow_self_vote": bool(c["allow_self_vote"]),
        # open-vote categories draw on the staff list, so there is no hand-made nominee list to show
        "nominees": [] if c["mode"] == "directory" else nominees.get(c["id"], []),
        "candidates": candidates if c["mode"] == "directory" else None,
        "ballots": ballots.get(c["id"], 0), "votes": votes.get(c["id"], 0),
    } for c in db.execute("SELECT * FROM categories ORDER BY id")]
    return jsonify({"categories": cats, "eligible_voters": eligible, "results_public": results_public(db)})


@bp.post("/categories")
@auth(admin=True)
def create_category():
    data = _payload()
    title = clean_text(data.get("title"), "Title", 120)
    description = clean_text(data.get("description"), "Description", 1000, required=False, multiline=True)
    max_votes = parse_int(data.get("max_votes", 1), "Votes per person", 1, 50)
    active = parse_bool(data.get("active", True), "Status")
    mode = data.get("mode", "nominees")
    if mode not in ("nominees", "directory"):
        raise ApiError(422, "Voting type must be nominees or directory.")
    allow_self = parse_bool(data.get("allow_self_vote", False), "Voting for yourself") if mode == "directory" else False
    db = get_db()
    with tx(db):
        cur = db.execute("INSERT INTO categories(title, description, max_votes, active, mode, allow_self_vote, created_at) "
                         "VALUES (?,?,?,?,?,?,?)", (title, description, max_votes, int(active), mode, int(allow_self), iso()))
        if mode == "directory":
            sync_directory(db, cur.lastrowid)
        kind = "open vote from the staff list" if mode == "directory" else "nominees"
        audit.record(db, "CATEGORY_CREATED", f"{title} ({kind}, max {max_votes} vote(s), {'open' if active else 'closed'})")
    return jsonify({"id": cur.lastrowid}), 201


@bp.put("/categories/<int:cid>")
@auth(admin=True)
def update_category(cid):
    data = _payload()
    db = get_db()
    with tx(db):
        cat = _get_category(db, cid)
        title = clean_text(data["title"], "Title", 120) if "title" in data else cat["title"]
        description = (clean_text(data["description"], "Description", 1000, required=False, multiline=True)
                       if "description" in data else cat["description"])
        max_votes = parse_int(data["max_votes"], "Votes per person", 1, 50) if "max_votes" in data else cat["max_votes"]
        active = int(parse_bool(data["active"], "Status")) if "active" in data else cat["active"]
        if "mode" in data and data["mode"] != cat["mode"]:
            raise ApiError(422, "The voting type cannot be changed after a category is created. Create a new category instead.")
        allow_self = cat["allow_self_vote"]
        if "allow_self_vote" in data and cat["mode"] == "directory":
            if cat["allow_self_vote"] != int(parse_bool(data["allow_self_vote"], "Voting for yourself")) and \
                    db.execute("SELECT 1 FROM ballots WHERE category_id = ?", (cid,)).fetchone():
                raise ApiError(409, "Ballots have already been cast, so the rule on voting for yourself can no longer change.")
            allow_self = int(parse_bool(data["allow_self_vote"], "Voting for yourself"))
        db.execute("UPDATE categories SET title=?, description=?, max_votes=?, active=?, allow_self_vote=? WHERE id=?",
                   (title, description, max_votes, active, allow_self, cid))
        if active != cat["active"]:
            audit.record(db, "CATEGORY_STATUS_CHANGED", f"{title}: voting {'opened' if active else 'closed'}")
        changed = [k for k, a, b in (("title", title, cat["title"]), ("description", description, cat["description"]),
                                      ("max_votes", max_votes, cat["max_votes"]),
                                      ("allow_self_vote", allow_self, cat["allow_self_vote"])) if a != b]
        if changed:
            audit.record(db, "CATEGORY_UPDATED", f"{title}: changed {', '.join(changed)}")
    return jsonify({"ok": True})


@bp.delete("/categories/<int:cid>")
@auth(admin=True)
def delete_category(cid):
    db = get_db()
    images = []
    with tx(db):
        cat = _get_category(db, cid)
        nominees = db.execute("SELECT image FROM nominees WHERE category_id = ?", (cid,)).fetchall()
        images = [n["image"] for n in nominees if n["image"]]
        ballots = db.execute("SELECT COUNT(*) n FROM ballots WHERE category_id = ?", (cid,)).fetchone()["n"]
        votes = db.execute("SELECT COUNT(*) n FROM votes WHERE category_id = ?", (cid,)).fetchone()["n"]
        db.execute("DELETE FROM votes WHERE category_id = ?", (cid,))
        db.execute("DELETE FROM ballots WHERE category_id = ?", (cid,))
        db.execute("DELETE FROM nominees WHERE category_id = ?", (cid,))
        db.execute("DELETE FROM categories WHERE id = ?", (cid,))
        audit.record(db, "CATEGORY_DELETED",
                     f"{cat['title']} (removed {len(nominees)} nominee(s), {ballots} ballot(s), {votes} vote(s))")
    for name in images:
        delete_image(_upload_dir(), name)
    return jsonify({"ok": True})


# --------------------------------------------------------------- nominees
@bp.post("/nominees")
@auth(admin=True)
def create_nominee():
    data = _payload()
    cid = parse_int(data.get("category_id"), "Category", 1, 2**31 - 1)
    name = clean_text(data.get("name"), "Name", 120)
    bio = clean_text(data.get("bio"), "Bio", 1000, required=False, multiline=True)
    db = get_db()
    _require_nominee_category(_get_category(db, cid))
    upload = request.files.get("image")
    image = save_nominee_image(upload, _upload_dir(), current_app.config["MAX_IMAGE_MB"]) if upload and upload.filename else None
    try:
        with tx(db):
            cat = _require_nominee_category(_get_category(db, cid))
            cur = db.execute("INSERT INTO nominees(category_id, name, bio, image, created_at) VALUES (?,?,?,?,?)",
                             (cid, name, bio, image, iso()))
            audit.record(db, "NOMINEE_CREATED", f"{name} in {cat['title']}")
    except BaseException:
        delete_image(_upload_dir(), image)
        raise
    return jsonify({"id": cur.lastrowid}), 201


@bp.put("/nominees/<int:nid>")
@auth(admin=True)
def update_nominee(nid):
    data = _payload()
    db = get_db()
    nominee = db.execute("SELECT * FROM nominees WHERE id = ?", (nid,)).fetchone()
    if not nominee:
        raise ApiError(404, "Nominee not found.")
    if nominee["user_id"] is not None:
        raise ApiError(409, "Staff-list candidates are managed under Voters, not edited here.")
    name = clean_text(data["name"], "Name", 120) if "name" in data else nominee["name"]
    bio = clean_text(data["bio"], "Bio", 1000, required=False, multiline=True) if "bio" in data else nominee["bio"]
    cid = parse_int(data["category_id"], "Category", 1, 2**31 - 1) if "category_id" in data else nominee["category_id"]
    remove = parse_bool(data.get("remove_image", False), "remove_image")
    upload = request.files.get("image")
    new_image = save_nominee_image(upload, _upload_dir(), current_app.config["MAX_IMAGE_MB"]) if upload and upload.filename else None
    try:
        with tx(db):
            nominee = db.execute("SELECT * FROM nominees WHERE id = ?", (nid,)).fetchone()
            if not nominee:
                raise ApiError(404, "Nominee not found.")
            cat = _require_nominee_category(_get_category(db, cid))
            if cid != nominee["category_id"] and db.execute(
                    "SELECT 1 FROM votes WHERE nominee_id = ?", (nid,)).fetchone():
                raise ApiError(409, "This nominee already has votes and cannot be moved to another category.")
            image = new_image or (None if remove else nominee["image"])
            db.execute("UPDATE nominees SET category_id=?, name=?, bio=?, image=? WHERE id=?", (cid, name, bio, image, nid))
            audit.record(db, "NOMINEE_UPDATED", f"{name} in {cat['title']}")
    except BaseException:
        delete_image(_upload_dir(), new_image)
        raise
    if nominee["image"] and image != nominee["image"]:
        delete_image(_upload_dir(), nominee["image"])
    return jsonify({"ok": True})


@bp.delete("/nominees/<int:nid>")
@auth(admin=True)
def delete_nominee(nid):
    db = get_db()
    with tx(db):
        nominee = db.execute("SELECT * FROM nominees WHERE id = ?", (nid,)).fetchone()
        if not nominee:
            raise ApiError(404, "Nominee not found.")
        if nominee["user_id"] is not None:
            raise ApiError(409, "Staff-list candidates are managed under Voters, not deleted here.")
        count = db.execute("SELECT COUNT(*) n FROM votes WHERE nominee_id = ?", (nid,)).fetchone()["n"]
        if count:
            raise ApiError(409, f"{nominee['name']} has {count} vote(s) and cannot be deleted. "
                                "Close the category instead, or delete the whole category.")
        db.execute("DELETE FROM nominees WHERE id = ?", (nid,))
        audit.record(db, "NOMINEE_DELETED", nominee["name"])
    delete_image(_upload_dir(), nominee["image"])
    return jsonify({"ok": True})


# --------------------------------------------------------------- settings
@bp.put("/settings")
@auth(admin=True)
def update_settings():
    data = request.get_json(silent=True) or {}
    if "results_public" not in data:
        raise ApiError(422, "Nothing to update.")
    value = parse_bool(data["results_public"], "results_public")
    db = get_db()
    with tx(db):
        set_setting(db, "results_public", "true" if value else "false")
        audit.record(db, "SETTINGS_CHANGED", f"Results visibility set to {'public' if value else 'hidden'}")
    return jsonify({"results_public": value})


# ------------------------------------------------------------------ users
def _user_dict(u):
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "active": bool(u["active"]),
            "must_change_password": bool(u["must_change_password"]), "last_login_at": u["last_login_at"],
            "listed": bool(u["listed"]), "department": u["department"],
            "locked": bool(u["locked_until"] and u["locked_until"] > iso()), "ballots_cast": u["ballots_cast"]}


def _users_query(db, where="", params=()):
    return db.execute(
        "SELECT u.*, (SELECT COUNT(*) FROM ballots b WHERE b.user_id = u.id) AS ballots_cast "
        f"FROM users u {where} ORDER BY LOWER(u.name)", params).fetchall()


@bp.get("/users")
@auth(admin=True)
def list_users():
    return jsonify({"users": [_user_dict(u) for u in _users_query(get_db())]})


def _other_active_admins(db, uid):
    return db.execute("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id != ?", (uid,)).fetchone()["n"]


@bp.post("/users")
@auth(admin=True)
def create_user():
    data = request.get_json(silent=True) or {}
    email = clean_email(data.get("email"))
    name = clean_text(data.get("name"), "Name", 120)
    role = data.get("role", "voter")
    if role not in ("voter", "admin"):
        raise ApiError(422, "Role must be voter or admin.")
    department = clean_text(data.get("department"), "Department", 120, required=False)
    listed = parse_bool(data["listed"], "Listed") if "listed" in data else role == "voter"
    password = temp_password()
    pw_hash = hash_temp_password(password)
    db = get_db()
    with tx(db):
        if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise ApiError(409, "A user with that email already exists.")
        cur = db.execute("INSERT INTO users(email, name, password_hash, role, must_change_password, active, listed, department, created_at) "
                         "VALUES (?,?,?,?,1,1,?,?,?)", (email, name, pw_hash, role, int(listed), department, iso()))
        sync_directory(db)
        audit.record(db, "USER_CREATED", f"{name} <{email}> as {role}{'' if listed else ' (not in vote lists)'}")
    user = _users_query(db, "WHERE u.id = ?", (cur.lastrowid,))[0]
    return jsonify({"user": _user_dict(user), "temp_password": password}), 201


def _parse_import_rows(data):
    rows = data.get("rows")
    if rows is None:
        text = data.get("csv")
        if not isinstance(text, str) or not text.strip():
            raise ApiError(422, "Provide a list of people to import.")
        rows = []
        for idx, cells in enumerate(csv.reader(io.StringIO(text))):
            cells = [c.strip() for c in cells if c.strip()]
            if not cells:
                continue
            email = next((c for c in cells if "@" in c), "")
            if not email and idx == 0:
                continue  # header row
            others = [c for c in cells if c != email]
            rows.append({"name": others[0] if others else "", "email": email,
                         "department": others[1] if len(others) > 1 else ""})
    if not isinstance(rows, list):
        raise ApiError(422, "rows must be a list.")
    if len(rows) > IMPORT_LIMIT:
        raise ApiError(422, f"Import at most {IMPORT_LIMIT} people at a time.")
    return rows


@bp.post("/users/import")
@auth(admin=True)
def import_users():
    rows = _parse_import_rows(request.get_json(silent=True) or {})
    prepared, skipped, seen = [], [], set()
    for r in rows:
        raw_email = r.get("email", "") if isinstance(r, dict) else ""
        try:
            email = clean_email(raw_email)
            default_name = email.split("@")[0].replace(".", " ").replace("_", " ").title()
            name = clean_text(r.get("name") or default_name, "Name", 120)
            department = clean_text(r.get("department"), "Department", 120, required=False)
        except ApiError as e:
            skipped.append({"email": str(raw_email)[:254], "reason": e.message})
            continue
        if email in seen:
            skipped.append({"email": email, "reason": "Duplicate in this file."})
            continue
        seen.add(email)
        password = temp_password()
        prepared.append((email, name, department, password, hash_temp_password(password)))  # hashing happens outside the DB lock
    db = get_db()
    created = []
    with tx(db):
        for email, name, department, password, pw_hash in prepared:
            if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
                skipped.append({"email": email, "reason": "Already exists."})
                continue
            db.execute("INSERT INTO users(email, name, password_hash, role, must_change_password, active, listed, department, created_at) "
                       "VALUES (?,?,?,'voter',1,1,1,?,?)", (email, name, pw_hash, department, iso()))
            created.append({"name": name, "email": email, "temp_password": password})
        sync_directory(db)
        audit.record(db, "USERS_IMPORTED", f"{len(created)} created, {len(skipped)} skipped")
    return jsonify({"created": created, "skipped": skipped}), 201


@bp.put("/users/<int:uid>")
@auth(admin=True)
def update_user(uid):
    data = request.get_json(silent=True) or {}
    db = get_db()
    with tx(db):
        target = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if not target:
            raise ApiError(404, "User not found.")
        active, role = target["active"], target["role"]
        name = clean_text(data["name"], "Name", 120) if "name" in data else target["name"]
        department = clean_text(data["department"], "Department", 120, required=False) if "department" in data else target["department"]
        listed = int(parse_bool(data["listed"], "listed")) if "listed" in data else target["listed"]
        if "active" in data:
            active = int(parse_bool(data["active"], "active"))
        if "role" in data:
            role = data["role"]
            if role not in ("voter", "admin"):
                raise ApiError(422, "Role must be voter or admin.")
        losing_admin = target["role"] == "admin" and target["active"] and (not active or role != "admin")
        if losing_admin:
            if uid == g.user["id"]:
                raise ApiError(409, "You cannot disable or demote your own administrator account.")
            if _other_active_admins(db, uid) == 0:
                raise ApiError(409, "At least one active administrator is required.")
        db.execute("UPDATE users SET name=?, active=?, role=?, listed=?, department=? WHERE id=?",
                   (name, active, role, listed, department, uid))
        refresh_person(db, uid)
        sync_directory(db)
        if not active:
            revoke_sessions(db, uid)
        notes = []
        if active != target["active"]:
            notes.append("enabled" if active else "disabled")
        if role != target["role"]:
            notes.append(f"role {target['role']} -> {role}")
        if name != target["name"]:
            notes.append("renamed")
        if department != target["department"]:
            notes.append("department changed")
        if listed != target["listed"]:
            notes.append("added to vote lists" if listed else "removed from vote lists")
        if notes:
            audit.record(db, "USER_UPDATED", f"{target['email']}: {', '.join(notes)}")
    return jsonify({"user": _user_dict(_users_query(db, "WHERE u.id = ?", (uid,))[0])})


@bp.post("/users/<int:uid>/reset-password")
@auth(admin=True)
def reset_password(uid):
    password = temp_password()
    pw_hash = hash_temp_password(password)
    db = get_db()
    with tx(db):
        target = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if not target:
            raise ApiError(404, "User not found.")
        db.execute("UPDATE users SET password_hash=?, must_change_password=1, failed_logins=0, locked_until=NULL WHERE id=?",
                   (pw_hash, uid))
        revoke_sessions(db, uid)
        audit.record(db, "USER_PASSWORD_RESET", f"Temporary password issued to {target['email']}")
    return jsonify({"email": target["email"], "name": target["name"], "temp_password": password})


# ------------------------------------------------------------------ audit
def _audit_filter():
    q = request.args.get("q", "").strip()[:100]
    if not q:
        return "", ()
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return ("WHERE actor_email LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\'",
            (like, like, like))


@bp.get("/audit")
@auth(admin=True)
def list_audit():
    db = get_db()
    page = parse_int(request.args.get("page", 1), "page", 1, 10**6)
    per_page = parse_int(request.args.get("per_page", 50), "per_page", 1, 200)
    where, params = _audit_filter()
    total = db.execute(f"SELECT COUNT(*) n FROM audit_log {where}", params).fetchone()["n"]
    rows = db.execute(f"SELECT id, ts, actor_email, actor_role, action, details, ip FROM audit_log {where} "
                      "ORDER BY id DESC LIMIT ? OFFSET ?", (*params, per_page, (page - 1) * per_page)).fetchall()
    return jsonify({"items": [dict(r) for r in rows], "total": total, "page": page, "per_page": per_page})


@bp.get("/audit/verify")
@auth(admin=True)
def verify_audit():
    return jsonify(audit.verify(get_db()))


def _csv_safe(value):
    value = str(value)
    return "'" + value if value[:1] in ("=", "+", "-", "@", "\t", "\r") else value  # spreadsheet formula injection


@bp.get("/audit/export.csv")
@auth(admin=True)
def export_audit():
    db = get_db()
    where, params = _audit_filter()
    rows = db.execute(f"SELECT * FROM audit_log {where} ORDER BY id", params).fetchall()

    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "timestamp_utc", "actor", "role", "action", "details", "ip", "prev_hash", "hash"])
        yield buf.getvalue()
        for r in rows:
            buf.seek(0), buf.truncate()
            writer.writerow([r["id"], r["ts"], _csv_safe(r["actor_email"]), r["actor_role"], r["action"],
                             _csv_safe(r["details"]), r["ip"], r["prev_hash"], r["hash"]])
            yield buf.getvalue()

    return Response(generate(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=audit-log.csv"})
