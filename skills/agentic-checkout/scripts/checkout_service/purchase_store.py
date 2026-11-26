"""Persist purchase revisions, checkout ownership and the event stream."""

import json
import time
from uuid import uuid4

from .attempts import UNKNOWN, order_binding


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


class PurchaseConflict(Exception):
    """The purchase no longer permits the requested transition."""


class PurchaseNotFound(Exception):
    """No purchase exists for this ID."""


class Purchases:
    def __init__(self, attempts):
        self.attempts = attempts
        self.connection = attempts.connection
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS purchases (
                    id TEXT PRIMARY KEY, request TEXT NOT NULL, merchant TEXT NOT NULL, country TEXT NOT NULL,
                    items TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', quote TEXT, result TEXT,
                    lease TEXT, expires_at REAL, sandbox_id TEXT, pid INTEGER, checkout_digest TEXT,
                    approved_at REAL, order_status TEXT, tracking TEXT
                );
                CREATE TABLE IF NOT EXISTS purchase_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id TEXT NOT NULL,
                    type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS purchase_events_lookup ON purchase_events(purchase_id, id);
                CREATE TABLE IF NOT EXISTS purchase_delivery (
                    sink TEXT PRIMARY KEY, delivered_through INTEGER NOT NULL
                );
                CREATE TRIGGER IF NOT EXISTS purchase_created AFTER INSERT ON purchases BEGIN
                    INSERT INTO purchase_events(purchase_id,type,data,created_at)
                    VALUES(new.id,'draft',json_object('status',new.status),unixepoch());
                END;
                CREATE TRIGGER IF NOT EXISTS purchase_changed AFTER UPDATE ON purchases
                WHEN old.status IS NOT new.status OR old.items IS NOT new.items OR old.quote IS NOT new.quote
                    OR old.result IS NOT new.result OR old.order_status IS NOT new.order_status
                    OR old.tracking IS NOT new.tracking BEGIN
                    INSERT INTO purchase_events(purchase_id,type,data,created_at)
                    VALUES(new.id,CASE WHEN old.status = new.status AND (old.order_status IS NOT new.order_status OR old.tracking IS NOT new.tracking)
                                       THEN 'order_updated' ELSE new.status END,
                        json_object('status',new.status,'quote_id',json_extract(new.quote,'$.id'),
                                    'result',json(new.result),'order_status',new.order_status,'tracking',json(new.tracking)),
                        unixepoch());
                END;
            """)
            db.execute("BEGIN IMMEDIATE")
            columns = {column["name"] for column in db.execute("PRAGMA table_info(purchases)")}
            for name, contract in {
                "channel": "TEXT NOT NULL DEFAULT 'e2b_test'", "currency": "TEXT",
                "native_ref": "TEXT", "native_url": "TEXT", "native_key": "TEXT",
                "native_subject": "TEXT", "native_terms": "TEXT",
            }.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE purchases ADD COLUMN {name} {contract}")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS purchase_shop_checkout ON purchases(native_ref)")

    @staticmethod
    def view(row):
        result = {key: row[key] for key in ("id", "merchant", "country", "status")}
        result["items"] = json.loads(row["items"])
        if row["channel"] == "shop_catalog":
            result.update(channel=row["channel"], currency=row["currency"])
            if row["native_url"] and row["status"] in ("quoted", "requires_action"):
                result["continue_url"] = row["native_url"]
        for key in ("quote", "result", "tracking"):
            if row[key] is not None:
                result[key] = json.loads(row[key])
        if row["order_status"]:
            result["order_status"] = row["order_status"]
        return result

    @staticmethod
    def row(db, purchase_id):
        row = db.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
        if row is None:
            raise PurchaseNotFound(purchase_id)
        return row

    def create(self, purchase_id, merchant, items, country, channel="e2b_test", currency=None):
        intent = [merchant, items, country]
        if channel == "shop_catalog":
            intent.extend((channel, currency))
        request = encode(intent)
        with self.connection() as db:
            db.execute("""INSERT INTO purchases(id, request, merchant, items, country, channel, currency)
                          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING""",
                       (purchase_id, request, merchant, encode(items), country, channel, currency))
            row = self.row(db, purchase_id)
            if row["request"] != request:
                raise PurchaseConflict("This request ID belongs to different purchase terms.")
            return self.view(row)

    def current(self, purchase_id):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.row(db, purchase_id)
            timed_state = row["status"] in ("preparing", "quoted") or (
                row["status"] == "requires_action" and (row["sandbox_id"] or row["native_ref"])
            )
            if timed_state and row["expires_at"] <= time.time():
                db.execute("UPDATE purchases SET status = 'expired' WHERE id = ?", (purchase_id,))
                row = self.row(db, purchase_id)
            return row

    def amend(self, purchase_id, items):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.row(db, purchase_id)
            if row["approved_at"] or row["native_ref"] or (
                row["status"] == "preparing" and row["expires_at"] > time.time()
            ):
                raise PurchaseConflict("This purchase is already being prepared or submitted.")
            if row["items"] == encode(items):
                return self.view(row), None
            db.execute("""UPDATE purchases SET items=?, status='draft', quote=NULL, result=NULL, lease=NULL,
                          sandbox_id=NULL, pid=NULL, checkout_digest=NULL, expires_at=NULL, native_key=NULL
                          WHERE id=?""",
                       (encode(items), purchase_id))
            return self.view(self.row(db, purchase_id)), row["sandbox_id"]

    def begin_prepare(self, purchase_id, shipping_options, expires_at):
        now = time.time()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.row(db, purchase_id)
            if row["approved_at"]:
                raise PurchaseConflict("This purchase has an approved attempt.")
            if row["status"] == "preparing" and row["expires_at"] > now:
                return row, None
            if row["status"] == "quoted" and row["expires_at"] > now:
                quote = json.loads(row["quote"])
                if not shipping_options or shipping_options == quote["shipping_options"]:
                    return row, None
            pending_selection = row["status"] == "requires_action" and row["sandbox_id"] and row["expires_at"] > now
            if pending_selection and not shipping_options:
                return row, None
            lease = uuid4().hex
            if shipping_options:
                if not pending_selection:
                    raise PurchaseConflict("Request current delivery options before selecting a rate.")
                options = json.loads(row["result"])["delivery_options"]
                if shipping_options.keys() != options.keys() or any(
                    choice["selected_option_id"] not in {option["id"] for option in options[group]}
                    for group, choice in shipping_options.items()
                ):
                    raise PurchaseConflict("Select a current rate for every delivery group.")
                db.execute("UPDATE purchases SET status='preparing', lease=?, result=NULL WHERE id=?",
                           (lease, purchase_id))
            else:
                db.execute("""UPDATE purchases SET status='preparing', lease=?, expires_at=?, quote=NULL, result=NULL,
                              sandbox_id=NULL, pid=NULL, checkout_digest=NULL WHERE id=?""", (lease, expires_at, purchase_id))
            return row, lease

    def finish_prepare(self, purchase_id, lease, status, *, quote=None, result=None, sandbox_id=None, pid=None,
                       digest=None, expires_at=None):
        with self.connection() as db:
            changed = db.execute("""UPDATE purchases SET status=?, quote=?, result=?, sandbox_id=?, pid=?,
                                checkout_digest=?, expires_at=COALESCE(?,expires_at), lease=NULL
                                WHERE id=? AND lease=? AND status='preparing'""",
                                 (status, encode(quote) if quote else None, encode(result) if result else None,
                                  sandbox_id, pid, digest, quote["expires_at"] if quote else expires_at, purchase_id, lease)).rowcount
            return self.view(self.row(db, purchase_id)), bool(changed)

    def claim(self, purchase_id, quote_id, checkout_host, receipt_deadline):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.row(db, purchase_id)
            quote = json.loads(row["quote"]) if row["quote"] else None
            if quote is None or quote["id"] != quote_id:
                raise PurchaseConflict("Approve the current quote.")
            if row["approved_at"]:
                return row, None
            if row["status"] != "quoted" or row["expires_at"] <= time.time():
                raise PurchaseConflict("The current quote has expired or is unavailable.")
            lease = uuid4().hex
            binding = order_binding(checkout_host, json.loads(row["items"]), quote["minor_units"], quote["currency"])
            self.attempts.claim_prepared(db, purchase_id, lease, row["checkout_digest"], row["sandbox_id"],
                                         binding, min(receipt_deadline, row["expires_at"] + 25))
            db.execute("UPDATE purchases SET status='submitting', approved_at=? WHERE id=?", (time.time(), purchase_id))
            return self.row(db, purchase_id), lease

    def release_claim(self, purchase_id, lease):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("DELETE FROM attempts WHERE approval_id=? AND lease=? AND result IS NULL",
                          (purchase_id, lease)).rowcount:
                db.execute("UPDATE purchases SET status='quoted', approved_at=NULL WHERE id=?", (purchase_id,))

    def synchronize(self, purchase_id):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.row(db, purchase_id)
            attempt = db.execute("SELECT * FROM attempts WHERE approval_id=?", (purchase_id,)).fetchone()
            if row["approved_at"] and attempt and attempt["result"]:
                result = json.loads(attempt["result"])
                if result["status"] == "submitted":
                    status = "submitted"
                elif result["status"] == UNKNOWN:
                    status = UNKNOWN
                elif result["status"] in ("manual_verification", "payment_method_unavailable"):
                    status = "requires_action"
                else:
                    status = "failed"
                db.execute("""UPDATE purchases SET status=?,result=?,order_status=CASE WHEN ?='submitted'
                              THEN COALESCE(order_status,'placed') ELSE order_status END WHERE id=?""",
                           (status, encode(result), status, purchase_id))
                row = self.row(db, purchase_id)
            return self.view(row)

    @staticmethod
    def event(row):
        return {**dict(row), "data": json.loads(row["data"])}

    def events(self, purchase_id, after):
        with self.connection() as db:
            self.row(db, purchase_id)
            return [self.event(row) for row in db.execute(
                "SELECT * FROM purchase_events WHERE purchase_id=? AND id>? ORDER BY id LIMIT 100", (purchase_id, after))]

    def next_delivery(self, sink):
        with self.connection() as db:
            row = db.execute("""SELECT * FROM purchase_events WHERE id > COALESCE(
                             (SELECT delivered_through FROM purchase_delivery WHERE sink=?),0)
                             ORDER BY id LIMIT 1""", (sink,)).fetchone()
            return self.event(row) if row else None

    def mark_delivered(self, sink, event_id):
        with self.connection() as db:
            db.execute("""INSERT INTO purchase_delivery(sink,delivered_through) VALUES(?,?)
                          ON CONFLICT(sink) DO UPDATE SET delivered_through=MAX(delivered_through,excluded.delivered_through)""",
                       (sink, event_id))

    def order_update(self, merchant, order_id, order_status="placed", tracking=None):
        priority = ("placed", "paid", "fulfilled")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""SELECT purchases.* FROM purchases JOIN attempts
                                ON attempts.approval_id=purchases.id WHERE merchant=?
                                AND json_extract(attempts.result,'$.status')='submitted'
                                AND json_extract(attempts.result,'$.order_id')=?""",
                             (merchant, order_id)).fetchone()
            if row is None:
                return
            status = max((row["order_status"] or "placed", order_status), key=priority.index)
            # Keep tracking from separate fulfillments and avoid emitting events for duplicates.
            entries = json.loads(row["tracking"]) if row["tracking"] else []
            for entry in tracking or []:
                if entry not in entries and len(entries) < 100:
                    entries.append(entry)
            db.execute("UPDATE purchases SET order_status=?, tracking=? WHERE id=?",
                       (status, encode(entries) if entries else None, row["id"]))
