#!/usr/bin/env python3
"""Add the teacher-base BBU conclusion to all prepared term 2–4 plans."""

from __future__ import annotations

import json
import sys
from pathlib import Path


TEACHER = "ББҮ кестесі арқылы сабақ нәтижесін қорытындылауды ұйымдастырады."
LEARNER = "ББҮ кестесін толтырады: «Білемін», «Білгім келеді», «Үйрендім»."


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "data/qmj-reference-index.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    changed = 0
    for record in data.get("records", []):
        plan = record.get("prepared_plan") or {}
        stages = plan.get("stages") or []
        if len(stages) != 4:
            continue
        ending = stages[3]
        ending["name"] = "Сабақтың соңы"
        ending["minutes"] = 5
        teacher = ending.setdefault("teacherActions", [])
        learner = ending.setdefault("learnerActions", [])
        resources = ending.setdefault("resources", [])
        if not any("ББҮ" in str(item) for item in teacher):
            teacher.append(TEACHER)
            changed += 1
        if not any("ББҮ" in str(item) for item in learner):
            learner.append(LEARNER)
        if "ББҮ кестесі" not in resources:
            resources.insert(0, "ББҮ кестесі")
        for index, (name, minutes) in enumerate((
            ("Ұйымдастыру кезеңі", 5),
            ("Сабақтың басы", 10),
            ("Сабақтың ортасы", 25),
            ("Сабақтың соңы", 5),
        )):
            stages[index]["name"] = name
            stages[index]["minutes"] = minutes
    data["version"] = "17-fixed-stages-bbu"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"updated_plans": changed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
