#!/usr/bin/env python3
"""Fail a build if unsafe OCR text is allowed into the verified bank."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


BAD_OCR = re.compile(r"(?:в[>»]|в[<«]|[«»]{2,}|_{2,}|\ufffd)")
MATH_SIGNAL = re.compile(r"\d|[=+\-−×·:/<>≤≥]")


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "data/verified-exercise-bank.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    errors = []
    seen = set()
    for item in data.get("entries", []):
        identifier = item.get("id")
        text = " ".join(str(item.get("text") or "").split())
        if not identifier or identifier in seen:
            errors.append(f"қайталанатын не бос id: {identifier}")
        seen.add(identifier)
        if item.get("reviewState") != "ready":
            errors.append(f"{identifier}: ready емес жазба базаға кірген")
        if len(text) < 20 or not MATH_SIGNAL.search(text):
            errors.append(f"{identifier}: толық есеп мәтіні жоқ")
        if BAD_OCR.search(text):
            errors.append(f"{identifier}: OCR қате таңбасы табылды")
        if item.get("source") not in {"machine-readable-atamura-pdf", "manual-page-verification"}:
            errors.append(f"{identifier}: тексерілмеген дереккөз")
    if data.get("summary", {}).get("ready") != len(data.get("entries", [])):
        errors.append("summary.ready нақты жазба санымен сәйкес емес")
    print(json.dumps({"ready": len(data.get("entries", [])), "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
