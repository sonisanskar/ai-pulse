"""Anthropic has no RSS feed, so read the cards off anthropic.com/news."""
import re
from collections import OrderedDict
from typing import List

from ..models import Item, clean_text, make_id
from . import iso_date

URL = "https://www.anthropic.com/news"
# Category / navigation links that share the /news/ prefix
CATEGORIES = {"announcements", "features", "partnerships", "product", "policy", "research",
              "societal-impacts", "economic-research", "interpretability", "alignment"}


def fetch(cfg, http) -> List[Item]:
    resp = http.get(URL)
    resp.raise_for_status()
    cards = OrderedDict()  # slug -> [title, description]
    for m in re.finditer(r'<a [^>]*href="/news/([a-z0-9-]+)"[^>]*>(.*?)</a>', resp.text, re.S):
        slug = m.group(1)
        if slug in CATEGORIES:
            continue
        parts = [clean_text(p, 400) for p in re.split(r"<[^>]+>", m.group(2))]
        parts = [p for p in parts if p]
        entry = cards.setdefault(slug, ["", ""])
        if parts and not entry[0]:
            entry[0] = parts[0]
            if len(parts) > 1:
                entry[1] = parts[1]
        elif parts and not entry[1] and parts[0] != entry[0]:
            entry[1] = parts[0]

    items = []
    for slug, (title, desc) in cards.items():
        if not title:
            continue
        url = f"{URL}/{slug}"
        items.append(Item(
            id=make_id("news", url),
            type="news",
            title=title,
            url=url,
            source="Anthropic",
            source_key="anthropic",
            date=iso_date(None),  # page doesn't expose dates reliably; first-seen date instead
            abstract=desc,
        ))
        if len(items) >= cfg.get("limit", 6):
            break
    return items
