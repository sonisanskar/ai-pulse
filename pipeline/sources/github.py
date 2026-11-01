"""Fast-rising new ML/AI repositories via the GitHub Search API."""
import os
from datetime import datetime, timedelta, timezone
from typing import List

from ..models import Item, clean_text
from . import iso_date

API = "https://api.github.com/search/repositories"


def fetch(cfg, http) -> List[Item]:
    since = (datetime.now(timezone.utc) - timedelta(days=cfg.get("created_within_days", 10))).date()
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    repos = {}
    for topic in cfg.get("topics", ["llm"]):
        resp = http.get(API, headers=headers, params={
            "q": f"topic:{topic} created:>{since} stars:>={cfg.get('min_stars', 50)}",
            "sort": "stars", "order": "desc", "per_page": 15,
        })
        resp.raise_for_status()
        for r in resp.json().get("items", []):
            repos[r["full_name"]] = r

    items = []
    for r in sorted(repos.values(), key=lambda r: -r["stargazers_count"])[: cfg.get("limit", 15)]:
        items.append(Item(
            id=f"gh:{r['full_name'].lower()}",
            type="repo",
            title=r["full_name"],
            url=r["html_url"],
            source="GitHub (new & rising)",
            source_key="github",
            date=iso_date(r.get("created_at")),
            abstract=clean_text(r.get("description") or "", 500),
            signals={"stars": r["stargazers_count"], "forks": r.get("forks_count", 0)},
            tags=([r["language"]] if r.get("language") else []) + r.get("topics", [])[:5],
        ))
    return items
