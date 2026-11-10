"""Lab blogs, newsletters and independent writers via RSS/Atom."""
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Tuple

import re

import feedparser

from ..models import Item, clean_text, make_id
from . import age_days, iso_date


IMG_SRC = re.compile(r'<img[^>]+src="(https://[^"]+)"', re.I)


def _image(entry, body: str) -> str:
    """The article's own image: media:content, media:thumbnail, an image enclosure, or the first <img>."""
    for key in ("media_content", "media_thumbnail"):
        for m in entry.get(key) or []:
            if m.get("url", "").startswith("https://"):
                return m["url"]
    for link in entry.get("links", []):
        if link.get("rel") == "enclosure" and "image" in link.get("type", "") and link.get("href", "").startswith("https://"):
            return link["href"]
    m = IMG_SRC.search(body or "")
    return m.group(1) if m else ""


def _fetch_feed(feed, cfg, http) -> List[Item]:
    resp = http.get(feed["url"])
    resp.raise_for_status()
    parsed = feedparser.parse(resp.content)
    kind = feed.get("kind", "writer")
    items = []
    for e in parsed.entries:
        published = e.get("published_parsed") or e.get("updated_parsed") or e.get("published")
        if age_days(published) > cfg.get("max_age_days", 4):
            continue
        link = e.get("link", "")
        if not link:
            continue
        body = e.get("summary") or (e.get("content") or [{}])[0].get("value", "")
        items.append(Item(
            id=make_id("news", link),
            type="news",
            title=clean_text(e.get("title", ""), 300),
            url=link,
            source=feed["name"],
            source_key=f"rss_{kind}",
            date=iso_date(published),
            authors=[e["author"]] if e.get("author") else [],
            abstract=clean_text(body, 900),
            tags=[t.get("term", "") for t in e.get("tags", []) if t.get("term")][:4],
            image=_image(e, body),
        ))
        if len(items) >= cfg.get("limit_per_feed", 5):
            break
    return items


def fetch(cfg, http) -> Tuple[List[Item], Dict[str, str]]:
    """Returns items plus per-feed errors (so one broken feed doesn't hide the rest)."""
    items, errors = [], {}
    feeds = cfg.get("feeds", [])
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {f["name"]: pool.submit(_fetch_feed, f, cfg, http) for f in feeds}
        for name, fut in futures.items():
            try:
                items.extend(fut.result())
            except Exception as ex:  # noqa: BLE001 - surface any feed failure in status
                errors[name] = f"{type(ex).__name__}: {ex}"[:200]
    return items, errors
