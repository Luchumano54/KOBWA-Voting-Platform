import os
from pathlib import Path
import pytest
from app.db import _sqlite_to_pg, is_postgres, SCHEMA_PG

def test_is_postgres_detection():
    assert is_postgres("postgresql://user:pass@ep-xyz.render.com/mydb") is True
    assert is_postgres("postgres://user:pass@ep-xyz.render.com/mydb") is True
    assert is_postgres("instance/apexrewards.db") is False
    assert is_postgres("t.db") is False
    assert is_postgres(None) is False
    assert is_postgres("") is False

def test_sqlite_to_pg_translation():
    assert _sqlite_to_pg("SELECT * FROM users WHERE email = ?") == "SELECT * FROM users WHERE email = %s"
    assert _sqlite_to_pg("INSERT INTO t VALUES (?, ?, ?)") == "INSERT INTO t VALUES (%s, %s, %s)"
    
    # String literals with question marks should be preserved
    sql_with_literal = "SELECT * FROM t WHERE title = 'Who?' AND cat = ?"
    assert _sqlite_to_pg(sql_with_literal) == "SELECT * FROM t WHERE title = 'Who?' AND cat = %s"
    
    # Multiple IN clauses
    sql_in = "SELECT * FROM nominees WHERE category_id = ? AND id IN (?, ?, ?)"
    assert _sqlite_to_pg(sql_in) == "SELECT * FROM nominees WHERE category_id = %s AND id IN (%s, %s, %s)"

def test_postgres_schema_file_exists_and_contains_expected_tables():
    assert SCHEMA_PG.exists()
    content = SCHEMA_PG.read_text(encoding="utf-8")
    for table in ("users", "sessions", "settings", "categories", "nominees", "ballots", "votes", "audit_log"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in content
    assert "audit_log_no_modify()" in content
    assert "audit_log_no_update" in content

