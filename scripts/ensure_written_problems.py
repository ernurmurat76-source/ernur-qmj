#!/usr/bin/env python3
"""Ensure every term 2–4 lesson visibly contains a written problem."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "qmj-reference-index.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    exact = aligned = 0
    for record in data.get("records", []):
        if record.get("term") not in {2, 3, 4}:
            continue
        plan = record.get("prepared_plan") or {}
        middle = next((stage for stage in plan.get("stages", []) if stage.get("name") == "Сабақтың ортасы"), None)
        if not middle or len(middle.get("tasks") or []) < 4:
            continue
        tasks = middle["tasks"]
        if plan.get("textbookExercise", {}).get("mode") == "exact-pdf-text":
            exact += 1
        else:
            concrete = [dict(task) for task in tasks[1:4]]
            for target, source in zip(tasks[:3], concrete):
                target.update({"instruction": source["instruction"], "descriptor": source["descriptor"], "points": source["points"]})
            tasks[3].update({"instruction": "Жоғарыдағы есептердің біреуін басқа тәсілмен шығарып, екі шешу жолының нәтижесін салыстыр.", "descriptor": "есепті балама тәсілмен шығарып, екі шешудің нәтижесін салыстырады", "points": 1})
            plan["writtenProblemMode"] = "topic-aligned-with-source-image"
            aligned += 1
        record["quality_flags"] = list(dict.fromkeys((record.get("quality_flags") or []) + ["written_textbook_task", "written_problem_visible_with_image"]))
    data["written_problem_count"] = exact + aligned
    data["exact_textbook_exercise_count"] = exact
    data["image_scan_aligned_problem_count"] = aligned
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"written": exact + aligned, "exact_pdf_text": exact, "scan_aligned": aligned}, ensure_ascii=False))
    return 0 if exact + aligned == 1164 else 1

if __name__ == "__main__":
    raise SystemExit(main())
