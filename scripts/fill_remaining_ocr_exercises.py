#!/usr/bin/env python3
"""Targeted fallback for plans whose topic title did not match the book language."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from collections import defaultdict
from pathlib import Path

from embed_scanned_textbook_exercises import (
    Exercise, crop_exercise, middle_stage, ocr_task_range, page_count,
    split_exercises,
)


ROOT = Path(__file__).resolve().parents[1]
EXACT_MODES = {"exact-pdf-text", "exact-scanned-ocr"}
RELAXED_START = re.compile(r"(?m)^\s*(?:№\s*)?((?:\d{1,2}\.)?\d{1,4})\s*[.)]\s+(?=\S)")


def relaxed_exercises(text: str, page_index: int) -> list[Exercise]:
    matches = list(RELAXED_START.finditer(text))
    result: list[Exercise] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        block = re.sub(r"\s+", " ", text[match.start():end]).strip()
        if 25 <= len(block) <= 1600:
            result.append(Exercise(page_index, match.group(1), block[:1400]))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "qmj-reference-index.json")
    parser.add_argument("--books", type=Path, default=ROOT.parent / "textbook_extract" / "Гео-Математика Атамұра")
    parser.add_argument("--tessdata", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=ROOT / ".ocr-cache")
    parser.add_argument("--images", type=Path, default=ROOT / "public" / "textbook-excerpts")
    parser.add_argument("--workers", type=int, default=min(4, os.cpu_count() or 2))
    args = parser.parse_args()

    data = json.loads(args.data.read_text(encoding="utf-8"))
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for record in data.get("records", []):
        if record.get("term") not in {2, 3, 4}:
            continue
        plan = record.get("prepared_plan") or {}
        if (plan.get("textbookExercise") or {}).get("mode") in EXACT_MODES:
            continue
        binding = plan.get("textbookPageBinding") or {}
        if binding.get("file"):
            groups[(str(binding["file"]), str(record.get("topic") or "Сабақ"))].append(record)

    changed = 0
    unresolved: list[dict] = []
    for (book, topic), records in sorted(groups.items()):
        source = args.books / book
        total = page_count(source)
        hints = [int((record["prepared_plan"].get("textbookPageBinding") or {}).get("pdfPage") or 1) for record in records]
        # Look around the teacher-provided lesson-order hint.  A wider backward
        # window covers review and end-of-term lessons whose hint may point to
        # an answer-key or contents page.
        low = max(0, min(hints) - 16)
        high = min(total - 1, max(hints) + 10)
        indices = list(range(low, high + 1))
        texts = ocr_task_range(source, book, indices, args.tessdata, args.cache, args.workers)
        exercises: list[Exercise] = []
        seen: set[tuple[int, str]] = set()
        for page_index in indices:
            found = split_exercises(texts.get(page_index, ""), page_index)
            if not found:
                found = relaxed_exercises(texts.get(page_index, ""), page_index)
            for exercise in found:
                marker = (exercise.page_index, exercise.number)
                if marker not in seen:
                    exercises.append(exercise)
                    seen.add(marker)
        if not exercises:
            unresolved.append({"book": book, "topic": topic, "records": len(records)})
            continue

        # Use exercises nearest to the hinted teaching sequence.
        centre = sum(hints) / len(hints) - 1
        exercises.sort(key=lambda exercise: (abs(exercise.page_index - centre), exercise.page_index, exercise.number))
        for index, record in enumerate(records):
            exercise = exercises[index % len(exercises)]
            plan = record["prepared_plan"]
            stage = middle_stage(plan)
            if not stage or not stage.get("tasks"):
                continue
            filename = crop_exercise(source, book, exercise, args.tessdata, args.cache, args.images)
            visual = {
                "src": f"/textbook-excerpts/{filename}",
                "alt": f"№{exercise.number} есептің кітаптағы нұсқасы",
                "caption": f"№{exercise.number} есеп",
                "kind": "textbook-excerpt",
            }
            stage["tasks"][0]["instruction"] = exercise.text
            stage["visuals"] = [visual]
            plan["visuals"] = [visual]
            plan["textbookExercise"] = {
                "number": exercise.number, "text": exercise.text,
                "pdfPage": exercise.page_index + 1, "mode": "exact-scanned-ocr",
            }
            plan["textbookPageBinding"]["pdfPage"] = exercise.page_index + 1
            record["quality_flags"] = list(dict.fromkeys((record.get("quality_flags") or []) + [
                "textbook_exercise_text_ocr", "textbook_exercise_image_matched", "ocr_hint_fallback",
            ]))
            changed += 1

    data["version"] = "27-scanned-textbook-ocr"
    data["ocr_textbook_exercise_count"] = sum(
        (record.get("prepared_plan") or {}).get("textbookExercise", {}).get("mode") == "exact-scanned-ocr"
        for record in data.get("records", [])
    )
    data["exact_textbook_exercise_count"] = sum(
        (record.get("prepared_plan") or {}).get("textbookExercise", {}).get("mode") in EXACT_MODES
        for record in data.get("records", [])
    )
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.data.parent, delete=False) as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        temporary = Path(handle.name)
    temporary.replace(args.data)
    print(json.dumps({"changed": changed, "unresolved": unresolved}, ensure_ascii=False, indent=2))
    return 1 if unresolved else 0


if __name__ == "__main__":
    raise SystemExit(main())
