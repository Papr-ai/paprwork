import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from commons_contract import Company, EntitiesRequest, FilterRequest, SearchRequest
from commons_contract.app import app

DOC_FILTERS = {
    "country": "US",
    "size_band": ["11-50", "51-200"],
    "employees": {"gte": 11, "lte": 200},
    "uses": {"all": ["hubspot", "segment"]},
    "industry": {"not": ["staffing"]},
    "tech_added": {"vendor": "hubspot", "since": "90d"},
    "has": ["open_jobs", "logo"],
}


def test_doc_filter_example_parses():
    r = FilterRequest(filters=DOC_FILTERS)
    assert r.filters.root["employees"].gte == 11


def test_doc_search_example_parses():
    SearchRequest(query="seed-stage devtools selling to platform teams", seeds=["gong.io", "clari.com"],
                  filters={"country": "US", "uses": ["hubspot"]}, exclude={"in_private_layer": True},
                  explain=True, max_age_hours=720, external_user_id="user_alice_123")


def test_search_without_query_or_seeds_is_rejected():
    with pytest.raises(ValidationError, match="/v1/commons/filter"):
        SearchRequest(filters={"country": "US"})


@pytest.mark.parametrize("bad", [
    {"Country": "US"},                    # bad key
    {"employees": {}},                    # empty range
    {"employees": {"gte": 1, "near": 2}}, # unknown operator
    {"has": "logo"},                      # has must be a list
    {"tech_added": {"vendor": "x", "since": "soon"}},
])
def test_bad_filters_rejected(bad):
    with pytest.raises(ValidationError):
        FilterRequest(filters=bad)


def test_unknown_request_keys_rejected():
    with pytest.raises(ValidationError):
        FilterRequest(filters={}, max_resluts=10)


def test_batch_limit():
    EntitiesRequest(ids=["a.com"] * 1000)
    with pytest.raises(ValidationError):
        EntitiesRequest(ids=["a.com"] * 1001)


def test_company_requires_freshness():
    with pytest.raises(ValidationError):
        Company(entity_id="c_1", domain="gong.io")
    c = Company(entity_id="c_1", domain="gong.io", source="batch", as_of="2026-10-12T00:00:00Z",
                release="cc-2026q3", stale=False)
    assert c.coverage == "full" and c.provisional is False


def test_openapi_is_committed_and_current():
    committed = json.loads((Path(__file__).parent.parent / "openapi.json").read_text())
    assert committed == json.loads(json.dumps(app.openapi(), sort_keys=True)), "run: python gen_openapi.py > openapi.json"


@pytest.mark.parametrize("hours,ok", [(-1, True), (0, True), (720, True), (-2, False), (9000, False)])
def test_max_age_hours(hours, ok):
    if ok:
        SearchRequest(seeds=["gong.io"], max_age_hours=hours)
    else:
        with pytest.raises(ValidationError):
            SearchRequest(seeds=["gong.io"], max_age_hours=hours)


@pytest.mark.parametrize("uid", ["alice@acme.com", "Alice Smith"])
def test_external_user_id_must_be_opaque(uid):
    with pytest.raises(ValidationError):
        SearchRequest(seeds=["gong.io"], external_user_id=uid)


def test_old_freshness_controls_removed():
    with pytest.raises(ValidationError):
        SearchRequest(seeds=["gong.io"], allow_live=False)


def test_company_is_typed_and_versioned():
    c = Company(entity_id="c_1", domain="gong.io", source="live", as_of="2026-11-05T00:00:00Z",
                release="cc-2026q3", stale=False, provisional=True, confidence="lower",
                uses=[{"vendor": "hubspot", "first_seen": "2026-09-01", "last_seen": "2026-11-01",
                       "evidence_url": "https://gong.io/"}])
    assert c.type == "company" and c.schema_version == 1 and c.uses[0].evidence_url


def test_envelope_has_request_id_and_messages():
    from commons_contract.envelope import Envelope
    e = Envelope[dict](request_id="r_1", data={}, notices=[{"code": "EMBEDDING_ONLY_LOOKALIKES", "message": "x"}])
    assert e.request_id == "r_1" and e.notices[0].code == "EMBEDDING_ONLY_LOOKALIKES"
    with pytest.raises(ValidationError):
        Envelope[dict](data={})
