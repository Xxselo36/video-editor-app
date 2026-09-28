"""POST /billing/webhook: signature, idempotency, ordering, refetch."""
from __future__ import annotations

import json

import pytest

from backend import accounts, billing
from conftest import STORE_ID, fixture_payload, sign


def _post(client, payload, secret=None, signature=None):
    raw = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
    sig = signature if signature is not None else sign(raw, *(
        [secret] if secret else []))
    return client.post("/billing/webhook", content=raw,
                       headers={"X-Signature": sig,
                                "Content-Type": "application/json"})


def test_webhook_off_without_billing(client, auth_on):
    raw = b"{}"
    r = client.post("/billing/webhook", content=raw,
                    headers={"X-Signature": sign(raw)})
    assert r.status_code == 404


def test_signature_is_checked_on_raw_bytes(client, billing_on):
    raw = b'{"meta": {"event_name": "order_created"},  "data": {}}'
    assert _post(client, raw).status_code == 200
    assert _post(client, raw, secret="wrong").status_code == 400
    assert _post(client, raw, signature="").status_code == 400
    # Re-serialised body (different whitespace) → different signature.
    reser = json.dumps(json.loads(raw)).encode()
    assert _post(client, reser, signature=sign(raw)).status_code == 400
    # Non-ASCII header must be a clean 400, not a TypeError / 500.
    r = client.post("/billing/webhook", content=raw,
                    headers={"X-Signature": "ä".encode("latin-1")})
    assert r.status_code == 400
    assert billing.verify_signature(raw, "ä") is False


def test_real_fixture_signature(client, billing_on):
    from conftest import FIXTURES
    raw = (FIXTURES / "subscription_created.json").read_bytes()
    r = _post(client, raw)
    assert r.status_code == 200
    # The capture has no custom user_id (it's another app's checkout).
    assert r.json()["ignored"] == "no user_id"
    assert accounts.get_subscription("1221875") is None


def test_created_refetches_subscription(client, billing_on):
    ls = billing_on
    ls.sub("1221875", status="active", variant="795658")
    r = _post(client, fixture_payload("subscription_created.json", "user_a"))
    assert r.status_code == 200, r.text
    assert r.json()["applied"] is True
    sub = accounts.get_subscription("1221875")
    # The API said active; the (older) payload said on_trial.
    assert sub["status"] == "active"
    assert sub["user_id"] == "user_a" and sub["plan"] == "pro"
    assert ("GET", "/subscriptions/1221875", None) in ls.calls
    assert accounts.get_user("user_a") is not None


def test_refetch_failure_falls_back_to_payload(client, billing_on):
    billing_on.down = True
    r = _post(client, fixture_payload("subscription_created.json", "user_a"))
    assert r.status_code == 200
    sub = accounts.get_subscription("1221875")
    assert sub["status"] == "on_trial"
    assert sub["test_mode"] == 1
    assert sub["renews_at"] == accounts.parse_ts("2025-05-30T13:50:46Z")


def test_duplicate_delivery_is_applied_once(client, billing_on):
    billing_on.sub("1221875")
    payload = fixture_payload("subscription_created.json", "user_a")
    assert _post(client, payload).json()["applied"] is True
    calls = len(billing_on.calls)
    r = _post(client, payload)
    assert r.status_code == 200 and r.json()["duplicate"] is True
    assert len(billing_on.calls) == calls  # no second refetch


def test_out_of_order_events_do_not_roll_back(client, billing_on):
    billing_on.down = True  # payloads only, so ordering matters
    newer = fixture_payload("subscription_updated.json", "user_a")
    newer["data"]["attributes"]["status"] = "active"
    newer["data"]["attributes"]["updated_at"] = "2025-05-23T13:51:24.000000Z"
    older = fixture_payload("subscription_created.json", "user_a")
    assert _post(client, newer).status_code == 200
    assert _post(client, older).status_code == 200  # arrives late
    sub = accounts.get_subscription("1221875")
    assert sub["status"] == "active"
    assert sub["ls_updated_at"] == accounts.parse_ts("2025-05-23T13:51:24Z")


def test_missing_user_id_uses_existing_subscription(client, billing_on):
    billing_on.down = True
    _post(client, fixture_payload("subscription_created.json", "user_a"))
    upd = fixture_payload("subscription_updated.json")  # no user_id
    upd["data"]["attributes"]["status"] = "cancelled"
    upd["data"]["attributes"]["ends_at"] = "2099-01-01T00:00:00.000000Z"
    r = _post(client, upd)
    assert r.status_code == 200 and r.json()["applied"] is True
    sub = accounts.get_subscription("1221875")
    assert sub["user_id"] == "user_a" and sub["status"] == "cancelled"


def test_unknown_variant_and_other_store_are_ignored(client, billing_on):
    billing_on.down = True
    p = fixture_payload("subscription_created.json", "user_a")
    p["data"]["attributes"]["variant_id"] = 999
    assert _post(client, p).json()["ignored"] == "unknown variant"
    p = fixture_payload("subscription_created.json", "user_a")
    p["data"]["attributes"]["store_id"] = 1
    assert _post(client, p).json()["ignored"] == "other store"
    assert accounts.get_subscription("1221875") is None


def test_processing_error_is_500_and_retry_works(client, billing_on,
                                                 monkeypatch):
    billing_on.sub("1221875")
    payload = fixture_payload("subscription_created.json", "user_a")
    real = accounts.upsert_subscription_tx
    boom = {"n": 1}

    def flaky(conn, sub):
        if boom["n"]:
            boom["n"] -= 1
            raise RuntimeError("disk hiccup")
        return real(conn, sub)
    monkeypatch.setattr(accounts, "upsert_subscription_tx", flaky)
    assert _post(client, payload).status_code == 500
    assert accounts.get_subscription("1221875") is None
    # The idempotency key was rolled back with the failed write.
    r = _post(client, payload)
    assert r.status_code == 200 and r.json()["applied"] is True
    assert accounts.get_subscription("1221875")["status"] == "active"


def test_payment_success_sets_period(client, billing_on):
    billing_on.sub("1221875", status="active")
    _post(client, fixture_payload("subscription_created.json", "user_a"))
    r = _post(client, fixture_payload("subscription_payment_success.json",
                                      "user_a"))
    assert r.status_code == 200 and r.json()["applied"] is True
    sub = accounts.get_subscription("1221875")
    assert sub["period_start"] == accounts.parse_ts("2025-05-23T13:50:49Z")
    # A late, older initial invoice never moves the period back.
    old = fixture_payload("subscription_payment_success.json", "user_a")
    old["data"]["id"] = "999"
    old["data"]["attributes"]["created_at"] = "2025-04-01T00:00:00Z"
    _post(client, old)
    sub = accounts.get_subscription("1221875")
    assert sub["period_start"] == accounts.parse_ts("2025-05-23T13:50:49Z")
    # Proration invoices don't start a period.
    upd = fixture_payload("subscription_payment_success.json", "user_a")
    upd["data"]["id"] = "1000"
    upd["data"]["attributes"]["billing_reason"] = "updated"
    upd["data"]["attributes"]["created_at"] = "2025-06-01T00:00:00Z"
    _post(client, upd)
    assert accounts.get_subscription("1221875")["period_start"] == \
        accounts.parse_ts("2025-05-23T13:50:49Z")


def test_invoice_before_subscription_is_retried(client, billing_on):
    billing_on.down = True
    r = _post(client, fixture_payload("subscription_payment_success.json",
                                      "user_a"))
    assert r.status_code == 500  # nothing to attach it to yet → LS retries
    billing_on.down = False
    billing_on.sub("1221875", status="active")
    r = _post(client, fixture_payload("subscription_payment_success.json",
                                      "user_a"))
    assert r.status_code == 200
    sub = accounts.get_subscription("1221875")
    assert sub["status"] == "active" and sub["period_start"]


def test_unhandled_events_are_acknowledged(client, billing_on):
    r = _post(client, {"meta": {"event_name": "order_created"}, "data": {}})
    assert r.status_code == 200 and "ignored" in r.json()
    assert _post(client, b"[1, 2]").status_code == 400
    assert _post(client, b"not json").status_code == 400


def test_reconcile(billing_on):
    ls = billing_on
    # Known subscription whose cancellation webhook was lost.
    ls.sub("s1", status="expired", updated_at="2026-09-20T00:00:00Z")
    accounts.upsert_subscription(billing._sub_row(
        {"id": "s1", "attributes": {**ls.subs["s1"]["attributes"],
                                    "status": "active",
                                    "updated_at": "2026-09-01T00:00:00Z"}},
        "user_a"))
    # Unknown CleoCuts subscription (created webhook lost) → matched by email.
    accounts.ensure_user("user_c", "c@example.com")
    ls.sub("s2", status="active", user_email="C@example.com", variant="111")
    ls.invoices["s2"] = [{"attributes": {
        "billing_reason": "renewal", "status": "paid",
        "created_at": "2026-09-15T00:00:00Z"}}]
    # Another product in the same store.
    ls.sub("s3", status="active", variant="424242", user_email="c@example.com")
    assert billing.reconcile() == 2
    assert accounts.get_subscription("s1")["status"] == "expired"
    s2 = accounts.get_subscription("s2")
    assert s2["user_id"] == "user_c" and s2["plan"] == "starter"
    assert s2["period_start"] == accounts.parse_ts("2026-09-15T00:00:00Z")
    assert accounts.get_subscription("s3") is None


@pytest.mark.parametrize("name", [
    "subscription_created.json", "subscription_updated.json",
    "subscription_updated_on_trial.json", "subscription_payment_success.json"])
def test_all_fixtures_process(client, billing_on, name):
    billing_on.down = True
    if name == "subscription_payment_success.json":
        _post(client, fixture_payload("subscription_created.json", "user_a"))
    r = _post(client, fixture_payload(name, "user_a"))
    assert r.status_code == 200, r.text
    assert accounts.get_subscription("1221875")["user_id"] == "user_a"
    assert STORE_ID == "179021"
