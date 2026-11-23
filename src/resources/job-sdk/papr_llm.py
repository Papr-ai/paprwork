"""papr_llm: call Claude or ChatGPT from a Papr job or backend action.

Use this only when the work really belongs in a script (see APP_AND_JOBS_GUIDE
"Calling models from scripts"). For anything with reasoning, tools or several
steps, a sub-agent job is the better tool.

What it does for you:
  * Picks up the same credential chat uses. Papr puts it in ANTHROPIC_API_KEY /
    OPENAI_API_KEY. It can be an API key or a Claude / ChatGPT sign-in token,
    and each kind needs a different address and headers. This module handles
    both, so scripts never hand-write auth headers.
  * Caches by default. Claude: cache_control on the system prompt and on the
    stable `context` block (5 minute TTL, or cache_ttl="1h" for prompts reused
    less often than every 5 minutes). OpenAI caches stable prefixes on its own;
    we send a prompt_cache_key so repeated prefixes land on the same cache.
  * Logs one usage line per call to stderr, including cache reads, so a 0%
    cache rate is visible in the job log.

    from papr_llm import complete

    r = complete(
        "Which CRM should a 10-person startup use?",
        system="You are a neutral assistant.",
        provider="openai",          # or "anthropic"; default: whichever key exists
        web_search=True,
    )
    print(r.text, r.usage)

Put fixed material (instructions, reference docs, examples) in `system` and
`context`, and per-request data (dates, record details) in `prompt`. Anything
that changes between calls must come last, or it breaks the cache.

Standard library only: no SDK install needed.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

__all__ = ["complete", "complete_json", "LLMResult", "LLMError", "credential_kind"]

# Overridable for proxies and tests.
ANTHROPIC_URL = os.environ.get("PAPR_LLM_ANTHROPIC_URL", "https://api.anthropic.com/v1/messages")
OPENAI_URL = os.environ.get("PAPR_LLM_OPENAI_URL", "https://api.openai.com/v1/responses")
CHATGPT_URL = os.environ.get("PAPR_LLM_CHATGPT_URL", "https://chatgpt.com/backend-api/codex/responses")

DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-5.4",
    # Only some model ids are accepted with a ChatGPT sign-in.
    "chatgpt": "gpt-5.6-sol",
}

# Claude sign-in tokens are only accepted with Claude Code's identity.
CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.290"
_JWT_CLAIM = "https://api.openai.com/auth"


class LLMError(RuntimeError):
    """Model call failed. `status` is the HTTP status when there was one."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


@dataclass
class LLMResult:
    text: str
    provider: str
    model: str
    usage: Dict[str, int] = field(default_factory=dict)
    raw: Any = None


# ── credentials ──────────────────────────────────────────────────────────────


def _jwt_payload(token: str) -> Optional[dict]:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        pad = "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(parts[1] + pad))
    except Exception:
        return None


def _chatgpt_account_id(token: str) -> Optional[str]:
    payload = _jwt_payload(token) or {}
    return (payload.get(_JWT_CLAIM) or {}).get("chatgpt_account_id")


def credential_kind(provider: str, token: str) -> str:
    """'oauth' for a Claude/ChatGPT sign-in token, 'api_key' otherwise."""
    if provider == "anthropic":
        return "oauth" if token.startswith("sk-ant-oat") else "api_key"
    return "oauth" if _chatgpt_account_id(token) else "api_key"


def _env_key(provider: str) -> str:
    name = "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY"
    return os.environ.get(name, "").strip()


def _pick_provider(provider: Optional[str]) -> str:
    if provider:
        p = provider.lower()
        if p in ("claude", "anthropic"):
            return "anthropic"
        if p in ("openai", "chatgpt", "gpt"):
            return "openai"
        raise LLMError(f"Unknown provider {provider!r}; use 'anthropic' or 'openai'.")
    if _env_key("anthropic"):
        return "anthropic"
    if _env_key("openai"):
        return "openai"
    raise LLMError(
        "No model credential in this run. Connect Claude or ChatGPT in Settings, "
        "or add ANTHROPIC_API_KEY / OPENAI_API_KEY, and list the key in the job's "
        "requiredKeys (or the backend manifest keys)."
    )


# ── HTTP ─────────────────────────────────────────────────────────────────────


def _post(url: str, headers: dict, body: dict, timeout: float, stream: bool = False):
    data = json.dumps(body).encode()
    delay = 2.0
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            if stream:
                return resp
            with resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:600]
            retryable = e.code in (408, 429, 500, 502, 503, 504, 529)
            if retryable and attempt < 3:
                wait = float(e.headers.get("retry-after") or delay)
                time.sleep(min(wait, 30.0))
                delay *= 2
                continue
            raise LLMError(f"HTTP {e.code} from {url}: {detail}", e.code) from None
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            raise LLMError(f"Could not reach {url}: {e.reason}") from None
    raise LLMError(f"Gave up calling {url}")


def _log_usage(provider: str, model: str, usage: Dict[str, int]) -> None:
    if os.environ.get("PAPR_LLM_QUIET") == "1":
        return
    print(
        f"[papr_llm] {provider}/{model} in={usage.get('input_tokens', 0)} "
        f"cache_read={usage.get('cache_read_input_tokens', 0)} "
        f"cache_write={usage.get('cache_creation_input_tokens', 0)} "
        f"out={usage.get('output_tokens', 0)}",
        file=sys.stderr,
    )


# ── Anthropic ────────────────────────────────────────────────────────────────


def _anthropic(token, model, system, context, prompt, max_tokens, web_search,
               cache, cache_ttl, temperature, timeout):
    oauth = credential_kind("anthropic", token) == "oauth"
    cc = {"type": "ephemeral", **({"ttl": "1h"} if cache_ttl == "1h" else {})}

    system_blocks: List[dict] = []
    if oauth:
        system_blocks.append({"type": "text", "text": CLAUDE_CODE_SYSTEM})
    if system:
        system_blocks.append({"type": "text", "text": system})
    if cache and system_blocks:
        system_blocks[-1]["cache_control"] = cc

    user_blocks: List[dict] = []
    if context:
        block = {"type": "text", "text": context}
        if cache:
            block["cache_control"] = cc
        user_blocks.append(block)
    user_blocks.append({"type": "text", "text": prompt})

    body: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": user_blocks}],
    }
    if system_blocks:
        body["system"] = system_blocks
    if temperature is not None:
        body["temperature"] = temperature
    if web_search:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}]

    headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    if oauth:
        headers.update({
            "authorization": f"Bearer {token}",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "user-agent": CLAUDE_CODE_USER_AGENT,
            "x-app": "cli",
        })
    else:
        headers["x-api-key"] = token

    data = _post(ANTHROPIC_URL, headers, body, timeout)
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    u = data.get("usage") or {}
    usage = {
        "input_tokens": int(u.get("input_tokens") or 0),
        "output_tokens": int(u.get("output_tokens") or 0),
        "cache_read_input_tokens": int(u.get("cache_read_input_tokens") or 0),
        "cache_creation_input_tokens": int(u.get("cache_creation_input_tokens") or 0),
    }
    return text, usage, data


# ── OpenAI (API key) and ChatGPT sign-in ─────────────────────────────────────


def _cache_key(*parts: Optional[str]) -> str:
    h = hashlib.sha256("\x00".join(p or "" for p in parts).encode()).hexdigest()
    return f"papr-llm-{h[:32]}"


def _openai_usage(u: dict) -> Dict[str, int]:
    details = u.get("input_tokens_details") or {}
    return {
        "input_tokens": int(u.get("input_tokens") or 0),
        "output_tokens": int(u.get("output_tokens") or 0),
        "cache_read_input_tokens": int(details.get("cached_tokens") or 0),
        "cache_creation_input_tokens": 0,
    }


def _openai(token, model, system, context, prompt, max_tokens, web_search,
            cache, temperature, timeout):
    account_id = _chatgpt_account_id(token)
    content = [{"type": "input_text", "text": t} for t in (context, prompt) if t]
    body: dict = {
        "model": model,
        "instructions": system or "You are a helpful assistant.",
        "input": [{"role": "user", "content": content}],
    }
    if web_search:
        body["tools"] = [{"type": "web_search"}]
    if cache:
        body["prompt_cache_key"] = _cache_key(model, system, context)

    if not account_id:
        body["max_output_tokens"] = max_tokens
        if temperature is not None:
            body["temperature"] = temperature
        headers = {"content-type": "application/json", "authorization": f"Bearer {token}"}
        data = _post(OPENAI_URL, headers, body, timeout)
        text = data.get("output_text") or "".join(
            c.get("text", "")
            for item in data.get("output", []) if item.get("type") == "message"
            for c in item.get("content", []) if c.get("type") == "output_text"
        )
        return text, _openai_usage(data.get("usage") or {}), data

    # ChatGPT sign-in: Codex responses endpoint, streamed, not stored.
    body.update({"stream": True, "store": False})
    headers = {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "authorization": f"Bearer {token}",
        "chatgpt-account-id": account_id,
        "OpenAI-Beta": "responses=experimental",
        "originator": "papr_llm",
    }
    if cache:
        # The ChatGPT backend routes cache hits by session; same prefix, same id.
        headers["session_id"] = body["prompt_cache_key"]
    resp = _post(CHATGPT_URL, headers, body, timeout, stream=True)
    chunks: List[str] = []
    final: dict = {}
    with resp:
        for raw in resp:
            line = raw.decode(errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                event = json.loads(payload)
            except ValueError:
                continue
            kind = event.get("type")
            if kind == "response.output_text.delta":
                chunks.append(event.get("delta", ""))
            elif kind in ("response.completed", "response.done"):
                final = event.get("response") or {}
            elif kind in ("response.failed", "error"):
                err = (event.get("response") or {}).get("error") or event.get("error") or event
                raise LLMError(f"ChatGPT error: {json.dumps(err)[:600]}")
    return "".join(chunks), _openai_usage(final.get("usage") or {}), final


# ── public API ───────────────────────────────────────────────────────────────


def _api_model(provider: str, model: str) -> str:
    # Papr model ids use dashes (gpt-5-6-sol); OpenAI's use a dot (gpt-5.6-sol).
    if provider == "openai":
        return model.replace("gpt-5-6", "gpt-5.6")
    return model


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
    """One model call. Returns LLMResult(text, provider, model, usage, raw).

    system   fixed instructions (cached)
    context  fixed reference material placed before the prompt (cached)
    prompt   the per-call request: put anything that varies here
    """
    if cache_ttl not in ("5m", "1h"):
        raise LLMError("cache_ttl must be '5m' or '1h'")
    p = _pick_provider(provider)
    token = _env_key(p)
    if not token:
        name = "ANTHROPIC_API_KEY" if p == "anthropic" else "OPENAI_API_KEY"
        raise LLMError(
            f"{name} is not set in this run. Connect the account in Settings and "
            f"list {name} in the job's requiredKeys (or the backend manifest keys)."
        )

    if p == "anthropic":
        m = _api_model(p, model or DEFAULT_MODELS["anthropic"])
        text, usage, raw = _anthropic(token, m, system, context, prompt, max_tokens,
                                      web_search, cache, cache_ttl, temperature, timeout)
    else:
        signed_in = credential_kind("openai", token) == "oauth"
        m = _api_model(p, model or DEFAULT_MODELS["chatgpt" if signed_in else "openai"])
        text, usage, raw = _openai(token, m, system, context, prompt, max_tokens,
                                   web_search, cache, temperature, timeout)

    _log_usage(p, m, usage)
    return LLMResult(text=text, provider=p, model=m, usage=usage, raw=raw)


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
