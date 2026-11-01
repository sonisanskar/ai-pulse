"""Concept of the Day: one ML concept, taught in depth, tied to today's papers when possible.

The lesson comes back as Markdown (LaTeX survives intact that way, unlike inside JSON),
followed by a small ```json block of metadata.
"""
import json
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from .llm import LLM, LLMUnavailable, extract_json
from .models import Item

log = logging.getLogger("concepts")
CURRICULUM = Path(__file__).with_name("curriculum.yaml")

PROMPT = """You are a world-class ML teacher. Pick and teach today's "Concept of the Day" to a working ML engineer.

Today's top papers:
{papers}

Concepts already taught (do NOT pick these or near-duplicates):
{covered}

Choose ONE concept that is central to one or more of today's papers and worth understanding deeply.
If nothing in today's papers is a good teachable concept, teach this fallback instead: "{fallback}".

Respond in EXACTLY this format:

CONCEPT: <concept name>

## Intuition
<plain-language explanation with an analogy; 1-2 paragraphs>

## How it works
<the mechanics, with the key equations in LaTeX using $...$ inline and $$...$$ for display math; define every symbol>

## Minimal code
```python
<a short, correct, self-contained PyTorch or NumPy sketch, max ~30 lines>
```

## In today's research
<how this concept shows up in today's papers listed above (by title), or where it is used in practice>

## Pitfalls & misconceptions
<3-5 bullets>

## Go deeper
<3-4 bullets naming classic papers / resources by title and author (no URLs)>

```json
{{"category": "<e.g. architecture | training | alignment | inference | generative | retrieval | evaluation | theory>",
  "one_liner": "<one-sentence definition>",
  "prerequisites": ["<2-4 concepts to know first>"],
  "related_item_ids": ["<ids of today's papers this concept relates to>"],
  "flashcards": [{{"q": "<question>", "a": "<concise answer, plain text, no LaTeX>"}}, ... exactly 4 cards]}}
```"""


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]


def next_fallback(covered: List[str]) -> str:
    done = {c.lower() for c in covered}
    for name in yaml.safe_load(CURRICULUM.read_text()):
        if name.lower() not in done:
            return name
    return "A recent technique from today's papers"


def generate(items: List[Item], covered: List[str], llm: LLM, date: str) -> Optional[Dict]:
    papers = [i for i in items if i.type == "paper"][:15]
    fallback = next_fallback(covered)
    paper_lines = "\n".join(
        f"- {p.id} | {p.title} | {(p.summary or {}).get('tldr') or p.abstract[:200]}" for p in papers
    ) or "(no papers today)"
    try:
        text = llm.chat(
            [{"role": "user", "content": PROMPT.format(
                papers=paper_lines, covered=", ".join(covered[-200:]) or "(none yet)", fallback=fallback)}],
            tier="smart", max_tokens=4000, temperature=0.4,
        )
    except LLMUnavailable as ex:
        log.warning("concept generation failed: %s", ex)
        return None
    return parse_lesson(text, date, {p.id for p in papers})


def parse_lesson(text: str, date: str, valid_ids=frozenset()) -> Optional[Dict]:
    m = re.search(r"^\s*\**CONCEPT:?\**\s*(.+)$", text, re.M)
    if not m:
        return None
    name = m.group(1).strip().strip("*#").strip()
    body = text[m.end():]
    # metadata = the last ```json block
    meta_blocks = list(re.finditer(r"```json\s*(\{.*?\})\s*```", body, re.S))
    meta = {}
    if meta_blocks:
        last = meta_blocks[-1]
        meta = extract_json(last.group(1)) or {}
        body = body[:last.start()]
    cards = [c for c in meta.get("flashcards", []) if isinstance(c, dict) and c.get("q") and c.get("a")]
    return {
        "slug": slugify(name),
        "name": name,
        "date": date,
        "category": str(meta.get("category", "general")),
        "one_liner": str(meta.get("one_liner", "")),
        "prerequisites": [str(p) for p in meta.get("prerequisites", [])][:4],
        "related_item_ids": [i for i in meta.get("related_item_ids", []) if i in valid_ids],
        "flashcards": [{"q": str(c["q"]), "a": str(c["a"])} for c in cards][:6],
        "body": body.strip(),
    }


if __name__ == "__main__":  # quick manual check of the parser
    sample = 'CONCEPT: KV cache\n\n## Intuition\nx $a_i$\n\n```json\n{"category":"inference","flashcards":[{"q":"a","a":"b"}]}\n```'
    print(json.dumps(parse_lesson(sample, "2026-01-01"), indent=2))
