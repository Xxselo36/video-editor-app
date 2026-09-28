"""Lemon Squeezy subscriptions: checkout, customer portal, webhooks and
reconciliation. Plain urllib (like src/license.py) — no SDK.

OFF until all of these are set (and auth is on, see backend/auth.py):

    LEMONSQUEEZY_API_KEY          API key (test-mode keys see test data only)
    LEMONSQUEEZY_STORE_ID         numeric store id
    LEMONSQUEEZY_WEBHOOK_SECRET   signing secret of the store's webhook
    LEMONSQUEEZY_VARIANT_STARTER  variant id per plan; at least one
    LEMONSQUEEZY_VARIANT_PRO
    LEMONSQUEEZY_VARIANT_STUDIO

and refused (logged, GET /billing/config says why) while the SQLite DB is
on /tmp, where subscriptions and the minutes ledger would vanish on the
next deploy. Billing on only means checkout / portal / usage display
work; uploads are refused without a plan only with CLEO_BILLING_ENFORCE=1.

State is kept in backend/accounts.py. Every subscription webhook re-reads
the subscription from the API (payloads can arrive late and out of order,
timestamps have 1 s resolution) and an hourly loop re-syncs everything,
because webhooks sent while the backend redeploys can be lost for good.

Only backend/main.py imports this module; calls block (urllib), so they
run in FastAPI's threadpool.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from backend import accounts
from backend.accounts import PLAN_MINUTES, PLAN_ORDER
from backend.auth import User, auth_enabled
from backend.jobs import retention_days

API_BASE = "https://api.lemonsqueezy.com/v1"
CLERK_API = "https://api.clerk.com/v1"
PLAN_NAMES = {"starter": "Starter", "pro": "Pro", "studio": "Studio"}

SUBSCRIPTION_EVENTS = {
    "subscription_created", "subscription_updated", "subscription_cancelled",
    "subscription_resumed", "subscription_expired", "subscription_paused",
    "subscription_unpaused", "subscription_plan_changed",
}
# These carry a subscription *invoice*, not the subscription.
INVOICE_EVENTS = {
    "subscription_payment_success", "subscription_payment_failed",
    "subscription_payment_recovered", "subscription_payment_refunded",
}
# Invoices that start a new quota period (not "updated" = proration).
_PERIOD_REASONS = ("initial", "renewal")

_SYNC_EVERY_S = 3600


class LemonSqueezyError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"Lemon Squeezy HTTP {status}: {detail[:300]}")
        self.status = status


class AlreadySubscribed(Exception):
    def __init__(self, portal_url: str | None):
        super().__init__("already_subscribed")
        self.portal_url = portal_url


# ── configuration ────────────────────────────────────────────────────


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def store_id() -> str:
    return _env("LEMONSQUEEZY_STORE_ID")


def variants() -> dict[str, str]:
    """plan → LS variant id, for the plans that are configured."""
    out = {}
    for plan in PLAN_ORDER:
        v = _env(f"LEMONSQUEEZY_VARIANT_{plan.upper()}")
        if v:
            out[plan] = v
    return out


def plan_for_variant(variant_id: Any) -> str | None:
    for plan, v in variants().items():
        if str(variant_id) == v:
            return plan
    return None


def status() -> tuple[bool, str | None]:
    """(enabled, reason it isn't)."""
    if not auth_enabled():
        return False, "auth_disabled"
    missing = [k for k in ("LEMONSQUEEZY_API_KEY", "LEMONSQUEEZY_STORE_ID",
                           "LEMONSQUEEZY_WEBHOOK_SECRET") if not _env(k)]
    if missing:
        return False, "missing " + ", ".join(missing)
    if not variants():
        return False, "missing LEMONSQUEEZY_VARIANT_<PLAN>"
    if not accounts.db_is_persistent():
        return False, "db_not_persistent"
    return True, None


def enabled() -> bool:
    return status()[0]


def enforce() -> bool:
    """CLEO_BILLING_ENFORCE=1: uploads need a plan with minutes left."""
    return enabled() and _env("CLEO_BILLING_ENFORCE").lower() in (
        "1", "true", "yes")


def log_status() -> None:
    """Called at startup. Loud when keys are set but billing is refused."""
    on, reason = status()
    if on:
        print(f"[billing] enabled — enforce={enforce()}, "
              f"test_mode={accounts.test_mode()}, "
              f"plans={sorted(variants())}", flush=True)
    elif reason == "db_not_persistent":
        print("[billing] !!! BILLING DISABLED: the job DB is on /tmp "
              f"({accounts.db_path()}), subscriptions and minutes would be "
              "wiped on every deploy. Mount a volume at /data or set "
              "CLEO_JOB_DB to a persistent path. !!!", flush=True)
    elif _env("LEMONSQUEEZY_API_KEY"):
        print(f"[billing] disabled: {reason}", flush=True)


# ── HTTP ─────────────────────────────────────────────────────────────


def _ls_request(method: str, path: str, body: dict | None = None,
                timeout: float = 15.0) -> dict[str, Any]:
    """One JSON:API call. `path` is relative to API_BASE, or a full
    API_BASE URL (pagination links). Raises LemonSqueezyError."""
    url = path if path.startswith(API_BASE) else API_BASE + path
    if not url.startswith(API_BASE + "/"):
        raise LemonSqueezyError(0, f"refusing non-API URL {url[:80]}")
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "Accept": "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
            "Authorization": f"Bearer {_env('LEMONSQUEEZY_API_KEY')}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read()[:500].decode(errors="replace")
        raise LemonSqueezyError(e.code, detail) from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise LemonSqueezyError(0, str(e)) from None


def clerk_email(user_id: str) -> str | None:
    """Primary email from the Clerk Backend API (needs CLERK_SECRET_KEY);
    session tokens don't carry one."""
    key = _env("CLERK_SECRET_KEY")
    if not key:
        return None
    req = urllib.request.Request(
        f"{CLERK_API}/users/{urllib.parse.quote(user_id, safe='')}",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"[billing] clerk user lookup failed: {e}", flush=True)
        return None
    primary = d.get("primary_email_address_id")
    for e in d.get("email_addresses") or []:
        if e.get("id") == primary:
            return e.get("email_address")
    return None


def user_email(user: User, client_email: str | None = None) -> str | None:
    """Stored email, else the token's, else Clerk's (then stored), else
    what the client sent."""
    row = accounts.ensure_user(user.id, user.email)
    if row.get("email"):
        return row["email"]
    email = clerk_email(user.id)
    if email:
        accounts.ensure_user(user.id, email)
        return email
    return client_email or None


# ── subscriptions ────────────────────────────────────────────────────


def _sub_row(data: dict[str, Any], user_id: str) -> dict[str, Any]:
    """accounts.subscriptions row from an LS subscription object."""
    a = data.get("attributes") or {}
    urls = a.get("urls") or {}
    return {
        "id": str(data.get("id")),
        "user_id": user_id,
        "variant_id": str(a.get("variant_id")),
        "plan": plan_for_variant(a.get("variant_id")),
        "status": a.get("status"),
        "test_mode": 1 if a.get("test_mode") else 0,
        "customer_id": str(a.get("customer_id") or ""),
        "renews_at": accounts.parse_ts(a.get("renews_at")),
        "ends_at": accounts.parse_ts(a.get("ends_at")),
        # Signed and short-lived; GET /billing/portal fetches fresh ones.
        "portal_url": urls.get("customer_portal"),
        "update_payment_url": urls.get("update_payment_method"),
        "raw_json": accounts.dump_json(a),
        "created_at": accounts.parse_ts(a.get("created_at")),
        "ls_updated_at": accounts.parse_ts(a.get("updated_at")),
    }


def fetch_subscription(sub_id: str) -> dict[str, Any]:
    return _ls_request("GET", f"/subscriptions/{sub_id}")["data"]


def refresh_period(sub_id: str) -> None:
    """Period start from the latest paid initial/renewal invoice."""
    q = urllib.parse.urlencode({"filter[subscription_id]": sub_id,
                                "page[size]": 100})
    resp = _ls_request("GET", f"/subscription-invoices?{q}")
    best = 0.0
    for inv in resp.get("data") or []:
        a = inv.get("attributes") or {}
        if a.get("billing_reason") in _PERIOD_REASONS and a.get("status") == "paid":
            best = max(best, accounts.parse_ts(a.get("created_at")) or 0.0)
    if best:
        accounts.set_period_start(sub_id, best)


def _period_stale(sub: dict[str, Any], now: float) -> bool:
    start = sub.get("period_start")
    return not start or accounts.add_months(start, 1) <= now


def refresh_user(user_id: str, now: float | None = None) -> None:
    """Re-read a user's subscriptions from LS when the local copy looks
    stale (renewal/end date passed, or last sync > 1 h) — covers lost
    webhooks. Never raises; the local state is used on errors."""
    now = time.time() if now is None else now
    for sub in accounts.subscriptions_for(user_id):
        since = now - (sub.get("updated_at") or 0)
        passed = sub.get("status") != "expired" and any(
            (sub.get(k) or now + 1) < now for k in ("renews_at", "ends_at"))
        if since < 300 or not (passed or since > _SYNC_EVERY_S):
            continue
        try:
            row = _sub_row(fetch_subscription(sub["id"]), user_id)
            if row["plan"]:
                accounts.upsert_subscription(row)
            cur = accounts.get_subscription(sub["id"]) or sub
            if accounts.grants_access(cur, now) and _period_stale(cur, now):
                refresh_period(sub["id"])
        except (LemonSqueezyError, KeyError, TypeError) as e:
            print(f"[billing] refresh of subscription {sub['id']} failed: "
                  f"{e}", flush=True)


def _match_by_email(data: dict[str, Any]) -> str | None:
    """User for a CleoCuts subscription we have no row for (its
    subscription_created webhook was lost): the one account with the
    checkout email, if exactly one."""
    email = (data.get("attributes") or {}).get("user_email")
    if not email:
        return None
    users = accounts.users_by_email(email)
    return users[0]["id"] if len(users) == 1 else None


def reconcile(now: float | None = None) -> int:
    """Re-sync every subscription of the store (hourly). Returns how many
    rows were written."""
    now = time.time() if now is None else now
    known = accounts.all_subscription_ids()
    q = urllib.parse.urlencode({"filter[store_id]": store_id(),
                                "page[size]": 100})
    url: str | None = f"/subscriptions?{q}"
    written = 0
    for _ in range(100):  # pages
        if not url:
            break
        resp = _ls_request("GET", url)
        for data in resp.get("data") or []:
            sid = str(data.get("id"))
            if sid in known:
                user_id = accounts.get_subscription(sid)["user_id"]
            else:
                if plan_for_variant((data.get("attributes") or {}
                                     ).get("variant_id")) is None:
                    continue  # another product in the store
                user_id = _match_by_email(data)
                if not user_id:
                    continue
                print(f"[billing] reconcile: attached subscription {sid} "
                      f"to {user_id} by email", flush=True)
            row = _sub_row(data, user_id)
            if not row["plan"]:
                continue
            if accounts.upsert_subscription(row):
                written += 1
            cur = accounts.get_subscription(sid)
            if cur and accounts.grants_access(cur, now) and _period_stale(cur, now):
                try:
                    refresh_period(sid)
                except LemonSqueezyError as e:
                    print(f"[billing] invoices of {sid}: {e}", flush=True)
        url = (resp.get("links") or {}).get("next")
    return written


def reconcile_loop() -> None:
    """Daemon thread started by main.lifespan (like _retention_loop)."""
    time.sleep(60)
    while True:
        try:
            if enabled():
                n = reconcile()
                if n:
                    print(f"[billing] reconcile updated {n} subscription(s)",
                          flush=True)
        except Exception as e:
            print(f"[billing] reconcile failed: {e}", flush=True)
        time.sleep(_SYNC_EVERY_S)


# ── webhook ──────────────────────────────────────────────────────────


def verify_signature(raw: bytes, signature: str) -> bool:
    """X-Signature = hex HMAC-SHA256 of the raw body. Compared as bytes:
    compare_digest on str raises TypeError for non-ASCII input."""
    secret = _env("LEMONSQUEEZY_WEBHOOK_SECRET")
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(
        expected.encode(), signature.strip().encode("latin-1", "replace"))


def process_event(payload: dict[str, Any]) -> dict[str, Any]:
    """Apply one verified webhook. Returns a small result for the log /
    response; raises when LS should retry (→ HTTP 500)."""
    meta = payload.get("meta") or {}
    event = str(meta.get("event_name") or "")
    data = payload.get("data") or {}
    attrs = data.get("attributes") or {}
    if event in SUBSCRIPTION_EVENTS:
        sub_id = str(data.get("id") or "")
        key = f"{event}:{sub_id}:{attrs.get('updated_at')}"
        is_invoice = False
    elif event in INVOICE_EVENTS:
        sub_id = str(attrs.get("subscription_id") or "")
        key = f"{event}:{data.get('id')}"
        is_invoice = True
    else:
        return {"ignored": f"event {event or '?'}"}
    if not sub_id:
        return {"ignored": "no subscription id"}
    if str(attrs.get("store_id")) != store_id():
        print(f"[billing] webhook {event} for store {attrs.get('store_id')} "
              "ignored", flush=True)
        return {"ignored": "other store"}
    if accounts.event_seen(key):
        return {"duplicate": True}

    existing = accounts.get_subscription(sub_id)
    custom = meta.get("custom_data") or {}
    user_id = str(custom.get("user_id") or "") or (
        existing["user_id"] if existing else "")
    if not user_id:
        # Other products in the store (SmartCut desktop), purchases via
        # hosted links / the dashboard: not ours.
        print(f"[billing] webhook {event} {sub_id} without user_id ignored",
              flush=True)
        return {"ignored": "no user_id"}

    try:
        fresh: dict[str, Any] | None = fetch_subscription(sub_id)
    except LemonSqueezyError as e:
        print(f"[billing] refetch of subscription {sub_id} failed ({e}); "
              "using the webhook payload", flush=True)
        if is_invoice:
            if existing is None:
                raise  # nothing to attach the invoice to yet → LS retries
            fresh = None
        else:
            fresh = data
    row = _sub_row(fresh, user_id) if fresh is not None else None
    if row is not None and row["plan"] is None:
        print(f"[billing] webhook {event} {sub_id}: unknown variant "
              f"{row['variant_id']} ignored", flush=True)
        return {"ignored": "unknown variant"}

    period = None
    if (event == "subscription_payment_success"
            and attrs.get("billing_reason") in _PERIOD_REASONS
            and attrs.get("status", "paid") == "paid"):
        period = accounts.parse_ts(attrs.get("created_at"))

    accounts.ensure_user(user_id)

    def _apply(conn):
        if row is not None:
            accounts.upsert_subscription_tx(conn, row)
        if period:
            accounts.set_period_start_tx(conn, sub_id, period)

    applied = accounts.apply_event(key, _apply)
    return {"applied": applied, "subscription": sub_id,
            "status": row["status"] if row else None}


# ── checkout / portal / config ───────────────────────────────────────


def portal_url(user_id: str) -> str | None:
    """Fresh (signed, expiring) customer-portal URL of the user's current
    subscription, or their latest one."""
    ent = accounts.entitlement(user_id)
    sub = (ent.subscription if ent and ent.subscription
           else accounts.latest_subscription(user_id))
    if not sub:
        return None
    try:
        data = fetch_subscription(sub["id"])
    except LemonSqueezyError as e:
        print(f"[billing] portal lookup failed: {e}", flush=True)
        return sub.get("portal_url")
    row = _sub_row(data, user_id)
    if row["plan"]:
        accounts.upsert_subscription(row)
    return row["portal_url"] or sub.get("portal_url")


def create_checkout(user: User, plan: str,
                    client_email: str | None = None) -> str:
    """LS checkout URL for `plan`. Raises KeyError for an unknown plan,
    AlreadySubscribed when a subscription already grants access (plan
    changes go through the portal), LemonSqueezyError on API errors."""
    variant = variants()[plan]
    ent = accounts.entitlement(user.id)
    if ent is not None and ent.source == "subscription":
        raise AlreadySubscribed(portal_url(user.id))
    email = user_email(user, client_email)
    app_url = (_env("CLEO_APP_URL") or "https://cleocuts.com").rstrip("/")
    checkout_data: dict[str, Any] = {"custom": {"user_id": user.id}}
    if email:
        checkout_data["email"] = email
    body = {"data": {
        "type": "checkouts",
        "attributes": {
            "checkout_data": checkout_data,
            "product_options": {
                "redirect_url": f"{app_url}/app/account?billing=success",
                "enabled_variants": [int(variant)] if variant.isdigit() else [],
            },
            "test_mode": accounts.test_mode(),
        },
        "relationships": {
            "store": {"data": {"type": "stores", "id": store_id()}},
            "variant": {"data": {"type": "variants", "id": variant}},
        },
    }}
    if not body["data"]["attributes"]["product_options"]["enabled_variants"]:
        del body["data"]["attributes"]["product_options"]["enabled_variants"]
    resp = _ls_request("POST", "/checkouts", body)
    return resp["data"]["attributes"]["url"]


_CURRENCY_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£"}
_price_lock = threading.Lock()
_price_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def format_price(cents: int, currency: str | None) -> str:
    amount = f"{cents / 100:.2f}"
    sym = _CURRENCY_SYMBOLS.get((currency or "").upper())
    return f"{sym}{amount}" if sym else f"{amount} {currency or ''}".strip()


def _cached(key: str, fetch) -> dict[str, Any]:
    """1 h cache for price lookups (5 min for failures)."""
    now = time.time()
    with _price_lock:
        hit = _price_cache.get(key)
    if hit and now - hit[0] < (_SYNC_EVERY_S if hit[1] else 300):
        return hit[1]
    try:
        value = fetch()
    except (LemonSqueezyError, KeyError, TypeError, ValueError) as e:
        print(f"[billing] {key} lookup failed: {e}", flush=True)
        value = {}
    with _price_lock:
        _price_cache[key] = (now, value)
    return value


def _variant_price(variant_id: str) -> dict[str, Any]:
    store = _cached(f"store:{store_id()}", lambda: {
        "currency": _ls_request("GET", f"/stores/{store_id()}", timeout=5)
        ["data"]["attributes"]["currency"]})

    def fetch():
        a = _ls_request("GET", f"/variants/{variant_id}",
                        timeout=5)["data"]["attributes"]
        cents = int(a["price"])
        return {"price": cents, "currency": store.get("currency"),
                "price_formatted": (format_price(cents, store["currency"])
                                    if store.get("currency") else None),
                "interval": a.get("interval")}
    return _cached(f"variant:{variant_id}", fetch)


def config() -> dict[str, Any]:
    """GET /billing/config (public): whether billing is on and the plans."""
    on, reason = status()
    configured = variants()
    plans = []
    for plan in PLAN_ORDER:
        vid = configured.get(plan)
        price = _variant_price(vid) if on and vid else {}
        plans.append({
            "id": plan,
            "name": PLAN_NAMES[plan],
            "minutes": PLAN_MINUTES[plan],
            "retention_days": retention_days(plan),
            "price_formatted": price.get("price_formatted"),
            "price": price.get("price"),
            "currency": price.get("currency"),
            "interval": price.get("interval"),
            "available": bool(on and vid),
        })
    out: dict[str, Any] = {"enabled": on, "enforce": enforce(),
                           "test_mode": accounts.test_mode(), "plans": plans}
    if reason:
        out["reason"] = reason
    return out
