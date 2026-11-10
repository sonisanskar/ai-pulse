"""Hugging Face Daily Papers: community-curated, upvoted arXiv papers."""
from typing import List

from ..models import Item, clean_text
from . import iso_date

API = "https://huggingface.co/api/daily_papers"


def fetch(cfg, http) -> List[Item]:
    resp = http.get(API, params={"limit": cfg.get("limit", 30)})
    resp.raise_for_status()
    items = []
    for entry in resp.json():
        p = entry.get("paper") or {}
        arxiv_id = p.get("id")
        if not arxiv_id:
            continue
        links = {
            "arxiv": f"https://arxiv.org/abs/{arxiv_id}",
            "pdf": f"https://arxiv.org/pdf/{arxiv_id}",
        }
        if p.get("githubRepo"):
            links["code"] = p["githubRepo"]
        signals = {"upvotes": p.get("upvotes", 0)}
        if p.get("githubStars"):
            signals["stars"] = p["githubStars"]
        items.append(Item(
            id=f"arxiv:{arxiv_id}",
            type="paper",
            title=clean_text(p.get("title") or entry.get("title", ""), 300),
            url=f"https://huggingface.co/papers/{arxiv_id}",
            source="HF Daily Papers",
            source_key="hf_papers",
            date=iso_date(p.get("submittedOnDailyAt") or p.get("publishedAt")),
            authors=[a.get("name", "") for a in p.get("authors", [])][:8],
            abstract=clean_text(p.get("summary", "")),
            signals=signals,
            links=links,
            tags=(p.get("ai_keywords") or [])[:6],
            image=entry.get("thumbnail") or "",  # the paper's first page, rendered by HF
        ))
    return items
