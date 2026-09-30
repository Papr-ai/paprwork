#!/usr/bin/env python3
"""App Files for jobs — register a file the job just wrote to disk.

The mini-app SDK (`papr.files.upload`) takes a browser `Blob`. A job has no
blob: it has a path. The Swift recorder writes `recording.wav`, ffmpeg writes
an MP3, a scraper writes a CSV. Without this helper the only thing a job could
store was the path string itself — which is what the meetings recorder did, and
why 41 rows now point at a directory layout that no longer exists.

A path is not a reference. It breaks when the workspace moves, means nothing on
another machine, and is empty for every visitor to a published app. A file id
survives all three, because resolution becomes someone else's problem.

Usage (stdlib only — no pip install):

    from papr_files import add, url, remove

    file_id = add("data/recordings/abc.wav")
    con.execute("UPDATE meetings SET audio_ref=? WHERE id=?", (file_id, mid))

The gateway streams the bytes from disk to object storage; they never pass
through this process. `add()` is idempotent — content-addressed, so re-running
a job returns the existing id instead of storing a second copy.

Env (injected by the job runner):
  APP_ID           — mini-app this job belongs to (from job.appIds)
  PAPR_GATEWAY_URL — gateway base, defaults to http://127.0.0.1:18789
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

DEFAULT_GATEWAY = "http://127.0.0.1:18789"

# Uploads are measured in GB, not KB. The gateway hashes the file, negotiates a
# ticket and streams every byte before it answers, so a short timeout here would
# abort transfers that were going to succeed.
UPLOAD_TIMEOUT_SECONDS = 60 * 60
CALL_TIMEOUT_SECONDS = 60


class PaprFilesError(RuntimeError):
    """A files operation failed. Message carries the gateway's own wording."""


def _gateway() -> str:
    return os.environ.get("PAPR_GATEWAY_URL", DEFAULT_GATEWAY).rstrip("/")


def _app_id(explicit: str | None) -> str:
    app_id = explicit or os.environ.get("APP_ID", "")
    if not app_id:
        raise PaprFilesError(
            "No app id. This job is not linked to a mini-app — set appIds on the "
            "job, or pass app_id= explicitly. Files belong to an app, not a job: "
            "jobs are replaceable, the app outlives them."
        )
    return app_id


def _post(path: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{_gateway()}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except (ValueError, AttributeError):
            pass
        raise PaprFilesError(f"{path} failed ({err.code}): {detail}") from err
    except urllib.error.URLError as err:
        raise PaprFilesError(
            f"Cannot reach the Papr gateway at {_gateway()} ({err.reason}). "
            "It runs with the desktop app; start Papr Work and retry."
        ) from err


def add(
    file_path: str,
    *,
    app_id: str | None = None,
    file_name: str | None = None,
    mime: str | None = None,
    scope: str = "app",
    keep_local: bool = True,
) -> str:
    """Register a local file with App Files and return its id.

    Store the returned id in your database, never `file_path`.

    `keep_local` defaults to True: the local copy stays until someone explicitly
    frees it. Deleting a user's only copy as a side effect of registering it
    would be the worst possible default.

    `scope="user"` keeps the file private to the person who made it even if the
    app is published — the right choice for recordings and anything personal.
    """
    resolved = os.path.abspath(file_path)
    if not os.path.isfile(resolved):
        raise PaprFilesError(f"No file at {resolved}")
    if os.path.getsize(resolved) == 0:
        # An empty file usually means the producer failed. Registering it would
        # hide that behind a valid-looking reference.
        raise PaprFilesError(f"Refusing to register an empty file: {resolved}")

    result = _post(
        "/api/files/upload",
        {
            "appId": _app_id(app_id),
            "filePath": resolved,
            "fileName": file_name,
            "mime": mime,
            "scope": scope,
            "keepLocal": keep_local,
        },
        UPLOAD_TIMEOUT_SECONDS,
    )

    file_id = result.get("id")
    if not file_id:
        raise PaprFilesError(f"Upload returned no file id: {result}")
    return str(file_id)


def _resolve(file_id: str, app_id: str | None) -> dict[str, Any]:
    return _post(
        "/api/files/url",
        {"appId": _app_id(app_id), "id": file_id},
        CALL_TIMEOUT_SECONDS,
    )


def url(file_id: str, *, app_id: str | None = None) -> str:
    """Resolve a file id to something readable — local path or signed URL.

    The gateway answers `{ location: {kind, path?}, url? }`: a local path when
    a copy is on this machine, a short-lived signed URL when it only exists in
    the cloud. Callers that just want "where is it" should not have to know the
    difference, so both collapse to one string here.
    """
    result = _resolve(file_id, app_id)
    location = result.get("location") or {}
    resolved = result.get("url") or location.get("path")
    if not resolved:
        reason = location.get("reason") or "no local copy and no cloud copy"
        raise PaprFilesError(f"File {file_id} is unavailable: {reason}")
    return str(resolved)


def local_path(file_id: str, *, app_id: str | None = None) -> str | None:
    """Local path when a copy is on this machine, else None.

    Jobs that process bytes (transcription, ffmpeg) need a real path, not a
    URL. Returning None rather than a signed URL keeps the caller honest about
    the download it would otherwise have to perform itself.
    """
    location = _resolve(file_id, app_id).get("location") or {}
    path = location.get("path") if location.get("kind") == "local" else None
    return str(path) if path and os.path.isfile(str(path)) else None


def remove(file_id: str, *, app_id: str | None = None) -> bool:
    """Delete a file and its stored bytes."""
    result = _post(
        "/api/files/delete",
        {"appId": _app_id(app_id), "id": file_id},
        CALL_TIMEOUT_SECONDS,
    )
    return bool(result.get("deleted"))
