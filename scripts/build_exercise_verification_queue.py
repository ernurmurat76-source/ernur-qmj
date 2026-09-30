#!/usr/bin/env python3
"""Prepare every scanned textbook exercise for page-by-page human verification.

The queue is intentionally separate from the ready bank: a candidate must not
be rendered as editable QMJ/Word text until it is verified against its source
page and promoted to `verified-exercise-bank.json`.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--ready-bank", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding="utf-8"))
    ready = json.loads(args.ready_bank.read_text(encoding="utf-8"))
    ready_ids = {str(item.get("referenceId")) for item in ready.get("entries", [])}
    items = []
    for record in source.get("records", []):
        if record.get("source", {}).get("status") != "teacher-provided-ktz" or str(record.get("id")) in ready_ids:
            continue
        plan = record.get("prepared_plan") or {}
        exercise = plan.get("textbookExercise") or {}
        binding = plan.get("textbookPageBinding") or {}
        visuals = plan.get("visuals") or []
        items.append({
            "referenceId": record.get("id"),
            "grade": record.get("grade"),
            "subject": record.get("subject"),
            "track": record.get("track") or "",
            "term": record.get("term"),
            "section": record.get("section"),
            "topic": record.get("topic"),
            "exerciseNumber": str(exercise.get("number") or "").strip(),
            "candidateText": str(exercise.get("text") or "").strip(),
            "sourceBinding": binding,
            "excerptImage": str((visuals[0] or {}).get("src") or ""),
            "state": "needs-manual-formula-verification",
        })
    payload = {
        "version": "1.0",
        "policy": "Queue entries are source hints only; they are never exported to QMJ or Word before verification.",
        "items": items,
        "summary": {"needsManualFormulaVerification": len(items)},
    }
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False))


if __name__ == "__main__":
    raise SystemExit(main())
