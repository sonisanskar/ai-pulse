import hashlib
import html
import re
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional

# type -> which tab of the site the item lands in
TAB_FOR_TYPE = {
    "paper": "papers",
    "news": "news",
    "model": "models",
    "dataset": "models",
    "space": "models",
    "repo": "models",
}


@dataclass
class Item:
    id: str
    type: str                 # paper | news | model | dataset | space | repo
    title: str
    url: str
    source: str               # human readable, e.g. "Hugging Face Papers"
    source_key: str           # config key used for weighting, e.g. "hf_papers"
    date: str                 # ISO date the item was published (best effort)
    authors: List[str] = field(default_factory=list)
    abstract: str = ""
    signals: Dict[str, float] = field(default_factory=dict)   # upvotes, points, stars, likes, ...
    links: Dict[str, str] = field(default_factory=dict)       # extra links: pdf, code, discussion
    tags: List[str] = field(default_factory=list)              # source-provided tags
    score: float = 0.0
    first_seen: str = ""      # ISO datetime of the run that first saw it
    summary: Optional[Dict] = None

    @property
    def tab(self) -> str:
        return TAB_FOR_TYPE.get(self.type, "news")

    def to_dict(self) -> Dict:
        d = asdict(self)
        d["tab"] = self.tab
        return d


def make_id(prefix: str, key: str) -> str:
    return f"{prefix}:{hashlib.sha1(key.strip().lower().encode()).hexdigest()[:12]}"


def clean_text(s: str, limit: int = 1200) -> str:
    """Strip HTML tags / whitespace and cap length."""
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit] + ("…" if len(s) > limit else "")
