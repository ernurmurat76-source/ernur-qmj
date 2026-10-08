#!/usr/bin/env python3
"""Show every textbook task as its bound scan in term 2–4 math plans."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / "data" / "qmj-reference-index.json"
SUBJECTS = {"Математика", "Алгебра", "Геометрия"}


def main() -> None:
    data = json.loads(DATABASE.read_text(encoding="utf-8"))
    plans = tasks = 0

    for record in data.get("records", []):
        if record.get("subject") not in SUBJECTS or record.get("term") not in {2, 3, 4}:
            continue
        plan = record.get("prepared_plan") or {}
        changed = False
        for stage in plan.get("stages", []):
            for task in stage.get("tasks", []):
                visual = task.get("visual") or {}
                if not visual.get("src"):
                    continue
                task["displayMode"] = "image"
                tasks += 1
                changed = True
        if changed:
            plans += 1
            flags = record.get("quality_flags") or []
            record["quality_flags"] = list(dict.fromkeys([*flags, "all_textbook_tasks_shown_as_images"]))

    data["version"] = "30-all-math-tasks-with-images"
    data["all_math_task_images"] = {"plans": plans, "tasks": tasks, "terms": [2, 3, 4], "grades": [5, 6, 7, 8, 9, 10, 11]}
    DATABASE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(data["all_math_task_images"], ensure_ascii=False))


if __name__ == "__main__":
    main()
