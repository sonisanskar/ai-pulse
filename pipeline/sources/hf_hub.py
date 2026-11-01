"""Trending models, datasets and Spaces on the Hugging Face Hub."""
from typing import List

from ..models import Item, clean_text
from . import iso_date

API = "https://huggingface.co/api"
NOISE_TAGS = ("region:", "deploy:", "endpoints_compatible", "autotrain_compatible", "safetensors",
              "base_model:", "dataset:", "arxiv:", "doi:", "eval-results")


def _clean_tags(tags):
    return [t for t in tags if not t.startswith(NOISE_TAGS)][:6]


def _trending(http, kind, limit):
    resp = http.get(f"{API}/{kind}", params={
        "sort": "trendingScore", "direction": -1, "limit": limit, "full": "false",
    })
    resp.raise_for_status()
    return resp.json()


def fetch(cfg, http) -> List[Item]:
    items = []
    for m in _trending(http, "models", cfg.get("models_limit", 15)):
        items.append(Item(
            id=f"hf-model:{m['id']}",
            type="model",
            title=m["id"],
            url=f"https://huggingface.co/{m['id']}",
            source="HF Trending Models",
            source_key="hf_models",
            date=iso_date(m.get("createdAt")),
            abstract=" · ".join(filter(None, [m.get("pipeline_tag"), m.get("library_name")])),
            signals={"trending": m.get("trendingScore", 0), "likes": m.get("likes", 0),
                     "downloads": m.get("downloads", 0)},
            tags=_clean_tags(m.get("tags", [])),
        ))
    for d in _trending(http, "datasets", cfg.get("datasets_limit", 8)):
        items.append(Item(
            id=f"hf-dataset:{d['id']}",
            type="dataset",
            title=d["id"],
            url=f"https://huggingface.co/datasets/{d['id']}",
            source="HF Trending Datasets",
            source_key="hf_datasets",
            date=iso_date(d.get("createdAt") or d.get("lastModified")),
            abstract=clean_text(d.get("description", ""), 500),
            signals={"trending": d.get("trendingScore", 0), "likes": d.get("likes", 0)},
            tags=_clean_tags(d.get("tags", [])),
        ))
    for s in _trending(http, "spaces", cfg.get("spaces_limit", 8)):
        items.append(Item(
            id=f"hf-space:{s['id']}",
            type="space",
            title=s["id"],
            url=f"https://huggingface.co/spaces/{s['id']}",
            source="HF Trending Spaces",
            source_key="hf_spaces",
            date=iso_date(s.get("createdAt")),
            abstract=f"{s.get('sdk', '')} Space",
            signals={"trending": s.get("trendingScore", 0), "likes": s.get("likes", 0)},
            tags=_clean_tags(s.get("tags", [])),
        ))
    return items
