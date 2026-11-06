"""Route stubs that exist only to generate openapi.json. The real service implements these signatures."""

from __future__ import annotations

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from .entities import EntitiesData, EntitiesRequest
from .envelope import Envelope
from .fields import FieldsData
from .filter import FilterData, FilterRequest
from .search import SearchData, SearchRequest
from .tasks import TaskData

app = FastAPI(title="Scout Commons API", version="0.1.0",
              description="Public people and company layer. See 'Scout Commons — Long-term Architecture (v2)' §7.")

def accepted(model):
    return {202: {"model": Envelope[model], "description": "Some entities are computing live; see data.task_id."}}


def _stub():
    return JSONResponse({"code": 501, "status": "error", "error": "internal", "details": {"stub": True}}, 501)


@app.post("/v1/commons/search", response_model=Envelope[SearchData], responses=accepted(SearchData), tags=["commons"])
def search(body: SearchRequest, max_results: int = Query(20, ge=10, le=200)):
    return _stub()


@app.post("/v1/commons/filter", response_model=Envelope[FilterData], tags=["commons"])
def filter_(body: FilterRequest, max_results: int = Query(100, ge=0, le=1000)):
    return _stub()


@app.get("/v1/commons/entities/{entity_id}", response_model=Envelope[EntitiesData], responses=accepted(EntitiesData), tags=["commons"])
def get_entity(entity_id: str, max_age: str | None = None, allow_live: bool = True):
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
