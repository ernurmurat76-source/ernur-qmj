#!/usr/bin/env python3
"""Validate the server-side QMJ reference database after imports."""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "data/qmj-reference-index.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    records = data.get("records", [])
    errors = []
    ids = [record.get("id") for record in records]
    if len(ids) != len(set(ids)):
        errors.append("Қайталанатын record id табылды")
    if data.get("record_count") != len(records):
        errors.append("record_count нақты жазба санымен сәйкес емес")

    new_records = [record for record in records if record.get("source", {}).get("status") == "teacher-provided-ktz"]
    for record in new_records:
        if record.get("term") not in {2, 3, 4}:
            errors.append(f'{record.get("id")}: тоқсан қате')
        if record.get("grade") not in range(5, 12):
            errors.append(f'{record.get("id")}: сынып қате')
        if record.get("subject") not in {"Математика", "Алгебра", "Геометрия"}:
            errors.append(f'{record.get("id")}: пән қате')
        if not record.get("topic"):
            errors.append(f'{record.get("id")}: тақырып жоқ')
        if not record.get("methodological_guidance"):
            errors.append(f'{record.get("id")}: әдістемелік бағыт жоқ')
        plan = record.get("prepared_plan") or {}
        stages = plan.get("stages") or []
        if len(stages) != 3:
            errors.append(f'{record.get("id")}: дайын ҚМЖ-ның 3 кезеңі жоқ')
        if sum(int(stage.get("minutes", 0)) for stage in stages) != 45:
            errors.append(f'{record.get("id")}: дайын ҚМЖ 45 минут емес')
        for stage in stages:
            if not stage.get("teacherActions") or not stage.get("learnerActions"):
                errors.append(f'{record.get("id")}: кезең әрекеттері толық емес')
            if not stage.get("descriptors") or any(int(item.get("points", 0)) < 1 for item in stage.get("descriptors", [])):
                errors.append(f'{record.get("id")}: дескриптор немесе балл толық емес')
        middle = stages[1] if len(stages) > 1 else {}
        teacher_text = " ".join(middle.get("teacherActions") or [])
        if not all(marker in teacher_text for marker in ("1-тапсырма", "2-тапсырма", "3-тапсырма", "4-тапсырма")):
            errors.append(f'{record.get("id")}: нақты төрт оқу тапсырмасы толық емес')
        if not plan.get("answerKey"):
            errors.append(f'{record.get("id")}: мұғалімге арналған жауап кілті жоқ')
        if not plan.get("textbookSources"):
            errors.append(f'{record.get("id")}: Атамұра оқулығымен сәйкестік көрсетілмеген')
        if record.get("textbook_alignment", {}).get("publisher") != "Атамұра":
            errors.append(f'{record.get("id")}: оқулық дереккөзі белгіленбеген')
        for visual in plan.get("visuals") or []:
            src = str(visual.get("src", ""))
            visual_file = path.parent.parent / "public" / src.lstrip("/")
            if not src.startswith("/visuals/") or not visual_file.is_file():
                errors.append(f'{record.get("id")}: көрнекілік файлы табылмады: {src}')

    counts = Counter((record.get("grade"), record.get("subject"), record.get("track", ""), record.get("term")) for record in new_records)
    required = []
    for grade in (5, 6):
        for term in (2, 3, 4): required.append((grade, "Математика", "", term))
    for grade in (7, 8, 9):
        for subject in ("Алгебра", "Геометрия"):
            for term in (2, 3, 4): required.append((grade, subject, "", term))
    for grade in (10, 11):
        for subject in ("Алгебра", "Геометрия"):
            for track in ("ЖМБ", "ҚГБ"):
                for term in (2, 3, 4): required.append((grade, subject, track, term))
    for key in required:
        if not counts[key]:
            errors.append(f"Қамтылмаған топ: {key}")

    summary = {
        "records": len(records),
        "new_ktz_records": len(new_records),
        "prepared_plans": sum(bool(record.get("prepared_plan")) for record in new_records),
        "atamura_aligned": sum(record.get("textbook_alignment", {}).get("publisher") == "Атамұра" for record in new_records),
        "plans_with_visuals": sum(bool(record.get("prepared_plan", {}).get("visuals")) for record in new_records),
        "covered_groups": len(counts),
        "errors": errors,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
