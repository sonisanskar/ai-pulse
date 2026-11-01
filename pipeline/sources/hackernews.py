"""Hacker News stories from the last 24h that are about AI/ML (Algolia API)."""
import re
import time
from typing import List

from ..models import Item, clean_text, make_id
from . import iso_date

API = "https://hn.algolia.com/api/v1/search"
AI_PATTERN = re.compile(
    r"\b(ai|a\.i\.|llms?|gpt|claude|gemini|llama|mistral|deepseek|qwen|openai|anthropic|"
    r"deepmind|hugging ?face|transformer|neural|machine learning|deep learning|ml|agents?|"
    r"diffusion|inference|fine-?tun\w*|rag|embedding|model|chatbot|copilot|nvidia|gpu)\b",
    re.I,
)


def fetch(cfg, http) -> List[Item]:
    since = int(time.time()) - 86400
    resp = http.get(API, params={
        "tags": "story",
        "numericFilters": f"created_at_i>{since},points>{cfg.get('min_points', 80)}",
        "hitsPerPage": 200,
    })
    resp.raise_for_status()
    items = []
    for h in resp.json().get("hits", []):
        title = h.get("title") or ""
        if not AI_PATTERN.search(title):
            continue
        discussion = f"https://news.ycombinator.com/item?id={h['objectID']}"
        url = h.get("url") or discussion
        items.append(Item(
            id=make_id("news", url),
            type="news",
            title=clean_text(title, 300),
            url=url,
            source="Hacker News",
            source_key="hackernews",
            date=iso_date(h.get("created_at")),
            authors=[h.get("author", "")],
            abstract=clean_text(h.get("story_text") or "", 600),
            signals={"points": h.get("points", 0), "comments": h.get("num_comments", 0)},
            links={"discussion": discussion},
        ))
    items.sort(key=lambda i: -i.signals["points"])
    return items[: cfg.get("limit", 15)]
