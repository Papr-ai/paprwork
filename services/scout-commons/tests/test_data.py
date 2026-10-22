"""Patterns, job boards and dataset definitions against a mocked network."""

import gzip
import json
from datetime import datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from commons import ats, http, patterns, recipes
from commons.api import app
from commons.compute import drain
from commons.store import Store

TEAM = """<html><body><h2>Our team</h2>
<p>Jane Doe, CEO - <a href="mailto:jane.doe@acme.com">jane.doe@acme.com</a></p>
<p>Bob Smith, CTO - bob.smith@acme.com</p>
<p>Write to info@acme.com or sales@acme.com. Partner: carl.jones@other.com (Carl Jones)</p>
<a href="https://jobs.ashbyhq.com/acme">Careers</a> <a href="https://github.com/acme">GitHub</a>
</body></html>"""


def route(req: httpx.Request) -> httpx.Response:
    u = str(req.url)
    if u.endswith("/robots.txt"):
        return httpx.Response(200, text="User-agent: *\nDisallow: /private\n")
    if u == "https://acme.com/team" or u == "https://acme.com/":
        return httpx.Response(200, html=TEAM)
    if u.startswith("https://dns.google/resolve"):
        return httpx.Response(200, json={"Answer": [{"type": 15, "data": "1 aspmx.l.google.com."}]})
    if u == "https://api.ashbyhq.com/posting-api/job-board/acme":
        jobs = [{"publishedAt": "2026-10-01T00:00:00Z"}, {"publishedAt": "2026-10-20"}]
        return httpx.Response(200, json={"jobs": jobs})
    if u.startswith("https://data.example.gov/api/views/abcd-1234.json"):
        cols = [
            {"fieldName": "issued", "dataTypeName": "calendar_date"},
            {"fieldName": "expires", "dataTypeName": "calendar_date"},
            {"fieldName": "name", "dataTypeName": "text"},
            {"fieldName": "kind", "dataTypeName": "text"},
        ]
        return httpx.Response(200, json={"columns": cols})
    if u.startswith("https://data.example.gov/resource/abcd-1234.json"):
        assert "kind IN ('NEW')" in req.url.params["$where"]
        return httpx.Response(200, json=[{"newest": "2026-10-20T00:00:00.000", "n": "42"}])
    return httpx.Response(404)


@pytest.fixture(autouse=True)
def net(monkeypatch):
    monkeypatch.setattr(http, "MIN_GAP_S", 0)
    monkeypatch.setattr(http, "CHECK_IP", False)
    monkeypatch.delenv("COMMONS_GITHUB_TOKEN", raising=False)
    http.set_transport(httpx.MockTransport(route))
    yield
    http.set_transport(None)


def test_classify():
    names = [("Jane", "Doe")]
    assert patterns.classify("jane.doe", names) == "first.last"
    assert patterns.classify("jdoe", names) == "flast"
    assert patterns.classify("info", names) is None
    assert patterns.classify("zz", names) is None
    assert patterns.classify("jose.nunez", [("José", "Núñez")]) == "first.last"


def test_pattern_stores_no_addresses(tmp_path):
    s = Store(tmp_path)
    out = patterns.compute_pattern(s, "acme.com")
    assert out["pattern"] == "first.last" and out["samples"] == 2 and out["confidence"] == "confirmed"
    assert out["provider"] == "google" and out["sources"] == ["https://acme.com/", "https://acme.com/team"]
    raw = (tmp_path / "patterns" / "acme.com.json").read_text()
    assert "@" not in raw and "jane" not in raw and "carl" not in raw


def test_robots_respected(tmp_path):
    with http.client() as c:
        assert http.get_text(c, "https://acme.com/private/x")[0] == -1


def test_ats_from_site(tmp_path):
    out = ats.compute_ats(Store(tmp_path), "acme.com")
    assert out["boards"] == [
        {
            "vendor": "ashby",
            "slug": "acme",
            "url": "https://jobs.ashbyhq.com/acme",
            "jobs_open": 2,
            "newest_posted": "2026-10-20",
            "found_via": "site",
        }
    ]


def test_ats_links_and_index_slugs():
    assert ("greenhouse", "acme") in ats.find_links("https://boards.greenhouse.io/acme/jobs/1")
    assert ("recruitee", "acme") in ats.find_links("https://acme.recruitee.com/o/x")
    assert ats.find_links("https://jobs.lever.co/embed") == set()
    assert ats.slug_from("co,lever,jobs)/acme/123 2026", "co,lever,jobs)/", "path") == "acme"
    assert ats.slug_from("com,recruitee,acme)/o/x 2026", "com,recruitee,", "host") == "acme"
    lines = [("a", "s0", 0, 1), ("co,lever,jobs)/a", "s1", 1, 1), ("co,lever,jobs)/m", "s2", 2, 1), ("d", "s3", 3, 1)]
    assert [b[0] for b in ats._blocks(lines, "co,lever,jobs)/")] == ["s0", "s1", "s2"]


def test_ats_index(tmp_path, monkeypatch):
    rows = "co,lever,jobs)/acme/1 x\nco,lever,jobs)/acme/2 x\nco,lever,jobs)/beta x\n"
    block = gzip.compress(rows.encode())

    def cc(req):
        u = str(req.url)
        if u.endswith("cluster.idx"):
            return httpx.Response(200, text=f"co,lever,jobs)/acme 1\tcdx-00001.gz\t0\t{len(block)}\t1\n")
        if "cdx-00001.gz" in u:
            return httpx.Response(206, content=block)
        return httpx.Response(200, content=gzip.compress(b"zz"))

    http.set_transport(httpx.MockTransport(cc))
    s = Store(tmp_path)
    meta = ats.build_index(s, "CC-MAIN-TEST")
    assert meta["boards"]["lever"] == 2
    out = ats.index_boards(s, "lever", 0, 10)
    assert [b["slug"] for b in out["boards"]] == ["acme", "beta"] and out["boards"][0]["pages_seen"] == 2


def recipe(**kw):
    base = dict(
        domain="data.example.gov",
        dataset_id="abcd-1234",
        title="Example licenses",
        geo_state="TX",
        signal_type="new_license",
        date_col="issued",
        date_kind="issued",
        name_col="name",
        event_filter={"kind": ["NEW"]},
        reason_template="Licensed on {date}",
    )
    return recipes.Recipe(**{**base, **kw})


def test_recipe_checks(tmp_path):
    s = Store(tmp_path)
    now = datetime(2026, 10, 22)
    ok = recipes.validate(s, recipes.submit(s, recipe())["id"], now)
    assert ok["status"] == "validated" and ok["rows_90d"] == 42
    bad = recipes.validate(s, recipes.submit(s, recipe(date_col="expires"))["id"], now)
    assert bad["status"] == "rejected" and "expiry" in bad["reasons"][0]
    missing = recipes.validate(s, recipes.submit(s, recipe(name_col="nope"))["id"], now)
    assert missing["status"] == "rejected"
    stale = recipes.validate(s, recipes.submit(s, recipe(title="Later"))["id"], datetime(2027, 3, 1))
    assert stale["status"] == "stale"
    assert [r["id"] for r in recipes.list_recipes(s, "tx", None, None)] == [ok["id"]]
    with pytest.raises(ValueError):
        recipe(event_filter={"kind; drop": ["x"]})
    with pytest.raises(ValueError):
        recipe(reason_template="no date here")


def test_api_queue_then_ready(tmp_path, monkeypatch):
    monkeypatch.setenv("COMMONS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("COMMONS_INLINE", raising=False)
    monkeypatch.delenv("COMMONS_API_KEYS", raising=False)
    c = TestClient(app)
    assert c.get("/commons/v1/pattern", params={"domain": "acme.com"}).status_code == 202
    assert c.get("/commons/v1/ats", params={"domain": "acme.com"}).status_code == 202
    r = c.post("/commons/v1/recipes", json=recipe().model_dump())
    assert r.status_code == 202 and r.json()["status"] == "pending"
    assert c.get("/commons/v1/recipes", params={"state": "TX"}).json()["count"] == 0
    drain(Store(tmp_path), 60, 100)
    assert c.get("/commons/v1/pattern", params={"domain": "acme.com"}).json()["pattern"] == "first.last"
    assert c.get("/commons/v1/ats", params={"domain": "acme.com"}).json()["boards"][0]["slug"] == "acme"
    assert c.get("/commons/v1/recipes", params={"state": "TX"}).json()["count"] == 1
    assert c.get("/commons/v1/ats/boards", params={"vendor": "lever"}).status_code == 503


def test_optout(tmp_path, monkeypatch):
    from commons.compute import main

    monkeypatch.setenv("COMMONS_DATA_DIR", str(tmp_path))
    s = Store(tmp_path)
    patterns.compute_pattern(s, "acme.com")
    main(["--data-dir", str(tmp_path), "--optout", "acme.com"])
    assert not (tmp_path / "patterns" / "acme.com.json").exists()
    body = TestClient(app).get("/commons/v1/pattern", params={"domain": "www.acme.com"}).json()
    assert body["status"] == "opted_out" and json.dumps(body).count("@") == 0


def test_seed_recipes_parse():
    items = json.loads(recipes.SEEDS.read_text())
    assert len(items) >= 6 and all(recipes.Recipe(**i) for i in items)


def test_private_addresses_blocked(monkeypatch):
    monkeypatch.setattr(http, "CHECK_IP", True)
    http.set_transport(None)
    with http.client() as c:
        assert http.get_text(c, "http://127.0.0.1:9/")[0] == 0
