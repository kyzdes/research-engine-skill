#!/usr/bin/env python3
"""Canonical keys and source URLs for the research pipeline (references/schema.md, «Канонические ключи»).

    python canon.py <url> [<url> ...] [--kind person|org|product]

Prints one JSON line per URL: {"input", "key", "url"}. `key` is the items.id of what the URL points at, `url` is the
normalized address for sources.url. Stdlib only: runs under any python3 on every host.
"""
from __future__ import annotations

import json
import re
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING = re.compile(r"^(utm_.*|fbclid|gclid|yclid|igsh|igshid|si|feature|ref_src|ref_url|mc_cid|mc_eid|_hsenc|_hsmi)$", re.I)
MOBILE = re.compile(r"^(www|m|mobile|music)\.")
IG_POST = re.compile(r"^/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)")
YT_ID = re.compile(r"^/(?:shorts|live|embed|v)/([A-Za-z0-9_-]{11})")
ARXIV = re.compile(r"^/(?:abs|pdf|html)/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?(?:\.pdf)?$", re.I)


def _split(url: str):
    url = url.strip()
    if not re.match(r"^[a-z][a-z0-9+.-]*://", url, re.I):
        url = "https://" + url
    parts = urlsplit(url)
    host = MOBILE.sub("", (parts.hostname or "").lower())
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if len(path) > 1:
        path = path.rstrip("/")
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not TRACKING.match(k)]
    return host, path, query


def source_url(url: str) -> str:
    """Normalized full URL: https, no www/m., no tracking params or fragment, YouTube and Instagram in one form."""
    host, path, query = _split(url)
    if host == "youtu.be":
        host, query, path = "youtube.com", [("v", path.strip("/")[:11])], "/watch"
    elif host == "youtube.com" and (m := YT_ID.match(path)):
        query, path = [("v", m.group(1))], "/watch"
    elif host == "youtube.com" and path == "/watch":
        query = [(k, v) for k, v in query if k == "v"]
    elif host == "instagram.com" and (m := IG_POST.match(path)):
        path, query = f"/p/{m.group(1)}", []
    elif host in ("twitter.com", "x.com"):
        host = "x.com"
    return urlunsplit(("https", host, path if path != "/" else "", urlencode(sorted(query)), ""))


def item_key(url: str, kind: str | None = None) -> str:
    """items.id for the thing the URL points at. kind=person turns an account URL into person:<handle>;
    kind=org|product cuts a web address down to its domain."""
    host, path, query = _split(source_url(url))
    seg = [s for s in path.split("/") if s]
    q = dict(query)
    key = None
    if host == "github.com" and seg:
        key = "github:" + "/".join(seg[:2]).lower()
    elif host == "instagram.com" and seg:
        key = f"instagram:p/{seg[1]}" if seg[0] == "p" and len(seg) > 1 else "instagram:" + seg[0].lower()
    elif host == "youtube.com" and path == "/watch" and q.get("v"):
        key = "youtube:v/" + q["v"]
    elif host == "youtube.com" and seg:
        if seg[0] == "channel" and len(seg) > 1:
            key = "youtube:channel/" + seg[1]  # UC… ids are case-sensitive
        elif seg[0] in ("c", "user") and len(seg) > 1:
            key = f"youtube:{seg[0]}/{seg[1].lower()}"
        else:
            key = "youtube:" + seg[0].lower()
    elif host in ("t.me", "telegram.me") and seg:
        key = "telegram:" + seg[0].lower() + (f"/{seg[1]}" if len(seg) > 1 and seg[1].isdigit() else "")
    elif host == "x.com" and seg:
        key = f"x:status/{seg[2]}" if len(seg) > 2 and seg[1] == "status" else "x:" + seg[0].lower()
    elif host == "tiktok.com" and seg:
        key = f"tiktok:video/{seg[2]}" if len(seg) > 2 and seg[1] == "video" else "tiktok:" + seg[0].lower()
    elif host in ("linkedin.com",) and len(seg) > 1 and seg[0] in ("in", "company"):
        key = f"linkedin:{seg[0]}/{seg[1].lower()}"
    elif host == "arxiv.org" and (m := ARXIV.match(path)):
        key = "arxiv:" + m.group(1)
    elif host in ("doi.org", "dx.doi.org") and seg:
        key = "doi:" + "/".join(seg).lower()
    elif host == "huggingface.co" and seg:
        key = "hf:" + "/".join(seg[:3] if seg[0] in ("datasets", "spaces") else seg[:2])
    elif host == "kaggle.com" and len(seg) > 2 and seg[0] == "datasets":
        key = f"kaggle:{seg[1]}/{seg[2]}".lower()
    if kind == "person":
        if key is None or ":" not in key or "/" in key.split(":", 1)[1].lstrip("@"):
            raise ValueError(f"person keys come from an account URL, got {url!r}")
        return "person:" + key.split(":", 1)[1].lstrip("@")
    if kind in ("org", "product") or key is None:
        if kind in ("org", "product"):
            return "web:" + host
        tail = path if path != "/" else ""
        return "web:" + host + tail + ("?" + urlencode(sorted(query)) if query else "")
    return key


def main(argv):
    kind = None
    if "--kind" in argv:
        i = argv.index("--kind")
        kind, argv = argv[i + 1], argv[:i] + argv[i + 2:]
    if not argv:
        sys.exit(__doc__)
    for url in argv:
        print(json.dumps({"input": url, "key": item_key(url, kind), "url": source_url(url)}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
