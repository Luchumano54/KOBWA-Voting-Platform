import io
import threading

from conftest import ADMIN, Client, make_voter, png_bytes, raw_db


def setup_election(admin, max_votes=1, nominees=("Ann", "Ben", "Cy")):
    cid = admin.post("/api/admin/categories", {"title": "Best Team", "description": "d", "max_votes": max_votes}).get_json()["id"]
    ids = [admin.post("/api/admin/nominees", {"category_id": cid, "name": n}).get_json()["id"] for n in nominees]
    return cid, ids


# ----------------------------------------------------------------- auth
def test_api_writes_require_csrf_header(app):
    c = app.test_client()
    r = c.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]})
    assert r.status_code == 403


def test_security_headers(app):
    r = app.test_client().get("/")
    assert "script-src 'self'" in r.headers["Content-Security-Policy"]
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_unauthenticated_requests_rejected(app):
    c = Client(app)
    for url in ("/api/bootstrap", "/api/results", "/api/admin/users", "/api/admin/audit"):
        assert c.get(url).status_code == 401
    assert c.get("/api/auth/me").get_json() == {"user": None}


def test_forced_password_change_blocks_everything_else(app, admin):
    temp = admin.post("/api/admin/users", {"email": "v@example.com", "name": "V"}).get_json()["temp_password"]
    v = Client(app)
    assert v.login("v@example.com", temp).get_json()["user"]["must_change_password"] is True
    r = v.get("/api/bootstrap")
    assert r.status_code == 403 and r.get_json()["code"] == "password_change_required"
    assert v.post("/api/auth/change-password", {"current_password": "wrong", "new_password": "Whatever-1234"}).status_code == 403
    assert v.post("/api/auth/change-password", {"current_password": temp, "new_password": "short"}).status_code == 422
    assert v.post("/api/auth/change-password", {"current_password": temp, "new_password": "Fresh-Password-42"}).status_code == 200
    assert v.get("/api/bootstrap").status_code == 200


def test_lockout_after_repeated_failures_and_generic_message(app, admin):
    make_voter(admin, app, "lock@example.com")
    c = Client(app)
    msgs = {c.login("lock@example.com", "nope").get_json()["error"] for _ in range(5)}
    msgs.add(c.login("nobody@example.com", "nope").get_json()["error"])
    assert len(msgs) == 1  # unknown user and wrong password look identical
    assert c.login("lock@example.com", "Brand-New-Pass-77").status_code == 401  # locked, even with the right password
    actions = [r["action"] for r in raw_db(app).execute("SELECT action FROM audit_log")]
    assert "ACCOUNT_LOCKED" in actions


def test_password_change_revokes_other_sessions(app, admin):
    v = make_voter(admin, app, "multi@example.com")
    other = Client(app)
    assert other.login("multi@example.com", "Brand-New-Pass-77").status_code == 200
    assert v.post("/api/auth/change-password", {"current_password": "Brand-New-Pass-77", "new_password": "Another-Pass-12345"}).status_code == 200
    assert other.get("/api/bootstrap").status_code == 401
    assert v.get("/api/bootstrap").status_code == 200


def test_voter_cannot_reach_admin_api(app, admin):
    v = make_voter(admin, app, "plain@example.com")
    for method, url in (("get", "/api/admin/users"), ("get", "/api/admin/categories"), ("get", "/api/admin/audit"),
                        ("post", "/api/admin/categories"), ("put", "/api/admin/settings")):
        assert getattr(v, method)(url).status_code == 403


def test_disabled_user_loses_access_immediately(app, admin):
    v = make_voter(admin, app, "gone@example.com")
    uid = next(u["id"] for u in admin.get("/api/admin/users").get_json()["users"] if u["email"] == "gone@example.com")
    assert admin.put(f"/api/admin/users/{uid}", {"active": False}).status_code == 200
    assert v.get("/api/bootstrap").status_code == 401


def test_admin_cannot_lock_themselves_out(app, admin):
    me = admin.get("/api/auth/me").get_json()["user"]["id"]
    assert admin.put(f"/api/admin/users/{me}", {"active": False}).status_code == 409
    assert admin.put(f"/api/admin/users/{me}", {"role": "voter"}).status_code == 409


# --------------------------------------------------------------- voting
def test_single_vote_rules(app, admin):
    cid, (a, b, _c) = setup_election(admin)
    v = make_voter(admin, app, "v1@example.com")
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": []}).status_code == 422
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a, b]}).status_code == 422  # max 1
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [99999]}).status_code == 422
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": ["1"]}).status_code == 422
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]}).status_code == 201
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [b]}).status_code == 409  # already voted
    cats = v.get("/api/bootstrap").get_json()["categories"]
    assert cats[0]["has_voted"] is True


def test_multi_vote_category(app, admin):
    cid, (a, b, c) = setup_election(admin, max_votes=2)
    v = make_voter(admin, app, "v2@example.com")
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a, b, c]}).status_code == 422
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a, a]}).status_code == 422
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a, c]}).status_code == 201
    res = admin.get("/api/results").get_json()["categories"][0]
    assert res["total_votes"] == 2 and res["ballots"] == 1


def test_nominee_must_belong_to_category(app, admin):
    cid1, (a, *_rest) = setup_election(admin)
    cid2 = admin.post("/api/admin/categories", {"title": "Other"}).get_json()["id"]
    other = admin.post("/api/admin/nominees", {"category_id": cid2, "name": "Zed"}).get_json()["id"]
    v = make_voter(admin, app, "v3@example.com")
    assert v.post(f"/api/categories/{cid1}/ballot", {"nominee_ids": [other]}).status_code == 422


def test_closed_category_rejects_votes_and_reopens(app, admin):
    cid, (a, *_rest) = setup_election(admin)
    v = make_voter(admin, app, "v4@example.com")
    admin.put(f"/api/admin/categories/{cid}", {"active": False})
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]}).status_code == 409
    admin.put(f"/api/admin/categories/{cid}", {"active": True})
    assert v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]}).status_code == 201


def test_ballot_secrecy(app, admin):
    cid, (a, *_rest) = setup_election(admin, nominees=("Secret Nominee", "Other"))
    v = make_voter(admin, app, "secret@example.com")
    v.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]})
    db = raw_db(app)
    assert {r["name"] for r in db.execute("PRAGMA table_info(votes)")} == {"id", "category_id", "nominee_id"}
    assert db.execute("SELECT COUNT(*) FROM ballots WHERE user_id IS NOT NULL").fetchone()[0] == 1
    details = [r["details"] for r in db.execute("SELECT details FROM audit_log WHERE action = 'BALLOT_SUBMITTED'")]
    assert details and all("Secret Nominee" not in d for d in details)


def test_double_submit_race_records_exactly_one_ballot(app, admin):
    cid, (a, *_rest) = setup_election(admin)
    v = make_voter(admin, app, "race@example.com")
    cookie = v.c.get_cookie("apex_session").value
    statuses = []

    def go():
        c = Client(app)
        c.c.set_cookie("apex_session", cookie)
        statuses.append(c.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]}).status_code)

    threads = [threading.Thread(target=go) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(statuses) == [201] + [409] * 7
    assert raw_db(app).execute("SELECT COUNT(*) FROM votes").fetchone()[0] == 1


# -------------------------------------------------------------- results
def test_results_ranking_ties_and_visibility(app, admin):
    cid, (a, b, c) = setup_election(admin)
    for i, pick in enumerate([a, b, c, a]):
        make_voter(admin, app, f"r{i}@example.com").post(f"/api/categories/{cid}/ballot", {"nominee_ids": [pick]})
    viewer = make_voter(admin, app, "viewer@example.com")
    res = viewer.get("/api/results").get_json()["categories"][0]
    assert res["total_votes"] == 4 and res["leader_ids"] == [a]
    assert [n["rank"] for n in res["nominees"]] == [1, 2, 2] and res["nominees"][0]["percentage"] == 50.0
    assert admin.put("/api/admin/settings", {"results_public": False}).status_code == 200
    hidden = viewer.get("/api/results").get_json()
    assert hidden["hidden"] is True and hidden["categories"] == []
    assert admin.get("/api/results").get_json()["categories"][0]["total_votes"] == 4
    assert "votes" not in str(viewer.get("/api/bootstrap").get_json()["categories"][0]["nominees"][0])


def test_nominee_with_votes_cannot_be_deleted_or_moved(app, admin):
    cid, (a, b, _c) = setup_election(admin)
    other = admin.post("/api/admin/categories", {"title": "Other"}).get_json()["id"]
    make_voter(admin, app, "d@example.com").post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]})
    assert admin.delete(f"/api/admin/nominees/{a}").status_code == 409
    assert admin.put(f"/api/admin/nominees/{a}", {"category_id": other}).status_code == 409
    assert admin.delete(f"/api/admin/nominees/{b}").status_code == 200


def test_delete_category_removes_everything_and_reconciles(app, admin):
    cid, (a, *_rest) = setup_election(admin)
    make_voter(admin, app, "e@example.com").post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]})
    assert admin.delete(f"/api/admin/categories/{cid}").status_code == 200
    db = raw_db(app)
    assert [db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("categories", "nominees", "ballots", "votes")] == [0, 0, 0, 0]
    assert admin.get("/api/admin/audit/verify").get_json()["chain_ok"] is True


# ---------------------------------------------------------------- audit
def test_audit_chain_verifies_and_detects_tampering(app, admin):
    cid, (a, *_rest) = setup_election(admin)
    make_voter(admin, app, "aud@example.com").post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]})
    v = admin.get("/api/admin/audit/verify").get_json()
    assert v["chain_ok"] and v["reconciliation_ok"] and v["entries_checked"] > 5

    db = raw_db(app)
    for stmt in ("UPDATE audit_log SET details='x' WHERE id=3", "DELETE FROM audit_log WHERE id=3"):
        try:
            db.execute(stmt)
            raise AssertionError("append-only trigger did not fire")
        except Exception as e:  # sqlite3.IntegrityError
            assert "append-only" in str(e)

    db.execute("DROP TRIGGER audit_log_no_update")  # an insider with raw DB access
    db.execute("UPDATE audit_log SET details='forged' WHERE id=3")
    db.commit()
    bad = admin.get("/api/admin/audit/verify").get_json()
    assert bad["chain_ok"] is False and bad["first_bad_id"] == 3


def test_reconciliation_flags_vote_stuffing(app, admin):
    cid, (a, *_rest) = setup_election(admin)
    make_voter(admin, app, "z@example.com").post(f"/api/categories/{cid}/ballot", {"nominee_ids": [a]})
    db = raw_db(app)
    db.execute("INSERT INTO votes(id, category_id, nominee_id) VALUES ('stuffed', ?, ?)", (cid, a))
    db.commit()
    assert admin.get("/api/admin/audit/verify").get_json()["reconciliation_ok"] is False


def test_audit_list_search_and_csv_export_neutralises_formulas(app, admin):
    admin.post("/api/admin/categories", {"title": "=HYPERLINK(\"http://evil\")"})
    rows = admin.get("/api/admin/audit?q=CATEGORY_CREATED").get_json()
    assert rows["total"] == 1
    import csv
    parsed = list(csv.reader(io.StringIO(admin.get("/api/admin/audit/export.csv").get_data(as_text=True))))
    assert parsed[0][:2] == ["id", "timestamp_utc"]
    created = next(r for r in parsed if r[4] == "CATEGORY_CREATED")
    assert created[5].startswith("'=HYPERLINK")  # leading apostrophe stops Excel evaluating it
    assert admin.get("/api/admin/audit?q=%25").get_json()["total"] == 0  # % is literal, not a wildcard


# ---------------------------------------------------------------- users
def test_bulk_import_creates_skips_and_dedupes(app, admin):
    make_voter(admin, app, "exists@example.com")
    csv_text = "Name,Email\nNew One,new1@example.com\nnew2@example.com\nDup,new1@example.com\nBad Row,not-an-email\nExists,exists@example.com\n"
    r = admin.post("/api/admin/users/import", {"csv": csv_text})
    body = r.get_json()
    assert r.status_code == 201 and [c["email"] for c in body["created"]] == ["new1@example.com", "new2@example.com"]
    assert len(body["skipped"]) == 3
    assert body["created"][1]["name"] == "New2"
    login = Client(app).login("new1@example.com", body["created"][0]["temp_password"])
    assert login.status_code == 200 and login.get_json()["user"]["must_change_password"] is True


def test_reset_password_issues_new_temp_and_unlocks(app, admin):
    v = make_voter(admin, app, "rp@example.com")
    uid = next(u["id"] for u in admin.get("/api/admin/users").get_json()["users"] if u["email"] == "rp@example.com")
    temp = admin.post(f"/api/admin/users/{uid}/reset-password").get_json()["temp_password"]
    assert v.get("/api/bootstrap").status_code == 401
    r = Client(app).login("rp@example.com", temp)
    assert r.status_code == 200 and r.get_json()["user"]["must_change_password"] is True


# --------------------------------------------------------------- images
def test_image_upload_is_validated_resized_and_served_only_to_signed_in_users(app, admin):
    cid = admin.post("/api/admin/categories", {"title": "C"}).get_json()["id"]
    bad = admin.post("/api/admin/nominees", data={"category_id": cid, "name": "Bad", "image": (io.BytesIO(b"<script>alert(1)</script>"), "x.png")},
                     content_type="multipart/form-data")
    assert bad.status_code == 422
    ok = admin.post("/api/admin/nominees", data={"category_id": cid, "name": "Good", "image": (io.BytesIO(png_bytes()), "photo.png")},
                    content_type="multipart/form-data")
    assert ok.status_code == 201
    nominee = admin.get("/api/admin/categories").get_json()["categories"][0]["nominees"][0]
    img = admin.get(nominee["image_url"])
    assert img.status_code == 200 and img.mimetype == "image/jpeg"
    from PIL import Image
    assert max(Image.open(io.BytesIO(img.data)).size) <= 900
    img.close()
    assert Client(app).get(nominee["image_url"]).status_code == 401
    assert admin.get("/media/..%2f..%2fetc%2fpasswd").status_code == 404
    assert admin.delete(f"/api/admin/nominees/{nominee['id']}").status_code == 200
    assert admin.get(nominee["image_url"]).status_code == 404  # file removed with the nominee


def test_oversized_upload_rejected(app, admin):
    cid = admin.post("/api/admin/categories", {"title": "C"}).get_json()["id"]
    big = io.BytesIO(b"\x00" * (7 * 1024 * 1024))
    r = admin.post("/api/admin/nominees", data={"category_id": cid, "name": "Big", "image": (big, "big.png")},
                   content_type="multipart/form-data")
    assert r.status_code == 413
