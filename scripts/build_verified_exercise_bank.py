#!/usr/bin/env python3
"""Create the safe, reusable textbook-exercise bank.

Only text that came from a machine-readable textbook page and passes a strict
character check is allowed into this bank.  OCR from scanned pages is kept in
the reference database as a *candidate*, but is deliberately never promoted
to a Word/QMJ task by this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import date
from pathlib import Path


BAD_OCR = re.compile(r"(?:в[>»]|в[<«]|[«»]{2,}|_{2,}|\ufffd)")
MATH_SIGNAL = re.compile(r"\d|[=+\-−×·:/<>≤≥]")


def valid_text(text: str) -> bool:
    text = " ".join(str(text or "").split())
    return len(text) >= 20 and bool(MATH_SIGNAL.search(text)) and not BAD_OCR.search(text)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="Unmodified V28 reference database")
    parser.add_argument("--manual", type=Path, help="Page-verified scanned exercise entries")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding="utf-8"))
    entries = []
    rejected = []
    for record in source.get("records", []):
        plan = record.get("prepared_plan") or {}
        exercise = plan.get("textbookExercise") or {}
        if exercise.get("mode") != "exact-pdf-text":
            continue
        text = " ".join(str(exercise.get("text") or "").split())
        if not valid_text(text):
            rejected.append(record.get("id"))
            continue
        key = f"{record.get('id')}|{exercise.get('number')}|{text}"
        entries.append({
            "id": hashlib.sha256(key.encode("utf-8")).hexdigest()[:20],
            "referenceId": record.get("id"),
            "grade": record.get("grade"),
            "subject": record.get("subject"),
            "term": record.get("term"),
            "topic": record.get("topic"),
            "exerciseNumber": str(exercise.get("number") or "").strip(),
            "text": text,
            "source": "machine-readable-atamura-pdf",
            "verification": "automatic-safe-text",
            "reviewState": "ready",
        })
    if args.manual and args.manual.exists():
        manual = json.loads(args.manual.read_text(encoding="utf-8"))
        for item in manual.get("entries", []):
            text = " ".join(str(item.get("text") or "").split())
            if not valid_text(text):
                rejected.append(str(item.get("referenceId") or "manual"))
                continue
            entry = dict(item)
            entry["text"] = text
            entry["source"] = "manual-page-verification"
            entry["verification"] = "source-page-visual-check"
            entry["reviewState"] = "ready"
            entry["id"] = str(entry.get("id") or hashlib.sha256((str(entry.get("referenceId")) + text).encode("utf-8")).hexdigest()[:20])
            entries.append(entry)
    payload = {
        "version": "1.0",
        "generatedAt": str(date.today()),
        "policy": "Only ready entries can appear as editable task text in QMJ/Word.",
        "entries": entries,
        "summary": {"ready": len(entries), "rejected": len(rejected), "manualReviewRequired": 0},
    }
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False))


if __name__ == "__main__":
    raise SystemExit(main())
