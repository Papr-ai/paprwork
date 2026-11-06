"""Webhooks + events (§7.3 "ready event"), modelled on Exa's webhooks/events API.

Scout subscribes once; GET /v1/commons/events is the fallback for missed deliveries.
Event payloads carry entities only, never the user or install that triggered the work.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl

from .envelope import Strict

EventType = Literal[
    "commons.task.completed",   # a live compute (202) finished; data = TaskData
    "commons.task.failed",
    "commons.entity.updated",   # Phase 2: watched entity changed; data = { entity_id, changed_fields }
    "commons.release.activated" # new release went live; data = { release, previous }
]


class WebhookCreate(Strict):
    url: HttpUrl = Field(description="HTTPS endpoint. Deliveries are signed (HMAC-SHA256 in Commons-Signature).")
    events: list[EventType] = Field(min_length=1)


class Webhook(BaseModel):
    id: str
    url: str
    events: list[EventType]
    secret: str | None = Field(None, description="Returned once on create; used to verify signatures.")
    created_at: datetime


class Event(BaseModel):
    id: str
    type: EventType
    created_at: datetime
    data: dict[str, Any]


class EventsData(BaseModel):
    results: list[Event]
    next_cursor: str | None = None
