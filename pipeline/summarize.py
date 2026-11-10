"""Per-item TL;DRs and the daily digest."""
import json
import logging
from typing import Dict, List, Optional

from .llm import LLM, LLMUnavailable
from .models import Item

log = logging.getLogger("summarize")

SYSTEM = (
    "You are a sharp ML research editor writing for a senior machine-learning engineer. "
    "Be precise and concrete, prefer technical substance over hype, and never invent numbers, "
    "results or facts that are not in the input."
)

ITEM_PROMPT = """Summarize each item below. Return ONLY JSON of the form:
{{"items": [{{"id": "<same id>",
  "tldr": "<one sentence, max 30 words: what it is>",
  "key_idea": "<1-2 sentences: the core technical idea / what is new>",
  "why_it_matters": "<1 sentence: practical significance for an ML engineer>",
  "tags": ["<2-4 short lowercase topic tags, e.g. 'rlhf', 'inference', 'vision'>"],
  "difficulty": "<beginner|intermediate|advanced>"}}]}}

If an item has little text (e.g. a model or repo name), explain cautiously what it most likely is
from its name and tags, and keep claims modest. Do not use LaTeX.

Items:
{items}"""

DIGEST_PROMPT = """Here is today's brief: the few AI/ML items picked as most worth attention
(id, type, source, title, tl;dr).

{items}

Write the copy for today's briefing. Return ONLY JSON:
{{"headline": "<punchy one-line summary of the day, max 14 words>",
  "top": [{{"id": "<item id>", "why": "<one sentence: why an ML engineer should care, or what they could do with it>"}}],
  "themes": ["<2-4 short theme labels>"]}}
Include every item above in "top", in the same order."""


def summarize_items(items: List[Item], llm: LLM, cache: Dict[str, Dict], cfg: Dict) -> int:
    """Attach summaries to the top items, reusing cached ones. Returns number of new summaries."""
    limit = cfg.get("max_items_to_summarize", 70)
    for item in items:
        if item.id in cache:
            item.summary = cache[item.id]
    todo = [i for i in items[:limit] if i.summary is None]
    size = cfg.get("batch_size", 6)
    created = 0
    for start in range(0, len(todo), size):
        batch = todo[start:start + size]
        payload = [
            {"id": i.id, "type": i.type, "source": i.source, "title": i.title,
             "text": i.abstract[:800], "tags": i.tags[:5]}
            for i in batch
        ]
        try:
            result = llm.chat_json(
                [{"role": "system", "content": SYSTEM},
                 {"role": "user", "content": ITEM_PROMPT.format(items=json.dumps(payload, ensure_ascii=False))}],
                tier="fast", max_tokens=2500,
            )
        except LLMUnavailable:
            log.warning("LLM unavailable; stopping item summaries")
            break
        except ValueError as ex:
            log.warning("batch failed: %s", ex)
            continue
        by_id = {i.id: i for i in batch}
        for s in result.get("items", []):
            item = by_id.get(s.get("id"))
            if not item or not s.get("tldr"):
                continue
            item.summary = {
                "tldr": str(s.get("tldr", "")),
                "key_idea": str(s.get("key_idea", "")),
                "why_it_matters": str(s.get("why_it_matters", "")),
                "tags": [str(t).lower() for t in s.get("tags", [])][:4],
                "difficulty": s.get("difficulty") if s.get("difficulty") in
                              ("beginner", "intermediate", "advanced") else "intermediate",
            }
            cache[item.id] = item.summary
            created += 1
    return created


def make_digest(brief: List[Item], llm: LLM) -> Optional[Dict]:
    """Headline, themes and a one-line "why" for each brief item. The LLM writes copy, it doesn't choose."""
    if not brief:
        return None
    lines = "\n".join(
        f"- {i.id} | {i.type} | {i.source} | {i.title} | {(i.summary or {}).get('tldr') or i.abstract[:200]}"
        for i in brief
    )
    try:
        d = llm.chat_json(
            [{"role": "system", "content": SYSTEM},
             {"role": "user", "content": DIGEST_PROMPT.format(items=lines)}],
            tier="smart", max_tokens=1500, temperature=0.5,
        )
    except (LLMUnavailable, ValueError) as ex:
        log.warning("digest failed: %s", ex)
        return None
    valid = {i.id for i in brief}
    return {
        "headline": str(d.get("headline", "")),
        "top": [t for t in d.get("top", []) if t.get("id") in valid],
        "themes": [str(t) for t in d.get("themes", [])][:4],
    }
