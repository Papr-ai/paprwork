"""GET /v1/commons/tasks/{task_id}: live computes that returned 202 (§5.4, §7.3).

Task payloads carry entities only, never the user or install.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class TaskData(BaseModel):
    task_id: str
    state: Literal["queued", "running", "done", "failed"]
    entities: list[str]
    retry_after_s: int | None = Field(None, description="Hint while queued or running.")
    finished_at: datetime | None = None
    error: str | None = None
