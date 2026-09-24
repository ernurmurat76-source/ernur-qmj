#!/usr/bin/env python3
"""Remove internal textbook file/page labels from the visible QMJ content."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


LABEL = re.compile(
    r"^Атамұра оқулығы:\s*«[^»]+»;\s*бөлім ретімен белгіленген\s*"
    r"бағдарлық PDF беті\s*[—-]\s*\d+\.\s*"
)


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "data/qmj-reference-index.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    changed = 0
    for record in data.get("records", []):
        plan = record.get("prepared_plan") or {}
        for stage in plan.get("stages", []):
            for task in stage.get("tasks", []):
                instruction = str(task.get("instruction", ""))
                cleaned = LABEL.sub("", instruction)
                if cleaned != instruction:
                    task["instruction"] = cleaned
                    changed += 1
            resources = stage.get("resources", [])
            if isinstance(resources, list):
                stage["resources"] = [
                    "Оқулық" if str(item).startswith("Атамұра оқулығы:") else item
                    for item in resources
                ]
        plan.pop("sourceNote", None)
    data["version"] = "15-teacher-base-descriptors-word-visuals"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"removed_task_labels": changed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
