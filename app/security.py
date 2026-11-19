import hashlib
import secrets
import time
from datetime import timedelta
from functools import wraps

from flask import current_app, g, request
from werkzeug.security import check_password_hash, generate_password_hash

from .db import get_db
from .util import ApiError, iso, utcnow

COOKIE = "apex_session"
_TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"  # no 0/O/1/l/I
_DUMMY_HASH = generate_password_hash("not-a-real-password")  # equalises timing for unknown emails


# ---------------------------------------------------------------- passwords
def hash_password(password):
    return generate_password_hash(password)  # scrypt, per-hash salt


def hash_temp_password(password):
    # Cheaper scrypt cost for machine-generated one-time passwords (~68 bits of entropy,
    # replaced at first sign-in), so a roster import of a few hundred people stays fast.
    return generate_password_hash(password, method="scrypt:16384:8:1")


def verify_password(stored_hash, password):
    return check_password_hash(stored_hash, password)


def burn_password_check(password):
    check_password_hash(_DUMMY_HASH, password)


def temp_password():
    raw = "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(12))
    return "-".join(raw[i:i + 4] for i in range(0, 12, 4))


def validate_new_password(password, email, current=None):
    if not isinstance(password, str) or len(password) < 10:
        raise ApiError(422, "Password must be at least 10 characters.")
    if len(password) > 128:
        raise ApiError(422, "Password must be 128 characters or fewer.")
    if password.lower() == email.lower() or password.lower() == email.split("@")[0].lower():
        raise ApiError(422, "Password must not be your email address.")
    if current is not None and password == current:
        raise ApiError(422, "Choose a password different from the current one.")
    if password.isdigit() or len(set(password)) < 4:
        raise ApiError(422, "Choose a less predictable password.")


# ----------------------------------------------------------------- sessions
def _sha(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db, user_id):
    token = secrets.token_urlsafe(32)
    now = utcnow()
    expires = now + timedelta(hours=current_app.config["SESSION_HOURS"])
    db.execute(
        "INSERT INTO sessions(token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)",
        (_sha(token), user_id, iso(now), iso(expires), request.remote_addr or "", (request.user_agent.string or "")[:200]),
    )
    db.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(now),))
    return token, expires


def revoke_sessions(db, user_id, keep_hash=None):
    if keep_hash:
        db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user_id, keep_hash))
    else:
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def set_session_cookie(response, token):
    response.set_cookie(
        COOKIE, token, httponly=True, samesite="Lax", path="/",
        secure=current_app.config["COOKIE_SECURE"],
        max_age=current_app.config["SESSION_HOURS"] * 3600,
    )


def clear_session_cookie(response):
    response.delete_cookie(COOKIE, path="/")


def _before_request():
    g.user = None
    g.session_hash = None
    path = request.path
    if not (path.startswith("/api/") or path.startswith("/media/")):
        return
    # CSRF: state-changing calls must carry a custom header. Browsers will not send one
    # cross-site without a CORS preflight, and this app never grants CORS. SameSite=Lax on
    # the session cookie is the second layer.
    if path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("X-Requested-With") != "fetch":
            raise ApiError(403, "Missing required request header.")
    token = request.cookies.get(COOKIE)
    if not token:
        return
    token_hash = _sha(token)
    row = get_db().execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1",
        (token_hash, iso()),
    ).fetchone()
    if row:
        g.user = row
        g.session_hash = token_hash


def auth(admin=False, allow_pending=False):
    """Route guard. Users on a temporary password may only reach routes marked allow_pending."""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = g.user
            if user is None:
                raise ApiError(401, "Please sign in.")
            if user["must_change_password"] and not allow_pending:
                raise ApiError(403, "You must change your temporary password first.", code="password_change_required")
            if admin and user["role"] != "admin":
                raise ApiError(403, "Administrator access required.")
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def public_user(row):
    return {
        "id": row["id"], "email": row["email"], "name": row["name"], "role": row["role"],
        "must_change_password": bool(row["must_change_password"]),
    }


# ------------------------------------------------------------ rate limiting
_hits = {}


def throttle(key, limit, window_seconds):
    """Small in-process sliding window (per worker). Account lockout in the DB is the
    cross-worker control; this just blunts a single noisy client."""
    if not current_app.config["RATELIMIT_ENABLED"]:
        return
    now = time.time()
    recent = [t for t in _hits.get(key, []) if now - t < window_seconds]
    if len(recent) >= limit:
        raise ApiError(429, "Too many attempts. Please wait a few minutes and try again.")
    recent.append(now)
    _hits[key] = recent
    if len(_hits) > 5000:
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > window_seconds]:
            _hits.pop(k, None)


def init_security(app):
    app.before_request(_before_request)
