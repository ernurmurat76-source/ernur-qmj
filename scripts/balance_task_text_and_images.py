#!/usr/bin/env python3
"""Prevent OCR formula corruption in QMJ task text.

For scanned textbook pages, only the verbal instruction is typed. Formulae and
fraction lists are retained as a source image in tasks 3–4.  Learner cells get
short observable actions rather than copied OCR conditions or solution text.
"""
from __future__ import annotations

import argparse
import json
import re
import tempfile
from pathlib import Path


def stage(plan: dict, name: str) -> dict | None:
    return next((item for item in plan.get("stages", []) if item.get("name") == name), None)


def readable_prompt(task: dict) -> str:
    text = re.sub(r"^\s*(?:№\s*)?\d+(?:[.)]\d+)?\s*[.)]?\s*", "", str(task.get("instruction") or "").strip())
    if task.get("textbookMode") == "exact-pdf-text":
        return text
    # OCR formulae are unreliable. Retain only the human-readable wording
    # preceding the formula list, which conventionally starts after a colon.
    low = text.lower()
    # Do not trust even the apparent formula signs in OCR text: a visual
    # check showed false characters such as `в>»`.  Keep only a clean,
    # age-appropriate verbal action for typed tasks.
    if "салыстыр" in low:
        return "Берілген сандарды салыстырыңдар."
    if "ретімен" in low:
        return "Берілген сандарды өсу ретімен жазыңдар."
    if "теңсіздік" in low:
        return "Теңсіздікті шешіңдер."
    if "теңдеу" in low:
        return "Теңдеуді шешіңдер."
    if "бөлшектің бөлігін" in low:
        return "Бөлшектің берілген бөлігін табыңдар."
    if "өрнект" in low and "мән" in low:
        return "Өрнектің мәнін табыңдар."
    if "график" in low:
        return "График бойынша тапсырманы орындаңдар."
    if "дәлелде" in low:
        return "Тұжырымды дәлелдеңдер."
    if "аудан" in low:
        return "Фигураның ауданын табыңдар."
    if "периметр" in low:
        return "Фигураның периметрін табыңдар."
    if "бұрыш" in low:
        return "Бұрыштардың шамасын табыңдар."
    return "Есепті орындаңдар."


def learner_action(task: dict) -> str:
    number = str(task.get("exerciseNumber") or task.get("number") or "")
    return f"№{number} есепті орындайды, жауабын жазады және тексереді."


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.data.read_text(encoding="utf-8"))
    changed = 0
    for record in data.get("records", []):
        plan = record.get("prepared_plan") or {}
        beginning = stage(plan, "Сабақтың басы")
        middle = stage(plan, "Сабақтың ортасы")
        if not beginning or not middle:
            continue
        first, middle_tasks = beginning.get("tasks") or [], middle.get("tasks") or []
        if len(first) != 1 or len(middle_tasks) != 4:
            continue
        first[0]["instruction"] = readable_prompt(first[0])
        first[0]["displayMode"] = "text"
        for index, task in enumerate(middle_tasks):
            task["instruction"] = readable_prompt(task)
            task["displayMode"] = "text" if index < 2 else "image"
        beginning["learnerActions"] = [learner_action(first[0])]
        middle["learnerActions"] = [learner_action(task) for task in middle_tasks]
        beginning.pop("visuals", None)
        middle.pop("visuals", None)
        record["quality_flags"] = list(dict.fromkeys((record.get("quality_flags") or []) + ["ocr_formula_text_suppressed", "two_text_two_image_middle_tasks"]))
        changed += 1
    data["version"] = "29-text-image-balanced-tasks"
    data["text_image_balanced_plan_count"] = changed
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.data.parent, delete=False) as out:
        json.dump(data, out, ensure_ascii=False, indent=2)
        temporary = Path(out.name)
    temporary.replace(args.data)
    print(json.dumps({"changed": changed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
