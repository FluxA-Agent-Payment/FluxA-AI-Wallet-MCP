"""SQLite ownership and receipt state for a single checkout service."""

import hashlib
import json
import sqlite3
import time
from contextlib import closing, contextmanager
from uuid import uuid4

from .contract import ATTEMPT_TIMEOUT

RETRYABLE = frozenset({"credentials_unavailable", "browser_unavailable"})
UNKNOWN = "reconciliation_required"


def checkout_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def order_binding(host: str, items: dict, total: int, currency: str) -> str:
    return json.dumps([host, items, total, currency], sort_keys=True)


class Attempts:
    def __init__(self, path):
        self.path = path
        with self.connection() as db:
            # Serialize upgrades when multiple service processes use the same file.
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """CREATE TABLE IF NOT EXISTS attempts (
                    approval_id TEXT PRIMARY KEY, checkout_digest TEXT NOT NULL UNIQUE,
                    expires_at REAL NOT NULL, result TEXT, lease TEXT, sandbox_id TEXT, binding TEXT
                )"""
            )
            columns = {row["name"] for row in db.execute("PRAGMA table_info(attempts)")}
            for name in ("lease", "sandbox_id", "binding"):
                if name not in columns:
                    db.execute(f"ALTER TABLE attempts ADD COLUMN {name} TEXT")

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.row_factory = sqlite3.Row
            yield db

    def get(self, approval: str):
        with self.connection() as db:
            return db.execute("SELECT * FROM attempts WHERE approval_id = ?", (approval,)).fetchone()

    def reserve(self, approval: str):
        lease = uuid4().hex
        now = time.time()
        expires_at = now + ATTEMPT_TIMEOUT
        with self.connection() as db:
            claimed = db.execute(
                """INSERT INTO attempts (approval_id, checkout_digest, expires_at, lease)
                VALUES (?, ?, ?, ?) ON CONFLICT(approval_id) DO UPDATE SET
                    expires_at = excluded.expires_at, lease = excluded.lease,
                    result = NULL, sandbox_id = NULL, binding = NULL
                WHERE json_extract(result, '$.status') IN (?, ?)
                    OR (result IS NULL AND lease IS NOT NULL AND sandbox_id IS NULL AND expires_at <= ?)""",
                (approval, f"approval:{approval}", expires_at, lease, *sorted(RETRYABLE), now),
            ).rowcount
        return (lease, expires_at) if claimed else None

    def abandon(self, approval: str, lease: str):
        with self.connection() as db:
            db.execute("DELETE FROM attempts WHERE approval_id = ? AND lease = ? AND sandbox_id IS NULL",
                       (approval, lease))

    def dispatch(self, approval: str, lease: str, digest: str, sandbox_id: str, binding: str, expires_at: float):
        with self.connection() as db:
            return db.execute(
                """UPDATE attempts SET checkout_digest = ?, sandbox_id = ?, binding = ?
                WHERE approval_id = ? AND lease = ? AND sandbox_id IS NULL
                    AND checkout_digest IN (?, ?) AND expires_at > ? AND ? > ?""",
                (digest, sandbox_id, binding, approval, lease, f"approval:{approval}", digest,
                 time.time(), expires_at, time.time()),
            ).rowcount == 1

    @staticmethod
    def claim_prepared(db, approval, lease, digest, sandbox_id, binding, expires_at):
        db.execute("""INSERT INTO attempts(approval_id, checkout_digest, expires_at, lease, sandbox_id, binding)
                      VALUES(?, ?, ?, ?, ?, ?)""", (approval, digest, expires_at, lease, sandbox_id, binding))

    def finish(self, approval: str, lease: str, result: dict):
        with self.connection() as db:
            db.execute(
                """UPDATE attempts SET result = ?
                WHERE approval_id = ? AND lease = ?
                    AND (result IS NULL OR json_extract(result, '$.status') = ?)""",
                (json.dumps(result), approval, lease, UNKNOWN),
            )

    def record_order(self, digest: str, binding: str, order_id: str):
        with self.connection() as db:
            row = db.execute(
                """UPDATE attempts SET result = ?
                WHERE checkout_digest = ? AND binding = ? AND sandbox_id IS NOT NULL
                    AND (result IS NULL OR json_extract(result, '$.status') != 'submitted')
                RETURNING approval_id""",
                (json.dumps({"status": "submitted", "order_id": order_id}), digest, binding),
            ).fetchone()
            return row["approval_id"] if row else None
