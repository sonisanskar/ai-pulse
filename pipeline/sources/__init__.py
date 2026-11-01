from datetime import datetime, timezone
from typing import Optional

from dateutil import parser as dateparser

USER_AGENT = "Mozilla/5.0 (compatible; AI-Pulse/1.0; personal learning dashboard)"


def parse_dt(value) -> Optional[datetime]:
    """Parse a date string / struct_time / epoch into an aware UTC datetime."""
    if value is None or value == "":
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc)
        if hasattr(value, "tm_year"):  # time.struct_time from feedparser
            return datetime(*value[:6], tzinfo=timezone.utc)
        dt = dateparser.parse(str(value))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, OverflowError, TypeError):
        return None


def iso_date(value) -> str:
    dt = parse_dt(value)
    return (dt or datetime.now(timezone.utc)).date().isoformat()


def age_days(value) -> float:
    dt = parse_dt(value)
    if not dt:
        return 0.0
    return (datetime.now(timezone.utc) - dt).total_seconds() / 86400
