#!/usr/bin/env python3
"""Administrative commands.

    python manage.py create-admin you@example.com "Your Name"
    python manage.py reset-password someone@example.com
    python manage.py verify-audit
    python manage.py seed-demo          # sample categories, nominees, voters and a few ballots
"""
import argparse
import getpass
import sys

from app import audit, create_app
from app.db import get_db, sync_directory, tx
from app.security import hash_password, hash_temp_password, temp_password, validate_new_password
from app.util import ApiError, clean_email, iso
from app.voting import cast_ballot


def create_admin(args):
    email = clean_email(args.email)
    password = getpass.getpass("Password (min 10 chars): ")
    if password != getpass.getpass("Repeat password: "):
        sys.exit("Passwords do not match.")
    validate_new_password(password, email)
    db = get_db()
    with tx(db):
        db.execute("INSERT INTO users(email, name, password_hash, role, must_change_password, active, listed, created_at) "
                   "VALUES (?,?,?,'admin',1,1,0,?)", (email, args.name, hash_password(password), iso()))
        audit.record(db, "ADMIN_CREATED", f"{args.name} <{email}> created via CLI", actor=("system", "system"))
    print(f"Administrator {email} created. They must change the password at first sign-in.")


def reset_password(args):
    email = clean_email(args.email)
    db = get_db()
    password = temp_password()
    with tx(db):
        row = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if not row:
            sys.exit("No such user.")
        db.execute("UPDATE users SET password_hash=?, must_change_password=1, failed_logins=0, locked_until=NULL WHERE id=?",
                   (hash_temp_password(password), row["id"]))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
        audit.record(db, "USER_PASSWORD_RESET", f"Temporary password issued to {email} via CLI", actor=("system", "system"))
    print(f"Temporary password for {email}: {password}")


def verify(_args):
    result = audit.verify(get_db())
    print(f"Audit chain: {'OK' if result['chain_ok'] else 'BROKEN at entry ' + str(result['first_bad_id'])}")
    print(f"Entries checked: {result['entries_checked']}")
    print(f"Chain head hash: {result['head_hash']}")
    for r in result["reconciliation"]:
        print(f"  {'OK ' if r['ok'] else 'BAD'} {r['title']}: {r['ballots']} ballots, "
              f"{r['votes']} votes (expected {r['expected_votes']})")
    sys.exit(0 if result["chain_ok"] and result["reconciliation_ok"] else 1)


def seed_demo(_args):
    db = get_db()
    if db.execute("SELECT 1 FROM categories LIMIT 1").fetchone():
        sys.exit("Database already has categories; refusing to seed.")
    system = ("system", "system")
    with tx(db):
        cats = {}
        for key, title, desc in [
            ("emp", "Employee of the Year 2026", "Recognizing extraordinary performance, leadership, and positive organizational impact."),
            ("inn", "Best Innovation Award", "Celebrating breakthrough ideas, products, or process improvements implemented this year."),
            ("com", "Community & Culture Hero", "Acknowledging team members who build community, mentor others, and champion company culture."),
        ]:
            cats[key] = db.execute("INSERT INTO categories(title, description, max_votes, active, created_at) VALUES (?,?,1,1,?)",
                                   (title, desc, iso())).lastrowid
        cats["peo"] = db.execute(
            "INSERT INTO categories(title, description, max_votes, active, mode, allow_self_vote, created_at) VALUES (?,?,1,1,'directory',0,?)",
            ("Colleague of the Month", "Open vote: pick any colleague who made your month easier.", iso())).lastrowid
        noms = {}
        for key, cat, name, bio in [
            ("sarah", "emp", "Sarah Jenkins", "Senior Engineering Lead who spearheaded the cloud modernization project, boosting platform efficiency by 40%."),
            ("david", "emp", "David Chen", "Global Operations Specialist known for establishing seamless cross-continental client support workflows."),
            ("amara", "emp", "Amara Okezie", "Product Manager who delivered 3 flagship features ahead of schedule while maintaining 98% user satisfaction."),
            ("quantum", "inn", "Project Quantum AI", "An internal automated analytics platform reducing operational reporting time from days to minutes."),
            ("eco", "inn", "EcoLogistics Portal", "A zero-waste logistics tracking module that reduced corporate carbon footprint by 22%."),
            ("elena", "com", "Elena Rostova", "Founder of the Peer Mentorship Program and organizer for local STEM outreach workshops."),
        ]:
            noms[key] = db.execute("INSERT INTO nominees(category_id, name, bio, created_at) VALUES (?,?,?,?)",
                                   (cats[cat], name, bio, iso())).lastrowid
        audit.record(db, "DEMO_SEEDED", "Sample categories and nominees created", actor=system)

    voters = {}
    with tx(db):
        for name, email, dept in [("Alice Dlamini", "alice@example.com", "Engineering"), ("Bob Nkosi", "bob@example.com", "Operations"),
                                  ("Charlie Mamba", "charlie@example.com", "Finance"), ("Dana Mokoena", "dana@example.com", "People and Culture"),
                                  ("Evan Smith", "evan@example.com", "Operations")]:
            pw = temp_password()
            uid = db.execute("INSERT INTO users(email, name, password_hash, role, must_change_password, active, listed, department, created_at) "
                             "VALUES (?,?,?,'voter',1,1,1,?,?)", (email, name, hash_temp_password(pw), dept, iso())).lastrowid
            voters[email] = (uid, pw)
        sync_directory(db)
        audit.record(db, "DEMO_SEEDED", "Demo voters created", actor=system)

    def user(email):
        return {"id": voters[email][0], "email": email, "role": "voter"}

    cast_ballot(db, user("alice@example.com"), cats["emp"], [noms["sarah"]])
    cast_ballot(db, user("bob@example.com"), cats["emp"], [noms["sarah"]])
    cast_ballot(db, user("charlie@example.com"), cats["emp"], [noms["amara"]])
    cast_ballot(db, user("alice@example.com"), cats["inn"], [noms["quantum"]])

    def candidate(email):
        return db.execute("SELECT id FROM nominees WHERE category_id = ? AND user_id = ?",
                          (cats["peo"], voters[email][0])).fetchone()["id"]
    cast_ballot(db, user("alice@example.com"), cats["peo"], [candidate("bob@example.com")])
    cast_ballot(db, user("charlie@example.com"), cats["peo"], [candidate("bob@example.com")])
    cast_ballot(db, user("bob@example.com"), cats["peo"], [candidate("dana@example.com")])

    print("Demo data created. Demo voters (temporary passwords, must be changed at first sign-in):")
    for email, (_uid, pw) in voters.items():
        print(f"  {email:24} {pw}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("create-admin"); p.add_argument("email"); p.add_argument("name"); p.set_defaults(fn=create_admin)
    p = sub.add_parser("reset-password"); p.add_argument("email"); p.set_defaults(fn=reset_password)
    sub.add_parser("verify-audit").set_defaults(fn=verify)
    sub.add_parser("seed-demo").set_defaults(fn=seed_demo)
    args = parser.parse_args()
    app = create_app()
    with app.app_context():
        try:
            args.fn(args)
        except ApiError as e:
            sys.exit(e.message)


if __name__ == "__main__":
    main()
