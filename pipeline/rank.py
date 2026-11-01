import math
from typing import Dict, Iterable, List

from .models import Item
from .sources import age_days

# Sources without popularity numbers (RSS, Anthropic) get this baseline signal.
DEFAULT_SIGNAL = 25


def interest_hits(item: Item, interests: Iterable[str]) -> int:
    text = f"{item.title} {item.abstract} {' '.join(item.tags)}".lower()
    return sum(1 for kw in interests if kw in text)


def score(item: Item, weights: Dict[str, float], interests: List[str]) -> float:
    s = item.signals
    popularity = max(
        s.get("upvotes", 0) * 4,       # HF upvotes are scarce; scale up
        s.get("points", 0),
        s.get("stars", 0) / 3,
        s.get("trending", 0),
        s.get("rank_proxy", 0),
        s.get("keyword_hits", 0) * 6,
        0,
    ) or DEFAULT_SIGNAL
    base = weights.get(item.source_key, 1.0) * (1 + math.log1p(popularity))
    boost = 0.6 * min(interest_hits(item, interests), 4)
    recency = -0.15 * min(age_days(item.date), 10)
    return round(base + boost + recency, 3)


def rank(items: List[Item], weights: Dict[str, float], interests: List[str]) -> List[Item]:
    for item in items:
        item.score = score(item, weights, interests)
    return sorted(items, key=lambda i: -i.score)
