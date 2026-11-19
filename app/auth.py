from flask import Blueprint, current_app, g, jsonify, request

from . import audit
from .db import get_db, tx
from .security import (auth, burn_password_check, clear_session_cookie, create_session, hash_password,
                       public_user, revoke_sessions, set_session_cookie, throttle, validate_new_password,
                       verify_password)
from .util import ApiError, iso, utcnow
from datetime import timedelta

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

FAIL_MESSAGE = ("Sign-in failed. Check your email and password, or contact an administrator "
                "if your account is locked or disabled.")


@bp.get("/me")
def me():
    return jsonify({"user": public_user(g.user) if g.user else None})


@bp.post("/login")
def login():
    throttle(f"login:{request.remote_addr}", limit=30, window_seconds=300)
    data = request.get_json(silent=True) or {}
    email = data.get("email") if isinstance(data.get("email"), str) else ""
    email = email.strip().lower()[:254]
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    cfg = current_app.config
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    now = utcnow()

    locked = bool(user and user["locked_until"] and user["locked_until"] > iso(now))
    ok = False
    if user and user["active"] and not locked:
        ok = verify_password(user["password_hash"], password)
    else:
        burn_password_check(password)

    if not ok:
        with tx(db):
            if user and user["active"] and not locked:
                fails = user["failed_logins"] + 1
                if fails >= cfg["LOCKOUT_THRESHOLD"]:
                    until = iso(now + timedelta(minutes=cfg["LOCKOUT_MINUTES"]))
                    db.execute("UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?", (until, user["id"]))
                    audit.record(db, "ACCOUNT_LOCKED", f"Too many failed sign-ins; locked until {until}",
                                 actor=(email or "(blank)", "anonymous"))
                else:
                    db.execute("UPDATE users SET failed_logins = ? WHERE id = ?", (fails, user["id"]))
            reason = "locked" if locked else "disabled" if user and not user["active"] else "bad credentials"
            audit.record(db, "LOGIN_FAILED", f"Sign-in rejected ({reason})", actor=(email or "(blank)", "anonymous"))
        raise ApiError(401, FAIL_MESSAGE)

    with tx(db):
        db.execute("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
                   (iso(now), user["id"]))
        token, _ = create_session(db, user["id"])
        audit.record(db, "LOGIN_SUCCESS", "", actor=(user["email"], user["role"]))
    fresh = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    resp = jsonify({"user": public_user(fresh)})
    set_session_cookie(resp, token)
    return resp


@bp.post("/logout")
def logout():
    db = get_db()
    if g.user:
        with tx(db):
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (g.session_hash,))
            audit.record(db, "LOGOUT", "")
    resp = jsonify({"ok": True})
    clear_session_cookie(resp)
    return resp


@bp.post("/change-password")
@auth(allow_pending=True)
def change_password():
    throttle(f"pw:{g.user['id']}", limit=10, window_seconds=600)
    data = request.get_json(silent=True) or {}
    current = data.get("current_password")
    new = data.get("new_password")
    if not isinstance(current, str) or not verify_password(g.user["password_hash"], current):
        raise ApiError(403, "Your current password is incorrect.")
    validate_new_password(new, g.user["email"], current)
    db = get_db()
    with tx(db):
        db.execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                   (hash_password(new), g.user["id"]))
        revoke_sessions(db, g.user["id"], keep_hash=g.session_hash)
        audit.record(db, "PASSWORD_CHANGED", "Changed own password")
    fresh = db.execute("SELECT * FROM users WHERE id = ?", (g.user["id"],)).fetchone()
    return jsonify({"user": public_user(fresh)})
