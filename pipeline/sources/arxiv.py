"""arXiv API: recent submissions in ML categories, filtered by your interest keywords."""
import re
from typing import List

import feedparser

from ..models import Item, clean_text
from . import age_days, iso_date

API = "https://export.arxiv.org/api/query"


def fetch(cfg, http, interests=()) -> List[Item]:
    query = " OR ".join(f"cat:{c}" for c in cfg.get("categories", ["cs.LG"]))
    resp = http.get(API, params={
        "search_query": query,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "max_results": cfg.get("fetch", 300),
    }, timeout=60)
    resp.raise_for_status()
    feed = feedparser.parse(resp.content)

    scored = []
    for e in feed.entries:
        if age_days(e.get("published")) > cfg.get("max_age_days", 3):
            continue
        text = f"{e.title} {e.summary}".lower()
        hits = sum(1 for kw in interests if kw in text)
        if hits == 0:
            continue
        arxiv_id = re.sub(r"v\d+$", "", e.id.rsplit("/abs/", 1)[-1])
        scored.append((hits, Item(
            id=f"arxiv:{arxiv_id}",
            type="paper",
            title=clean_text(e.title, 300),
            url=f"https://arxiv.org/abs/{arxiv_id}",
            source="arXiv",
            source_key="arxiv",
            date=iso_date(e.get("published")),
            authors=[a.name for a in e.get("authors", [])][:8],
            abstract=clean_text(e.summary),
            signals={"keyword_hits": hits},
            links={"pdf": f"https://arxiv.org/pdf/{arxiv_id}"},
            tags=[t.term for t in e.get("tags", []) if t.term.startswith("cs.")][:4],
        )))
    scored.sort(key=lambda x: -x[0])
    return [item for _, item in scored[: cfg.get("limit", 20)]]
