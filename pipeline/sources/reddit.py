"""Top posts of the day from ML subreddits (RSS. The JSON API blocks most servers)."""
import time
from typing import Dict, List, Tuple

import feedparser

from ..models import Item, clean_text, make_id
from . import iso_date


def fetch(cfg, http) -> Tuple[List[Item], Dict[str, str]]:
    items, errors = [], {}
    for n, sub in enumerate(cfg.get("subreddits", [])):
        if n:
            time.sleep(3)  # Reddit rate-limits rapid anonymous requests
        resp = http.get(f"https://www.reddit.com/r/{sub}/top/.rss", params={"t": "day"})
        if resp.status_code != 200:
            errors[f"r/{sub}"] = f"HTTP {resp.status_code}"
            continue
        feed = feedparser.parse(resp.content)
        for rank, e in enumerate(feed.entries[: cfg.get("limit_per_sub", 6)]):
            items.append(Item(
                id=make_id("news", e.link),
                type="news",
                title=clean_text(e.title, 300),
                url=e.link,
                source=f"r/{sub}",
                source_key="reddit",
                date=iso_date(e.get("updated") or e.get("published")),
                abstract=clean_text(e.get("summary", ""), 500),
                # RSS has no scores; use position in the day's top list as a proxy
                signals={"rank_proxy": max(1, 50 - rank * 8)},
            ))
    if errors and not items:
        raise RuntimeError("; ".join(f"{k}: {v}" for k, v in errors.items()))
    return items, errors
