#!/usr/bin/env python3
"""Fail if OCR work changes any established V26 lesson-plan field."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path


def sanitize(record: dict) -> dict:
    item = copy.deepcopy(record)
    item.pop("quality_flags", None)
    plan = item.get("prepared_plan") or {}
    plan.pop("visuals", None)
    plan.pop("textbookExercise", None)
    binding = plan.get("textbookPageBinding") or {}
    binding.pop("pdfPage", None)
    for stage in plan.get("stages") or []:
        if stage.get("name") != "Сабақтың ортасы":
            continue
        stage.pop("visuals", None)
        tasks = stage.get("tasks") or []
        if tasks:
            tasks[0].pop("instruction", None)
    return item


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    before = json.loads(args.baseline.read_text(encoding="utf-8"))
    after = json.loads(args.candidate.read_text(encoding="utf-8"))
    before_records = {record["id"]: sanitize(record) for record in before.get("records", [])}
    after_records = {record["id"]: sanitize(record) for record in after.get("records", [])}
    if before_records.keys() != after_records.keys():
        raise SystemExit("record identifiers changed")
    changed = [record_id for record_id in before_records if before_records[record_id] != after_records[record_id]]
    if changed:
        print(json.dumps({"unexpected_changes": changed[:20], "count": len(changed)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"records_checked": len(before_records), "v26_structure_preserved": True}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
