import math
import re
from typing import Dict, Iterable, List

from .models import Item
from .sources import age_days

# Sources without popularity numbers (RSS, Anthropic) get this baseline signal.
DEFAULT_SIGNAL = 25


def count_interests(title: str, text: str, interests: Iterable[str]) -> int:
    """Whole-word matches (plural allowed): "rag" must not match "storage".
    A "title:" prefix only counts the keyword in the title, for words most abstracts use."""
    title, text = title.lower(), text.lower()
    hits = 0
    for kw in interests:
        where = title if kw.startswith("title:") else text
        kw = kw.removeprefix("title:")
        hits += bool(re.search(rf"\b{re.escape(kw)}s?\b", where))
    return hits


def interest_hits(item: Item, interests: Iterable[str]) -> int:
    return count_interests(item.title, f"{item.title} {item.abstract} {' '.join(item.tags)}", interests)


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


RELEASE_WORDS = re.compile(r"\b(introduc\w*|launch\w*|releas\w*|announc\w*|now available)\b", re.I)
# Things people built and are sharing: Show HN, "I made ..." posts, HF Spaces
DEMO_WORDS = re.compile(r"^show hn\b|\b(i|we) (built|made|created|trained|wrote)\b|\bopen[- ]sourc\w*\b|\bdemo\b", re.I)


def brief_group(item: Item, lab_orgs: List[str]) -> str:
    """Which slot of the daily brief an item competes for."""
    org = item.title.split("/")[0].lower() if item.type in ("model", "dataset", "space") else ""
    if item.source_key in ("rss_lab", "anthropic") or org in lab_orgs \
            or (item.type == "news" and RELEASE_WORDS.search(item.title)):
        return "release"
    if item.type == "space" or (item.source_key in ("hackernews", "reddit") and DEMO_WORDS.search(item.title)):
        return "demo"
    if item.type in ("repo", "model"):
        return "usable"
    if item.type == "paper":
        return "paper"
    return "wildcard"


# HF models, datasets and spaces are one provider; cap them together
def _provider(item: Item) -> str:
    return "hf_hub" if item.source_key in ("hf_models", "hf_datasets", "hf_spaces") else item.source


def _tokens(title: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if len(w) > 2}


def pick_brief(items: List[Item], cfg: Dict, interests: List[str]) -> List[Item]:
    """The handful of items worth reading today: per-kind quotas, a relevance floor,
    a per-source cap and no near-duplicate titles. Expects items already ranked."""
    size = cfg.get("size", 7)
    quotas = cfg.get("quotas", {"release": 2, "usable": 2, "paper": 2})
    cap = cfg.get("max_per_source", 2)
    lab_orgs = [o.lower() for o in cfg.get("lab_orgs", [])]
    avoid = [w.lower() for w in cfg.get("avoid", [])]

    candidates = []
    for item in items:
        text = f"{item.title} {item.abstract}".lower()
        if any(w in text for w in avoid):
            continue
        bucket = brief_group(item, lab_orgs)
        # Releases and community demos are judged on popularity, not topic keywords
        if bucket not in ("release", "demo") and interest_hits(item, interests) == 0:
            continue
        candidates.append((bucket, item))

    picked: List[Item] = []
    per_source: Dict[str, int] = {}
    seen_titles: List[set] = []

    def take(item: Item) -> bool:
        toks = _tokens(item.title)
        if per_source.get(_provider(item), 0) >= cap or item in picked \
                or any(len(toks & t) / max(len(toks | t), 1) > 0.5 for t in seen_titles):
            return False
        picked.append(item)
        per_source[_provider(item)] = per_source.get(_provider(item), 0) + 1
        seen_titles.append(toks)
        return True

    for bucket, n in quotas.items():
        got = 0
        for b, item in candidates:
            if got >= n:
                break
            if b == bucket and take(item):
                got += 1
    # Short buckets and the wildcard slot go to the best remaining item of any kind
    for _, item in candidates:
        if len(picked) >= size:
            break
        take(item)
    return picked[:size]
