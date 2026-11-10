"""Daily build: fetch → dedupe → rank → summarize → write JSON for the static site.

    python -m pipeline.build              # full run (uses any free LLM provider with a key set)
    python -m pipeline.build --no-llm     # skip summaries / digest / concept
    python -m pipeline.build --only hf_papers,github
"""
import argparse
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List

import httpx
import yaml

from . import concepts, summarize
from .dedupe import filter_seen, merge_duplicates, prune_seen
from .llm import LLM
from .models import Item
from .rank import brief_group, pick_brief, rank
from .sources import USER_AGENT
from .sources import anthropic_news, arxiv, github, hackernews, hf_hub, hf_papers, reddit, rss

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
STATE = ROOT / "state"
log = logging.getLogger("build")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, obj, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) if compact \
        else json.dumps(obj, ensure_ascii=False, indent=1)
    path.write_text(text)


def fetchers(cfg: Dict) -> Dict[str, Callable]:
    """source name -> fn(http) returning items, or (items, per-feed errors)."""
    src = cfg["sources"]
    table = {
        "hf_papers": lambda http: hf_papers.fetch(src["hf_papers"], http),
        "arxiv": lambda http: arxiv.fetch(src["arxiv"], http, interests=cfg["interests"]),
        "rss": lambda http: rss.fetch(src["rss"], http),
        "anthropic": lambda http: anthropic_news.fetch(src["anthropic"], http),
        "hackernews": lambda http: hackernews.fetch(src["hackernews"], http),
        "reddit": lambda http: reddit.fetch(src["reddit"], http),
        "hf_hub": lambda http: hf_hub.fetch(src["hf_hub"], http),
        "github": lambda http: github.fetch(src["github"], http),
    }
    return {k: v for k, v in table.items() if src.get(k, {}).get("enabled", True)}


def fetch_all(cfg: Dict, only=None):
    items: List[Item] = []
    status: Dict[str, Dict] = {}
    table = fetchers(cfg)
    if only:
        table = {k: v for k, v in table.items() if k in only}

    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True) as http:
        def run(name):
            t0 = time.time()
            try:
                result = table[name](http)
                got, sub_errors = result if isinstance(result, tuple) else (result, {})
                return name, got, {"ok": True, "count": len(got), "ms": int((time.time() - t0) * 1000),
                                   **({"partial_errors": sub_errors} if sub_errors else {})}
            except Exception as ex:  # noqa: BLE001 - one broken source must not kill the run
                log.warning("source %s failed: %s", name, ex)
                return name, [], {"ok": False, "count": 0, "ms": int((time.time() - t0) * 1000),
                                  "error": f"{type(ex).__name__}: {ex}"[:300]}

        with ThreadPoolExecutor(max_workers=8) as pool:
            for name, got, st in pool.map(run, table):
                items.extend(got)
                status[name] = st
                log.info("%-11s %s %3d items (%d ms)", name, "ok " if st["ok"] else "ERR", st["count"], st["ms"])
    return items, status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="skip summaries, digest and concept")
    ap.add_argument("--only", help="comma-separated source names to run")
    ap.add_argument("--config", default=str(Path(__file__).with_name("config.yaml")))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    cfg = yaml.safe_load(Path(args.config).read_text())
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    day_path = DATA / "days" / f"{today}.json"

    seen = load_json(STATE / "seen.json", {})
    cache = load_json(STATE / "summaries.json", {})
    all_concepts = load_json(DATA / "concepts.json", [])
    existing_day = load_json(day_path, {})

    # 1-4: fetch, merge duplicates, drop already-seen, rank
    raw, source_status = fetch_all(cfg, only=set(args.only.split(",")) if args.only else None)
    merged = merge_duplicates(raw, cfg["weights"])
    fresh = filter_seen(merged, seen, now)
    # A re-run today keeps items from earlier runs even if a source fails now
    fresh_ids = {i.id for i in fresh}
    for d in existing_day.get("items", []):
        if d["id"] not in fresh_ids:
            d.pop("tab", None)
            fresh.append(Item(**d))
    items = rank(fresh, cfg["weights"], cfg["interests"])
    log.info("%d fetched → %d after merge → %d new today", len(raw), len(merged), len(items))
    brief_cfg = cfg.get("brief", {})
    brief = pick_brief(items, brief_cfg, cfg["interests"])
    lab_orgs = [o.lower() for o in brief_cfg.get("lab_orgs", [])]
    log.info("brief: %s", ", ".join(i.title[:40] for i in brief))

    # 5: LLM enrichment (free open models)
    llm = LLM(cfg["llm"])
    digest = existing_day.get("digest")
    concept = next((c for c in all_concepts if c.get("date") == today), None)
    if args.no_llm:
        llm_status = {"ok": False, "skipped": True}
    elif not llm.available:
        llm_status = {"ok": False, "error": "no LLM provider configured (set GROQ_API_KEY, "
                                            "OPENROUTER_API_KEY or OLLAMA_MODEL)"}
        log.warning(llm_status["error"])
    else:
        # Brief items first, so they get TL;DRs even if the free quota runs out midway
        brief_ids = {i.id for i in brief}
        n = summarize.summarize_items(brief + [i for i in items if i.id not in brief_ids], llm, cache, cfg["llm"])
        log.info("summarized %d new items", n)
        digest = summarize.make_digest(brief, llm) or digest
        if concept is None:
            concept = concepts.generate(items, [c["name"] for c in all_concepts], llm, today)
            if concept:
                all_concepts.insert(0, concept)
                log.info("concept of the day: %s", concept["name"])
        llm_status = llm.status()
    # Without an LLM, still apply cached summaries so a no-LLM re-run doesn't lose them
    for i in items:
        if i.summary is None and i.id in cache:
            i.summary = cache[i.id]

    # 6: write outputs
    day = {
        "date": today,
        "generated_at": now.isoformat(timespec="seconds"),
        "digest": digest,
        "concept_slug": concept["slug"] if concept else None,
        "brief": [{"id": i.id, "group": brief_group(i, lab_orgs)} for i in brief],
        "items": [i.to_dict() for i in items],
    }
    save_json(day_path, day, compact=True)
    save_json(DATA / "latest.json", day, compact=True)

    index = load_json(DATA / "index.json", {"days": []})
    counts = {}
    for i in items:
        counts[i.tab] = counts.get(i.tab, 0) + 1
    index["days"] = [d for d in index["days"] if d["date"] != today]
    index["days"].insert(0, {"date": today, "counts": counts, "headline": (digest or {}).get("headline", "")})
    index["days"].sort(key=lambda d: d["date"], reverse=True)
    index["updated_at"] = day["generated_at"]
    save_json(DATA / "index.json", index)
    save_json(DATA / "concepts.json", all_concepts)
    if args.only:  # partial run: keep the last known health of sources that weren't run
        source_status = {**load_json(DATA / "status.json", {}).get("sources", {}), **source_status}
    save_json(DATA / "status.json", {"generated_at": day["generated_at"], "sources": source_status,
                                     "llm": llm_status, "counts": counts})

    seen = prune_seen(seen, now)
    save_json(STATE / "seen.json", seen)
    save_json(STATE / "summaries.json", {k: v for k, v in cache.items() if k in seen}, compact=True)
    log.info("wrote %s (%s)", day_path.relative_to(ROOT), counts)


if __name__ == "__main__":
    main()
