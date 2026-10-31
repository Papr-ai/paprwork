import pytest
from fastapi.testclient import TestClient

from commons.api import app


@pytest.fixture()
def client(release, monkeypatch):
    store, _ = release
    monkeypatch.setenv("COMMONS_DATA_DIR", str(store.root))
    monkeypatch.delenv("COMMONS_API_KEYS", raising=False)
    monkeypatch.delenv("COMMONS_INLINE", raising=False)
    return TestClient(app)


def test_miss_queues_then_worker_fills(client, release):
    from commons.compute import drain

    store, rel = release
    r = client.get("/commons/v1/neighbors", params={"domain": "https://www.lemlist.com/", "k": 2})
    assert r.status_code == 202 and r.json()["status"] == "queued" and r.headers["Retry-After"]
    assert store.queued() == ["lemlist.com"]
    drain(store, 60, 10)
    r = client.get("/commons/v1/neighbors", params={"domain": "lemlist.com", "k": 2})
    body = r.json()
    assert r.status_code == 200 and body["status"] == "ready" and body["release"] == rel
    assert [n["domain"] for n in body["neighbors"]] == ["smartlead.ai", "instantly.ai"]


def test_inline_mode(client, monkeypatch):
    monkeypatch.setenv("COMMONS_INLINE", "1")
    r = client.get("/commons/v1/neighbors", params={"domain": "lemlist.com"})
    assert r.status_code == 200 and r.json()["neighbors"][0]["domain"] == "smartlead.ai"


def test_bad_input_and_key(client, monkeypatch):
    assert client.get("/commons/v1/neighbors", params={"domain": "nope"}).status_code == 400
    assert client.get("/commons/v1/neighbors", params={"domain": "a.com", "k": 501}).status_code == 422
    monkeypatch.setenv("COMMONS_API_KEYS", "k1,k2")
    assert client.get("/commons/v1/release").status_code == 401
    assert client.get("/commons/v1/release", headers={"X-API-Key": "k2"}).status_code == 200
    assert client.get("/commons/v1/health").status_code == 200  # health stays open


def test_no_release(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMONS_DATA_DIR", str(tmp_path))
    c = TestClient(app)
    assert c.get("/commons/v1/neighbors", params={"domain": "a.com"}).status_code == 503
    assert c.get("/commons/v1/health").json()["release"] is None
