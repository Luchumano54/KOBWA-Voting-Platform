import logging
import os
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request, send_from_directory
from werkzeug.exceptions import HTTPException, NotFound, RequestEntityTooLarge
from werkzeug.middleware.proxy_fix import ProxyFix

from . import db as dbm
from .images import NAME_RE
from .security import hash_password, init_security
from .util import ApiError, iso

BASE_DIR = Path(__file__).resolve().parent.parent

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
       "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'self'")


def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def create_app(test_config=None):
    app = Flask(__name__, instance_path=str(BASE_DIR / "instance"))
    env = os.environ.get
    app.config.update(
        DATABASE=env("DATABASE_PATH", str(Path(app.instance_path) / "apexrewards.db")),
        UPLOAD_DIR=env("UPLOAD_DIR", str(BASE_DIR / "uploads")),
        SESSION_HOURS=_env_int("SESSION_HOURS", 8),
        MAX_IMAGE_MB=_env_int("MAX_IMAGE_MB", 5),
        COOKIE_SECURE=env("COOKIE_SECURE", "0") == "1",
        TRUST_PROXY=env("TRUST_PROXY", "0") == "1",
        RATELIMIT_ENABLED=True,
        LOCKOUT_THRESHOLD=5,
        LOCKOUT_MINUTES=15,
        BOOTSTRAP_ADMIN_EMAIL=env("BOOTSTRAP_ADMIN_EMAIL") or None,
        BOOTSTRAP_ADMIN_PASSWORD=env("BOOTSTRAP_ADMIN_PASSWORD") or None,
        TEMPLATES_AUTO_RELOAD=True,
    )
    if test_config:
        app.config.update(test_config)
    app.config["MAX_CONTENT_LENGTH"] = (app.config["MAX_IMAGE_MB"] + 1) * 1024 * 1024
    if app.config["TRUST_PROXY"]:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    Path(app.config["UPLOAD_DIR"]).mkdir(parents=True, exist_ok=True)

    app.teardown_appcontext(dbm.close_db)
    init_security(app)

    from . import admin, auth, voting
    app.register_blueprint(auth.bp)
    app.register_blueprint(voting.bp)
    app.register_blueprint(admin.bp)

    @app.get("/")
    def index():
        resp = app.make_response(render_template("index.html"))
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp

    @app.get("/favicon.ico")
    def favicon():
        return send_from_directory(app.static_folder, "favicon.ico", mimetype="image/x-icon")

    @app.get("/healthz")
    def healthz():
        dbm.get_db().execute("SELECT 1")
        return jsonify({"status": "ok"})

    @app.get("/media/<name>")
    def media(name):
        if g.user is None and not voting.results_public(dbm.get_db()):
            raise ApiError(401, "Please sign in.")
        if not NAME_RE.match(name):
            raise NotFound()
        resp = send_from_directory(app.config["UPLOAD_DIR"], name, max_age=86400)
        resp.headers["Cache-Control"] = "private, max-age=86400"
        return resp

    @app.after_request
    def security_headers(resp):
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "same-origin"
        resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if app.config["COOKIE_SECURE"]:
            resp.headers["Strict-Transport-Security"] = "max-age=31536000"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(ApiError)
    def handle_api_error(err):
        return jsonify({"error": err.message, **err.extra}), err.status

    @app.errorhandler(RequestEntityTooLarge)
    def handle_too_large(_err):
        return jsonify({"error": f"Upload is too large (limit {app.config['MAX_IMAGE_MB']} MB)."}), 413

    @app.errorhandler(HTTPException)
    def handle_http(err):
        if request.path.startswith("/api/") or request.path.startswith("/media/"):
            return jsonify({"error": err.description if err.code != 404 else "Not found."}), err.code
        return err

    @app.errorhandler(Exception)
    def handle_unexpected(err):
        app.logger.exception("Unhandled error: %s", err)
        return jsonify({"error": "Something went wrong on the server."}), 500

    with app.app_context():
        conn = dbm.get_db()
        dbm.init_db(conn)
        _bootstrap_admin(app, conn)
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    return app


def _bootstrap_admin(app, conn):
    """Optional first-run convenience for containers: create the first admin from env vars."""
    email, password = app.config["BOOTSTRAP_ADMIN_EMAIL"], app.config["BOOTSTRAP_ADMIN_PASSWORD"]
    if not email or not password:
        return
    if conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        return
    if len(password) < 10:
        app.logger.error("BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters; no admin created.")
        return
    from . import audit
    try:
        with dbm.tx(conn):
            conn.execute("INSERT INTO users(email, name, password_hash, role, must_change_password, active, listed, created_at) "
                         "VALUES (?,?,?,'admin',1,1,0,?)", (email.strip().lower(), "Administrator", hash_password(password), iso()))
            audit.record(conn, "ADMIN_BOOTSTRAPPED", email.strip().lower(), actor=("system", "system"), ip="startup")
    except Exception:  # another worker won the race
        pass
