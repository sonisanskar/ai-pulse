"""Merge duplicates within a run and drop items already shown on earlier days."""
from datetime import datetime, timedelta
from typing import Dict, List
from urllib.parse import urlparse

from .models import Item

SEEN_TTL_DAYS = 45


def _url_key(url: str) -> str:
    p = urlparse(url)
    return f"{p.netloc.lower().removeprefix('www.')}{p.path.rstrip('/')}".lower()


def merge_duplicates(items: List[Item], weights: Dict[str, float]) -> List[Item]:
    """Same paper from HF + arXiv, or the same blog post via HN, collapses into one item.
    The item from the higher-weighted source wins; popularity signals and links are combined."""
    groups: List[List[Item]] = []
    index: Dict[str, int] = {}
    for item in items:
        keys = (item.id, _url_key(item.url))
        g = next((index[k] for k in keys if k in index), None)
        if g is None:
            g = len(groups)
            groups.append([])
        groups[g].append(item)
        for k in keys:
            index[k] = g
    return [_combine(g, weights) for g in groups]


def _combine(group: List[Item], weights: Dict[str, float]) -> Item:
    group.sort(key=lambda i: -weights.get(i.source_key, 1))
    winner = group[0]
    for other in group[1:]:
        winner.signals = {**other.signals, **winner.signals}
        winner.links = {**other.links, **winner.links}
        if other.source_key == "hackernews":
            winner.links["hn"] = other.links.get("discussion", other.url)
        winner.tags = list(dict.fromkeys(winner.tags + other.tags))[:8]
        if len(other.abstract) > len(winner.abstract) * 2:
            winner.abstract = other.abstract
    return winner


def filter_seen(items: List[Item], seen: Dict[str, str], now: datetime) -> List[Item]:
    """Keep items never seen before, or first seen today (so re-running a day is idempotent)."""
    today = now.date().isoformat()
    fresh = []
    for item in items:
        first = seen.get(item.id)
        if first and first[:10] != today:
            continue
        item.first_seen = first or now.isoformat(timespec="seconds")
        seen[item.id] = item.first_seen
        fresh.append(item)
    return fresh


def prune_seen(seen: Dict[str, str], now: datetime) -> Dict[str, str]:
    cutoff = (now - timedelta(days=SEEN_TTL_DAYS)).isoformat()
    return {k: v for k, v in seen.items() if v >= cutoff}
