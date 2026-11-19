"""Open-vote ("directory") categories: voters pick a person from the staff list, once per category."""
from conftest import Client, make_voter, raw_db

from app.db import connect, init_db


def user_id(admin, email):
    return next(u["id"] for u in admin.get("/api/admin/users").get_json()["users"] if u["email"] == email)


def directory(admin, title="Colleague of the Month", **extra):
    r = admin.post("/api/admin/categories", {"title": title, "mode": "directory", **extra})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["id"]


def staff_list(client, cid):
    cat = next(c for c in client.get("/api/bootstrap").get_json()["categories"] if c["id"] == cid)
    return cat, {n["name"]: n["id"] for n in cat["nominees"]}


def voters(admin, app, *emails):
    return [make_voter(admin, app, e, name=e.split("@")[0].title()) for e in emails]


def test_voters_see_the_staff_list_without_themselves_admins_or_unlisted_people(app, admin):
    cid = directory(admin)
    a, _b, _c = voters(admin, app, "ann@x.org", "ben@x.org", "cy@x.org")
    hidden = admin.post("/api/admin/users", {"email": "hidden@x.org", "name": "Hidden", "listed": False}).get_json()
    cat, people = staff_list(a, cid)
    assert cat["mode"] == "directory"
    assert sorted(people) == ["Ben", "Cy"]            # not Ann (self), not the admin, not the unlisted person
    assert hidden["user"]["listed"] is False


def test_directory_vote_is_once_per_category(app, admin):
    cid = directory(admin)
    a, _b = voters(admin, app, "ann@x.org", "ben@x.org")
    _cat, people = staff_list(a, cid)
    assert a.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Ben"]]}).status_code == 201
    again = a.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Ben"]]})
    assert again.status_code == 409
    assert a.get("/api/bootstrap").get_json()["categories"][0]["has_voted"] is True


def test_voting_for_yourself_is_rejected_unless_the_category_allows_it(app, admin):
    strict, lenient = directory(admin, "Strict"), directory(admin, "Lenient", allow_self_vote=True)
    (a,) = voters(admin, app, "ann@x.org")
    voters(admin, app, "ben@x.org")
    # Ann's own candidate row exists server-side even though she is not shown it; she must not be able to use it
    me = raw_db(app).execute("SELECT n.id FROM nominees n JOIN users u ON u.id = n.user_id WHERE n.category_id = ? AND u.email = 'ann@x.org'", (strict,)).fetchone()["id"]
    r = a.post(f"/api/categories/{strict}/ballot", {"nominee_ids": [me]})
    assert r.status_code == 422 and "yourself" in r.get_json()["error"]
    _cat, people = staff_list(a, lenient)
    assert "Ann" in people
    assert a.post(f"/api/categories/{lenient}/ballot", {"nominee_ids": [people["Ann"]]}).status_code == 201


def test_people_added_or_changed_later_flow_into_open_categories(app, admin):
    cid = directory(admin)
    (a,) = voters(admin, app, "ann@x.org")
    assert staff_list(a, cid)[1] == {}
    r = admin.post("/api/admin/users", {"email": "new@x.org", "name": "Newcomer", "department": "Finance"})
    assert r.status_code == 201
    cat, people = staff_list(a, cid)
    assert list(people) == ["Newcomer"] and cat["nominees"][0]["bio"] == "Finance"
    uid = user_id(admin, "new@x.org")
    admin.put(f"/api/admin/users/{uid}", {"name": "Newcomer Dlamini", "department": "Legal"})
    cat, people = staff_list(a, cid)
    assert list(people) == ["Newcomer Dlamini"] and cat["nominees"][0]["bio"] == "Legal"
    admin.put(f"/api/admin/users/{uid}", {"listed": False})
    assert staff_list(a, cid)[1] == {}
    admin.put(f"/api/admin/users/{uid}", {"listed": True})
    assert list(staff_list(a, cid)[1]) == ["Newcomer Dlamini"]


def test_unlisting_or_disabling_removes_a_person_from_the_list_but_keeps_their_votes(app, admin):
    cid = directory(admin)
    a, _b, _c = voters(admin, app, "ann@x.org", "ben@x.org", "cy@x.org")
    _cat, people = staff_list(a, cid)
    assert a.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Ben"]]}).status_code == 201
    admin.put(f"/api/admin/users/{user_id(admin, 'ben@x.org')}", {"active": False})
    (dee,) = voters(admin, app, "dee@x.org")
    assert "Ben" not in staff_list(dee, cid)[1]
    res = admin.get("/api/results").get_json()["categories"][0]
    assert [n["name"] for n in res["nominees"]] == ["Ben"] and res["total_votes"] == 1
    # a disabled person can no longer be chosen even by someone holding their candidate id
    (late,) = voters(admin, app, "late@x.org")
    assert late.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Ben"]]}).status_code == 422


def test_type_is_fixed_and_candidates_cannot_be_edited_by_hand(app, admin):
    cid = directory(admin)
    voters(admin, app, "ann@x.org")
    assert admin.put(f"/api/admin/categories/{cid}", {"mode": "nominees"}).status_code == 422
    assert admin.put(f"/api/admin/categories/{cid}", {"title": "Renamed"}).status_code == 200
    assert admin.post("/api/admin/nominees", {"category_id": cid, "name": "Manual"}).status_code == 409
    cand = raw_db(app).execute("SELECT id FROM nominees WHERE category_id = ?", (cid,)).fetchone()["id"]
    assert admin.put(f"/api/admin/nominees/{cand}", {"name": "Edited"}).status_code == 409
    assert admin.delete(f"/api/admin/nominees/{cand}").status_code == 409
    other = admin.post("/api/admin/categories", {"title": "Plain"}).get_json()["id"]
    manual = admin.post("/api/admin/nominees", {"category_id": other, "name": "Manual"}).get_json()["id"]
    assert admin.put(f"/api/admin/nominees/{manual}", {"category_id": cid}).status_code == 409
    listing = next(c for c in admin.get("/api/admin/categories").get_json()["categories"] if c["id"] == cid)
    assert listing["mode"] == "directory" and listing["nominees"] == [] and listing["candidates"] == 1


def test_multi_vote_open_category(app, admin):
    cid = directory(admin, max_votes=2)
    a, *_ = voters(admin, app, "ann@x.org", "ben@x.org", "cy@x.org", "dee@x.org")
    _cat, people = staff_list(a, cid)
    assert a.post(f"/api/categories/{cid}/ballot", {"nominee_ids": list(people.values())}).status_code == 422  # 3 > 2
    assert a.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Ben"], people["Cy"]]}).status_code == 201
    assert admin.get("/api/results").get_json()["categories"][0]["total_votes"] == 2


def test_results_list_only_people_with_votes(app, admin):
    cid = directory(admin)
    a, b, c, _d = voters(admin, app, "ann@x.org", "ben@x.org", "cy@x.org", "dee@x.org")
    _cat, people = staff_list(a, cid)
    a.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Dee"]]})
    b.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Dee"]]})
    c.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Ben"]]})
    res = c.get("/api/results").get_json()["categories"][0]
    assert res["mode"] == "directory" and res["total_votes"] == 3
    assert [(n["name"], n["votes"], n["rank"]) for n in res["nominees"]] == [("Dee", 2, 1), ("Ben", 1, 2)]
    assert res["leader_ids"] == [people["Dee"]]


def test_candidate_rows_are_created_up_front_so_votes_leak_nothing(app, admin):
    """If rows appeared when a vote arrived, row creation time/order would point at the voter."""
    cid = directory(admin)
    a, *_ = voters(admin, app, "ann@x.org", "ben@x.org", "cy@x.org")
    db = raw_db(app)
    before = db.execute("SELECT id, created_at FROM nominees WHERE category_id = ? ORDER BY id", (cid,)).fetchall()
    assert len(before) == 3                      # one per listed person, before anyone has voted
    _cat, people = staff_list(a, cid)
    a.post(f"/api/categories/{cid}/ballot", {"nominee_ids": [people["Ben"]]})
    after = db.execute("SELECT id, created_at FROM nominees WHERE category_id = ? ORDER BY id", (cid,)).fetchall()
    assert [tuple(r) for r in before] == [tuple(r) for r in after]
    assert {r["name"] for r in db.execute("PRAGMA table_info(votes)")} == {"id", "category_id", "nominee_id"}
    bootstrap_text = str(a.get("/api/bootstrap").get_json())
    assert "votes" not in bootstrap_text.replace("max_votes", "").replace("has_voted", "")


def test_import_reads_department_and_lists_people_but_admins_default_to_unlisted(app, admin):
    r = admin.post("/api/admin/users/import", {"csv": "Name,Email,Department\nZodwa Shongwe,zodwa@x.org,Operations\n"})
    assert r.status_code == 201
    users = {u["email"]: u for u in admin.get("/api/admin/users").get_json()["users"]}
    assert users["zodwa@x.org"]["department"] == "Operations" and users["zodwa@x.org"]["listed"] is True
    assert users["admin@example.com"]["listed"] is False
    made = admin.post("/api/admin/users", {"email": "boss@x.org", "name": "Boss", "role": "admin"}).get_json()["user"]
    assert made["listed"] is False


def test_database_from_the_first_release_is_upgraded_in_place(tmp_path):
    path = str(tmp_path / "old.db")
    db = connect(path)
    db.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
          password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'voter' CHECK (role IN ('admin','voter')),
          must_change_password INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
          failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, last_login_at TEXT, created_at TEXT NOT NULL);
        CREATE TABLE categories (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          max_votes INTEGER NOT NULL DEFAULT 1 CHECK (max_votes BETWEEN 1 AND 50), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE nominees (id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', image TEXT, created_at TEXT NOT NULL);
        INSERT INTO users(email,name,password_hash,role,created_at) VALUES ('a@x.org','Admin','h','admin','t'), ('v@x.org','Vera','h','voter','t');
        INSERT INTO categories(title,created_at) VALUES ('Old category','t');
        INSERT INTO nominees(category_id,name,created_at) VALUES (1,'Old nominee','t');
    """)
    init_db(db)
    init_db(db)  # idempotent
    assert [(r["email"], r["listed"], r["department"]) for r in db.execute("SELECT * FROM users ORDER BY id")] == [("a@x.org", 0, ""), ("v@x.org", 1, "")]
    assert db.execute("SELECT mode, allow_self_vote FROM categories").fetchone()[:] == ("nominees", 0)
    assert db.execute("SELECT name, user_id FROM nominees").fetchone()[:] == ("Old nominee", None)
    db.execute("INSERT INTO categories(title,mode,created_at) VALUES ('New open','directory','t')")
    from app.db import sync_directory
    sync_directory(db)
    assert db.execute("SELECT name FROM nominees WHERE user_id IS NOT NULL").fetchall()[0]["name"] == "Vera"
