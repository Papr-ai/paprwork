from commons.compute import compute_one, drain, requeue_previous
from commons.graph import Graph, normalize_domain


def test_normalize_domain():
    assert normalize_domain("https://WWW.Lemlist.com/pricing?x=1") == "lemlist.com"
    assert normalize_domain("sales@belkins.io") == "belkins.io"
    assert normalize_domain("lemlist.com:443") == "lemlist.com"
    for bad in ("", "localhost", "not a domain", "http://", "1.2.3"):
        assert normalize_domain(bad) is None


def test_ranks_lookalikes_and_drops_hubs(release):
    store, rel = release
    out = compute_one(store, rel, "lemlist.com")
    names = [n["domain"] for n in out["neighbors"]]
    assert out["status"] == "ready" and out["citers"] == 4  # hub.com was dropped
    assert names[:3] == ["smartlead.ai", "instantly.ai", "woodpecker.co"]
    assert out["neighbors"][0]["score"] == 1.0
    # popular.com shares 4 citers but is linked by everyone, so it ranks below
    assert names.index("popular.com") > names.index("smartlead.ai")
    # the seed's own subdomain is never a lookalike; hub.com is never a citer
    assert "app.lemlist.com" not in names and "lemlist.com" not in names
    assert all(n["shared_citers"] >= 3 for n in out["neighbors"])


def test_subdomain_falls_back_to_parent(release):
    store, rel = release
    out = compute_one(store, rel, "go.lemlist.com")
    assert out["status"] == "ready" and out["matched_domain"] == "lemlist.com"


def test_not_in_graph(release):
    store, rel = release
    assert compute_one(store, rel, "nobody-links-here.com")["status"] == "not_in_graph"
    assert compute_one(store, rel, "loner.org")["neighbors"] == []


def test_queue_drain_and_requeue(release):
    store, rel = release
    store.enqueue("lemlist.com")
    assert drain(store, budget_s=60, limit=10) == 1
    assert store.queued() == [] and store.get_neighbors(rel, "lemlist.com")["status"] == "ready"
    assert requeue_previous(store, rel) == 1 and store.queued() == ["lemlist.com"]


def test_graph_files_required(tmp_path):
    import pytest

    with pytest.raises(FileNotFoundError):
        Graph(tmp_path)
