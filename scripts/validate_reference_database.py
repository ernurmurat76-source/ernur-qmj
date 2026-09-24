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
        if len(stages) != 4:
            errors.append(f'{record.get("id")}: дайын ҚМЖ-ның 4 кезеңі жоқ')
        if sum(int(stage.get("minutes", 0)) for stage in stages) != 45:
            errors.append(f'{record.get("id")}: дайын ҚМЖ 45 минут емес')
        if [int(stage.get("minutes", 0)) for stage in stages] != [5, 10, 25, 5]:
            errors.append(f'{record.get("id")}: кезеңдер 5–10–25–5 минутқа бөлінбеген')
        if [stage.get("name") for stage in stages] != ["Ұйымдастыру кезеңі", "Сабақтың басы", "Сабақтың ортасы", "Сабақтың соңы"]:
            errors.append(f'{record.get("id")}: кезең атаулары мұғалім үлгісіне сәйкес емес')
        for index, stage in enumerate(stages):
            if not stage.get("teacherActions") or not stage.get("learnerActions"):
                errors.append(f'{record.get("id")}: кезең әрекеттері толық емес')
            if stage.get("descriptors"):
                errors.append(f'{record.get("id")}: жалпы кезеңдік дескриптор болмауы тиіс')
            if any("бағдарлық PDF беті" in str(item) for item in stage.get("resources", [])):
                errors.append(f'{record.get("id")}: ресурстарда артық оқулық беті көрсетілген')
        expected_task_counts = [0, 1, 4, 1]
        if [len(stage.get("tasks") or []) for stage in stages] != expected_task_counts:
            errors.append(f'{record.get("id")}: тапсырмалар мен дескрипторлар кезеңдерге дұрыс орналаспаған')
        for stage in stages:
            for task in stage.get("tasks") or []:
                if not task.get("instruction") or not task.get("descriptor") or int(task.get("points", 0)) < 1:
                    errors.append(f'{record.get("id")}: тапсырма астындағы дескриптор немесе балл толық емес')
                if "бағдарлық PDF беті" in str(task.get("instruction", "")):
                    errors.append(f'{record.get("id")}: тапсырмада артық оқулық беті көрсетілген')
        if plan.get("assessmentCriteria"):
            errors.append(f'{record.get("id")}: артық бағалау критерийлері жолы сақталған')
        if not any("ББҮ" in str(item) for item in (stages[3].get("learnerActions") or [])):
            errors.append(f'{record.get("id")}: қорытындыда ББҮ кестесі жоқ')
        if "КТЖ-да берілген оқу мақсатына сәйкес" in " ".join(plan.get("lessonObjectives") or []):
            errors.append(f'{record.get("id")}: сабақ мақсатында артық КТЖ мәтіні сақталған')
        binding = plan.get("textbookPageBinding") or {}
        if binding.get("publisher") != "Атамұра" or not binding.get("file") or int(binding.get("pdfPage", 0)) < 1:
            errors.append(f'{record.get("id")}: Атамұра оқулығының беті байланыстырылмаған')
        if not plan.get("answerKey"):
            errors.append(f'{record.get("id")}: мұғалімге арналған жауап кілті жоқ')
        if not plan.get("textbookSources"):
            errors.append(f'{record.get("id")}: Атамұра оқулығымен сәйкестік көрсетілмеген')
        if record.get("textbook_alignment", {}).get("publisher") != "Атамұра":
            errors.append(f'{record.get("id")}: оқулық дереккөзі белгіленбеген')
        visuals = plan.get("visuals") or []
        if len(visuals) != 1 or visuals[0].get("kind") != "textbook-excerpt":
            errors.append(f'{record.get("id")}: оқулық тапсырмасының қиындысы тіркелмеген')
        for visual in visuals:
            src = str(visual.get("src", ""))
            visual_file = path.parent.parent / "public" / src.lstrip("/")
            if not src.startswith("/textbook-excerpts/task-") or not src.endswith(".jpg") or not visual_file.is_file():
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
        "teacher_template_plans": sum(record.get("prepared_plan", {}).get("templateStatus") == "teacher-provided-qmj-structure" for record in new_records),
        "textbook_page_bound": sum(bool(record.get("prepared_plan", {}).get("textbookPageBinding")) for record in new_records),
        "textbook_excerpt_embedded": sum(bool(record.get("prepared_plan", {}).get("visuals")) for record in new_records),
        "covered_groups": len(counts),
        "errors": errors,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
