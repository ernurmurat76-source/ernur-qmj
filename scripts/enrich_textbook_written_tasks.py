#!/usr/bin/env python3
"""Add written textbook-exercise references to every term 2–4 QMJ.

The exact exercise text stays visible in the embedded teacher-supplied textbook
excerpt. OCR is used only to recover printed exercise numbers; no AI service is
called and no OCR text is published as if it were authoritative.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGE_DIR = ROOT / "public" / "textbook-excerpts"
NUMBER_PATTERNS = (
    re.compile(r"(?m)^\s*(?:№\s*)?(\d{1,4}(?:[.,]\d{1,3})?)\s*[.)]"),
    re.compile(r"(?m)^\s*(\d{1,3}[.,]\d{1,3})\s+"),
)


def exercise_numbers(path: Path) -> tuple[str, list[str]]:
    environment = dict(os.environ)
    environment["OMP_THREAD_LIMIT"] = "1"
    try:
        result = subprocess.run(
            ["tesseract", str(path), "stdout", "-l", "eng", "--psm", "6"],
            check=False, capture_output=True, text=True, timeout=5, env=environment,
        )
    except subprocess.TimeoutExpired:
        return path.name, []
    text = result.stdout
    values: list[str] = []
    for pattern in NUMBER_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(1).replace(",", ".")
            if value not in values and not re.fullmatch(r"0(?:\.\d+)?", value):
                values.append(value)
    return path.name, values[:3]


def instruction(numbers: list[str]) -> str:
    if numbers:
        selected = " және ".join(f"№{value}" for value in numbers[:2])
        return f"Оқулық үзіндісіндегі {selected} есептерді жазбаша орында. Есептің шартын, қолданған ережені және толық шешу жолын көрсет."
    return "Оқулық үзіндісіндегі есепті немесе мысалды жазбаша орында. Берілгенін, қолданған ережені, шешу жолын және жауабын толық көрсет."


def main() -> int:
    data_path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "qmj-reference-index.json")
    data = json.loads(data_path.read_text(encoding="utf-8"))
    images = sorted(IMAGE_DIR.glob("task-*.jpg"))
    number_map: dict[str, list[str]] = {}
    if "--ocr" in sys.argv[2:]:
        with ThreadPoolExecutor(max_workers=12) as pool:
            number_map = dict(pool.map(exercise_numbers, images))

    changed = numbered = 0
    for record in data.get("records", []):
        if record.get("term") not in {2, 3, 4}:
            continue
        plan = record.get("prepared_plan") or {}
        visuals = plan.get("visuals") or []
        if not visuals:
            continue
        filename = Path(str(visuals[0].get("src") or "")).name
        numbers = number_map.get(filename, [])
        if numbers:
            numbered += 1
        for stage in plan.get("stages") or []:
            if stage.get("name") != "Сабақтың ортасы":
                continue
            tasks = stage.get("tasks") or []
            if not tasks:
                continue
            tasks[0]["instruction"] = instruction(numbers)
            tasks[0]["descriptor"] = "оқулықтағы есептің шартын жазып, ережені дұрыс қолданып, толық шешу жолы мен жауабын көрсетеді"
            tasks[0]["points"] = 2
            plan["textbookExerciseNumbers"] = numbers
            flags = record.get("quality_flags") or []
            record["quality_flags"] = list(dict.fromkeys(flags + ["written_textbook_task", "ai_free_textbook_plan"]))
            changed += 1
            break

    data["version"] = "21-ai-free-topic-mode"
    data["written_textbook_task_count"] = changed
    data["textbook_exercise_number_count"] = numbered
    data["runtime_ai_policy"] = "mathematics, algebra and geometry always use the local Atamura QMJ database without an AI API call"
    data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"changed": changed, "numbered": numbered, "images": len(images)}, ensure_ascii=False))
    return 0 if changed == 1164 else 1


if __name__ == "__main__":
    raise SystemExit(main())
