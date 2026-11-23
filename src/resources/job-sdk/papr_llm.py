"""papr_llm: call Claude or ChatGPT from a Papr job or backend action.

Use this only when the work really belongs in a script (see APP_AND_JOBS_GUIDE
"Calling models from scripts"). For anything with reasoning, tools or several
steps, a sub-agent job is the better tool.

This is a thin client. The call goes to the Papr gateway (POST
/api/llm/complete), which runs it on the same stack chat and agent jobs use:

  * the same credential: API key or Claude / ChatGPT sign-in, refreshed for you
  * the same fallbacks: sign-in rate limit -> API key or Papr proxy; a refused
    credential -> the next provider you have connected
  * caching on by default: Claude cache_control on `system` and `context`
    (5 minute TTL, or cache_ttl="1h"); OpenAI prompt_cache_key on the same prefix
  * web search with web_search=True (Claude and ChatGPT)
  * one usage line per call (with cache reads and cost) in the job log

    from papr_llm import complete

    r = complete(
        "Which CRM should a 10-person startup use?",
        system="You are a neutral assistant.",
        provider="openai",          # or "anthropic"; default: your default model
        web_search=True,
    )
    print(r.text, r.usage)

Put fixed material (instructions, reference docs, examples) in `system` and
`context`, and per-request data in `prompt`. Anything that changes between calls
must come last, or it breaks the cache.

No API keys in the job: the gateway holds the credentials. Standard library only.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

__all__ = ["complete", "complete_json", "LLMResult", "LLMError"]

DEFAULT_GATEWAY = "http://127.0.0.1:18789"
_RETRY_STATUS = (502, 503, 504)


class LLMError(RuntimeError):
    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


@dataclass
class LLMResult:
    text: str
    provider: str
    model: str
    usage: Dict[str, int]
    cost_usd: float = 0.0
    route: str = ""
    retries: List[str] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)


def _gateway() -> str:
    return os.environ.get("PAPR_GATEWAY_URL", DEFAULT_GATEWAY).rstrip("/")


def _post(body: dict, timeout: float) -> dict:
    data = json.dumps(body).encode()
    url = f"{_gateway()}/api/llm/complete"
    last: Optional[Exception] = None
    for attempt in range(3):
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except ValueError:
                pass
            last = LLMError(f"Model call failed ({e.code}): {detail[:800]}", e.code)
            if e.code not in _RETRY_STATUS:
                raise last from None
        except urllib.error.URLError as e:
            last = LLMError(f"Papr gateway not reachable at {_gateway()}: {e.reason}")
        time.sleep(1.5 * (attempt + 1))
    raise last  # type: ignore[misc]


def complete(
    prompt: str,
    *,
    system: Optional[str] = None,
    context: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    web_search: bool = False,
    cache: bool = True,
    cache_ttl: str = "5m",
    temperature: Optional[float] = None,
    timeout: float = 300.0,
) -> LLMResult:
    """One model call. Returns LLMResult(text, provider, model, usage, cost_usd, ...).

    system    fixed instructions (cached)
    context   fixed reference material placed before the prompt (cached)
    prompt    the per-call request: put anything that varies here
    provider  "anthropic" | "openai" | None (your default model)
    model     a Papr model id, e.g. "claude-sonnet-4-6", "gpt-5-6-sol"
    """
    if cache_ttl not in ("5m", "1h"):
        raise LLMError("cache_ttl must be '5m' or '1h'")
    if provider not in (None, "anthropic", "openai"):
        raise LLMError("provider must be 'anthropic', 'openai' or None")
    body: Dict[str, Any] = {
        "prompt": prompt,
        "system": system,
        "context": context,
        "provider": provider,
        "model": model,
        "maxTokens": max_tokens,
        "webSearch": web_search,
        "cache": cache,
        "cacheTtl": cache_ttl,
    }
    if temperature is not None:
        body["temperature"] = temperature
    data = _post({k: v for k, v in body.items() if v is not None}, timeout)

    u = data.get("usage") or {}
    usage = {
        "input_tokens": int(u.get("inputTokens") or 0),
        "output_tokens": int(u.get("outputTokens") or 0),
        "cache_read_input_tokens": int(u.get("cacheReadTokens") or 0),
        "cache_creation_input_tokens": int(u.get("cacheWriteTokens") or 0),
    }
    result = LLMResult(
        text=data.get("text") or "",
        provider=data.get("provider") or "",
        model=data.get("model") or "",
        usage=usage,
        cost_usd=float(data.get("costUsd") or 0.0),
        route=data.get("route") or "",
        retries=list(data.get("retries") or []),
        raw=data,
    )
    print(
        f"[papr_llm] {result.provider}/{result.model} ({result.route}) in={usage['input_tokens']} "
        f"cache_read={usage['cache_read_input_tokens']} cache_write={usage['cache_creation_input_tokens']} "
        f"out={usage['output_tokens']} cost=${result.cost_usd:.4f}"
        + (f" retried={len(result.retries)}" if result.retries else ""),
        file=sys.stderr,
    )
    return result


def complete_json(prompt: str, **kwargs: Any) -> Any:
    """complete() and parse the first JSON object or array in the reply."""
    sys_note = "Reply with JSON only: no prose, no code fences."
    kwargs["system"] = f"{kwargs['system']}\n\n{sys_note}" if kwargs.get("system") else sys_note
    result = complete(prompt, **kwargs)
    text = result.text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("\n") + 1:] if "\n" in text else text
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise LLMError(f"No JSON in model reply: {result.text[:300]}")
    try:
        obj, _ = json.JSONDecoder().raw_decode(text[min(starts):])
    except ValueError as e:
        raise LLMError(f"Could not parse JSON from model reply: {e}: {result.text[:300]}") from None
    return obj
