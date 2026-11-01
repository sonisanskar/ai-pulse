"""One OpenAI-compatible client over several free open-model providers, with fallback.

Order of attempts: provider 1 (model 1, model 2, ...), provider 2 (...), ...
- unknown/retired model    -> skip that model for the rest of the run
- auth / connection error  -> skip that provider for the rest of the run
- rate limit               -> SDK retries with backoff, then fall through to the next option
"""
import json
import logging
import os
import re
from collections import Counter
from typing import Dict, List, Optional

import openai

log = logging.getLogger("llm")


class LLMUnavailable(RuntimeError):
    pass


class LLM:
    def __init__(self, cfg: Dict):
        self.providers = []
        for p in cfg.get("providers", []):
            key = os.environ.get(p["api_key_env"], "").strip()
            if not key:
                continue
            resolve = lambda m: os.environ.get(m[1:], "") if m.startswith("$") else m  # noqa: E731
            self.providers.append({
                "name": p["name"],
                "client": openai.OpenAI(base_url=p["base_url"], api_key=key, max_retries=3, timeout=180),
                "fast": [resolve(m) for m in p.get("fast_models", []) if resolve(m)],
                "smart": [resolve(m) for m in p.get("smart_models", []) if resolve(m)],
            })
        self.dead_models = set()
        self.dead_providers = set()
        self.usage = Counter()      # "provider/model" -> calls
        self.errors: List[str] = []

    @property
    def available(self) -> bool:
        return any(p["name"] not in self.dead_providers for p in self.providers)

    def status(self) -> Dict:
        return {
            "configured": [p["name"] for p in self.providers],
            "calls": dict(self.usage),
            "errors": self.errors[-10:],
            "ok": bool(self.usage),
        }

    def chat(self, messages: List[Dict], tier: str = "fast", max_tokens: int = 2500,
             temperature: float = 0.3) -> str:
        for p in self.providers:
            if p["name"] in self.dead_providers:
                continue
            for model in p[tier]:
                tag = f"{p['name']}/{model}"
                if tag in self.dead_models:
                    continue
                try:
                    resp = p["client"].chat.completions.create(
                        model=model, messages=messages,
                        max_tokens=max_tokens, temperature=temperature,
                    )
                    text = resp.choices[0].message.content or ""
                    self.usage[tag] += 1
                    # Some open reasoning models inline their chain of thought
                    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
                except (openai.NotFoundError, openai.BadRequestError, openai.UnprocessableEntityError) as ex:
                    self._error(tag, ex)
                    self.dead_models.add(tag)
                except (openai.AuthenticationError, openai.PermissionDeniedError,
                        openai.APIConnectionError) as ex:
                    self._error(tag, ex)
                    self.dead_providers.add(p["name"])
                    break
                except (openai.RateLimitError, openai.APITimeoutError, openai.InternalServerError) as ex:
                    self._error(tag, ex)  # try the next model/provider; don't blacklist
        raise LLMUnavailable("all providers failed: " + "; ".join(self.errors[-3:]))

    def chat_json(self, messages: List[Dict], tier: str = "fast", **kw) -> Dict:
        text = self.chat(messages, tier=tier, **kw)
        parsed = extract_json(text)
        if parsed is None:
            retry = messages + [
                {"role": "assistant", "content": text},
                {"role": "user", "content": "That was not valid JSON. Reply with ONLY the JSON object, nothing else."},
            ]
            parsed = extract_json(self.chat(retry, tier=tier, **kw))
        if parsed is None:
            raise ValueError("model did not return valid JSON")
        return parsed

    def _error(self, tag: str, ex: Exception):
        msg = f"{tag}: {type(ex).__name__}: {str(ex)[:160]}"
        log.warning(msg)
        self.errors.append(msg)


def extract_json(text: str) -> Optional[Dict]:
    """Pull the first JSON object out of a model reply (handles ```json fences and chatter)."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = [fenced.group(1)] if fenced else []
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start:end + 1])
    for c in candidates:
        for attempt in (c, re.sub(r",\s*([}\]])", r"\1", c)):  # tolerate trailing commas
            try:
                obj = json.loads(attempt)
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                continue
    return None
