import io
import sqlite3
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from app.db import connect, tx  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.util import iso  # noqa: E402

ADMIN = ("admin@example.com", "Correct-Horse-9")


class Client:
    """Thin wrapper that adds the CSRF header the real frontend sends."""

    def __init__(self, app):
        self.c = app.test_client()

    def _req(self, method, url, **kw):
        headers = kw.pop("headers", {})
        headers.setdefault("X-Requested-With", "fetch")
        return getattr(self.c, method)(url, headers=headers, **kw)

    def get(self, url, **kw): return self._req("get", url, **kw)
    def post(self, url, json=None, **kw): return self._req("post", url, json=json, **kw)
    def put(self, url, json=None, **kw): return self._req("put", url, json=json, **kw)
    def delete(self, url, **kw): return self._req("delete", url, **kw)

    def login(self, email, password):
        return self.post("/api/auth/login", {"email": email, "password": password})


@pytest.fixture()
def app(tmp_path):
    app = create_app({
        "TESTING": True,
        "DATABASE": str(tmp_path / "t.db"),
        "UPLOAD_DIR": str(tmp_path / "uploads"),
        "RATELIMIT_ENABLED": False,
    })
    with app.app_context():
        db = connect(app.config["DATABASE"])
        with tx(db):
            db.execute("INSERT INTO users(email,name,password_hash,role,must_change_password,active,listed,created_at) "
                       "VALUES (?,?,?,?,0,1,0,?)", (ADMIN[0], "Admin", hash_password(ADMIN[1]), "admin", iso()))
        db.close()
    return app


@pytest.fixture()
def admin(app):
    c = Client(app)
    assert c.login(*ADMIN).status_code == 200
    return c


def make_voter(admin, app, email, name="Voter", change_password=True):
    r = admin.post("/api/admin/users", {"email": email, "name": name})
    assert r.status_code == 201, r.get_json()
    temp = r.get_json()["temp_password"]
    c = Client(app)
    assert c.login(email, temp).status_code == 200
    if change_password:
        r = c.post("/api/auth/change-password", {"current_password": temp, "new_password": "Brand-New-Pass-77"})
        assert r.status_code == 200, r.get_json()
    return c


def png_bytes(size=(1200, 800), mode="RGB"):
    buf = io.BytesIO()
    Image.new(mode, size, (200, 40, 40)).save(buf, "PNG")
    return buf.getvalue()


def raw_db(app):
    conn = sqlite3.connect(app.config["DATABASE"])
    conn.row_factory = sqlite3.Row
    return conn
