"""Route stubs that exist only to generate openapi.json. The real service implements these signatures."""

from __future__ import annotations

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from .entities import EntitiesData, EntitiesRequest
from .events import EventsData, EventType, Webhook, WebhookCreate
from .envelope import Envelope
from .fields import FieldsData
from .filter import FilterData, FilterRequest
from .search import SearchData, SearchRequest
from .tasks import TaskData

app = FastAPI(title="Scout Commons API", version="0.1.0",
              description="Public people and company layer. See 'Scout Commons — Long-term Architecture (v2)' §7.")

ERRORS = {
    400: {"description": "Invalid request (error: invalid_request | unknown_field)."},
    401: {"description": "Missing or invalid credentials."},
    402: {"description": "Live-compute budget exceeded (live_budget_exceeded). Retry-After header set."},
    429: {"description": "Rate limited. Retry-After header set."},
    503: {"description": "Temporarily unavailable. Not processed and not counted against quotas."},
}


def accepted(model):
    return {**ERRORS, 202: {"model": Envelope[model], "description": "Some entities are computing live; see data.task_id."}}


def _stub():
    return JSONResponse({"code": 501, "status": "error", "request_id": "stub", "error": "internal", "details": {"message": "stub"}}, 501)


@app.post("/v1/commons/search", response_model=Envelope[SearchData], responses=accepted(SearchData), tags=["commons"])
def search(body: SearchRequest, max_results: int = Query(20, ge=10, le=200)):
    return _stub()


@app.post("/v1/commons/filter", response_model=Envelope[FilterData], responses=ERRORS, tags=["commons"])
def filter_(body: FilterRequest, max_results: int = Query(100, ge=0, le=1000)):
    return _stub()


@app.get("/v1/commons/entities/{entity_id}", response_model=Envelope[EntitiesData], responses=accepted(EntitiesData), tags=["commons"])
def get_entity(entity_id: str, max_age_hours: int | None = Query(None, ge=-1, le=8760)):
    return _stub()


@app.post("/v1/commons/entities", response_model=Envelope[EntitiesData], responses=accepted(EntitiesData), tags=["commons"])
def get_entities(body: EntitiesRequest):
    return _stub()


@app.get("/v1/commons/fields", response_model=Envelope[FieldsData], tags=["commons"])
def fields(entity: str = "company"):
    return _stub()


@app.get("/v1/commons/tasks/{task_id}", response_model=Envelope[TaskData], tags=["commons"])
def task(task_id: str):
    return _stub()


@app.post("/v1/commons/webhooks", response_model=Envelope[Webhook], responses=ERRORS, tags=["events"])
def create_webhook(body: WebhookCreate):
    return _stub()


@app.get("/v1/commons/webhooks", response_model=Envelope[list[Webhook]], tags=["events"])
def list_webhooks():
    return _stub()


@app.delete("/v1/commons/webhooks/{webhook_id}", response_model=Envelope[dict], tags=["events"])
def delete_webhook(webhook_id: str):
    return _stub()


@app.get("/v1/commons/events", response_model=Envelope[EventsData], tags=["events"])
def list_events(type: EventType | None = None, since: str | None = None, cursor: str | None = None):
    return _stub()
