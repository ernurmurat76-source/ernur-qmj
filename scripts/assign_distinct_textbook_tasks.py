#!/usr/bin/env python3
"""Assign five distinct, nearby textbook exercises to every prepared QMJ.

The source images are the ground truth for scanned books.  Machine-readable
exercise text remains editable; scanned formula OCR is never exposed as task
text because it can corrupt fractions and mathematical symbols.
"""

from __future__ import annotations

import argparse
import json
import re
import tempfile
from collections import defaultdict
from copy import deepcopy
from pathlib import Path


def normalized_topic(value: str) -> str:
    value = re.sub(r"\s*\.?(?:ББЖБ|БЖБ|ТЖБ).*?$", "", str(value or ""), flags=re.I)
    return re.sub(r"\s+", " ", value).strip(" .").lower()


WORD_RE = re.compile(r"[0-9A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]+")
STOP_WORDS = {"және", "мен", "үшін", "бойынша", "арқылы", "туралы", "қайталау"}


def topic_words(value: str) -> set[str]:
    return {word.lower() for word in WORD_RE.findall(value or "") if len(word) > 2} - STOP_WORDS


def stage(plan: dict, name: str) -> dict | None:
    return next((item for item in plan.get("stages", []) if item.get("name") == name), None)


def page_number(task: dict, plan: dict) -> int:
    try:
        return int(task.get("textbookPage") or (plan.get("textbookPageBinding") or {}).get("pdfPage") or 1)
    except (TypeError, ValueError):
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.data.read_text(encoding="utf-8"))
    by_book: dict[tuple, dict[tuple, dict]] = defaultdict(dict)
    section_pages: dict[tuple, list[int]] = defaultdict(list)
    targets = []

    for record in data.get("records", []):
        if record.get("source", {}).get("status") != "teacher-provided-ktz":
            continue
        plan = record.get("prepared_plan") or {}
        binding = plan.get("textbookPageBinding") or {}
        book_key = (record.get("grade"), record.get("subject"), record.get("track") or "", binding.get("file") or "")
        targets.append((record, book_key))
        section_pages[(book_key, str(record.get("section") or ""))].append(
            int(binding.get("pdfPage") or 1)
        )
        for source_stage in plan.get("stages", []):
            if source_stage.get("name") not in {"Сабақтың басы", "Сабақтың ортасы"}:
                continue
            for task in source_stage.get("tasks") or []:
                visual = deepcopy(task.get("visual") or {})
                number = str(task.get("exerciseNumber") or "").strip()
                src = str(visual.get("src") or "").strip()
                if not number or not src:
                    continue
                candidate = {
                    "exerciseNumber": number,
                    "instruction": str(task.get("instruction") or "").strip(),
                    "descriptor": str(task.get("descriptor") or "есепті тиісті тәсілмен орындайды және жауабын тексереді").strip(),
                    "points": max(1, int(task.get("points") or 1)),
                    "visual": visual,
                    "textbookMode": str(task.get("textbookMode") or "exact-scanned-ocr"),
                    "textbookPage": page_number(task, plan),
                    "topic": str(record.get("topic") or ""),
                    "topicKey": normalized_topic(record.get("topic") or ""),
                    "section": str(record.get("section") or ""),
                    "term": record.get("term"),
                }
                marker = (number, src)
                existing = by_book[book_key].get(marker)
                if existing:
                    existing["topicKeys"].add(candidate["topicKey"])
                    existing["topicWords"].update(topic_words(candidate["topic"]))
                    existing["sections"].add(candidate["section"])
                    existing["terms"].add(candidate["term"])
                else:
                    candidate["topicKeys"] = {candidate["topicKey"]}
                    candidate["topicWords"] = topic_words(candidate["topic"])
                    candidate["sections"] = {candidate["section"]}
                    candidate["terms"] = {candidate["term"]}
                    by_book[book_key][marker] = candidate

    changed = 0
    failures = []
    for record, book_key in targets:
        plan = record.get("prepared_plan") or {}
        beginning = stage(plan, "Сабақтың басы")
        middle = stage(plan, "Сабақтың ортасы")
        if not beginning or not middle or len(beginning.get("tasks") or []) != 1 or len(middle.get("tasks") or []) != 4:
            failures.append(record.get("id"))
            continue
        target_topic = normalized_topic(record.get("topic") or "")
        target_section = str(record.get("section") or "")
        target_term = record.get("term")
        target_page = int((plan.get("textbookPageBinding") or {}).get("pdfPage") or 1)
        target_words = topic_words(record.get("topic") or "")
        pages = section_pages[(book_key, target_section)]
        section_low, section_high = min(pages), max(pages)

        # Never take an exercise merely because it is in the same quarter.
        # It must belong to the same named section/topic, or be located in the
        # textbook page range surrounding that section.  The 20-page margin is
        # only a recovery window for short sections whose original extraction
        # produced fewer than five separate crops.
        candidates = [item for item in by_book.get(book_key, {}).values() if (
            target_section in item["sections"]
            or target_topic in item["topicKeys"]
            or (
                section_low - 20 <= item["textbookPage"] <= section_high + 20
            )
        )]
        candidates.sort(key=lambda item: (
            0 if target_topic in item["topicKeys"] else 1,
            0 if target_section in item["sections"] else 1,
            -len(target_words & item["topicWords"]),
            0 if target_term in item["terms"] else 1,
            abs(item["textbookPage"] - target_page),
            item["textbookPage"],
            item["exerciseNumber"],
        ))
        selected = []
        used_numbers = set()
        used_images = set()
        for item in candidates:
            if item["exerciseNumber"] in used_numbers or item["visual"]["src"] in used_images:
                continue
            selected.append(item)
            used_numbers.add(item["exerciseNumber"])
            used_images.add(item["visual"]["src"])
            if len(selected) == 5:
                break
        if len(selected) < 5:
            failures.append(record.get("id"))
            continue

        destination_tasks = beginning["tasks"] + middle["tasks"]
        for position, (task, source) in enumerate(zip(destination_tasks, selected), start=1):
            exact_text = source["textbookMode"] == "exact-pdf-text" and len(source["instruction"]) >= 20
            task.update({
                "number": 1 if position == 1 else position - 1,
                "exerciseNumber": source["exerciseNumber"],
                "instruction": source["instruction"] if exact_text else "Оқулықтағы есепті орындаңдар.",
                "descriptor": source["descriptor"],
                "points": source["points"],
                "visual": source["visual"],
                "textbookMode": source["textbookMode"],
                "textbookPage": source["textbookPage"],
                "displayMode": "text" if exact_text else "image",
            })
        beginning["learnerActions"] = [f"№{selected[0]['exerciseNumber']} есепті орындайды, жауабын жазады және тексереді."]
        middle["learnerActions"] = [f"№{item['exerciseNumber']} есепті орындайды, жауабын жазады және тексереді." for item in selected[1:]]
        plan["visuals"] = [item["visual"] for item in selected]
        plan["distinctTextbookTasks"] = [{
            "number": item["exerciseNumber"], "pdfPage": item["textbookPage"],
            "mode": "editable-text" if item["textbookMode"] == "exact-pdf-text" else "source-image",
            "alignment": (
                "exact-topic" if target_topic in item["topicKeys"] else
                "same-section" if target_section in item["sections"] else
                "section-page-range"
            ),
        } for item in selected]
        record["quality_flags"] = list(dict.fromkeys((record.get("quality_flags") or []) + ["five_distinct_textbook_exercises", "no_unverified_formula_ocr_text"]))
        changed += 1

    data["version"] = "30-distinct-textbook-tasks-all-plans"
    data["distinct_textbook_task_plan_count"] = changed
    data["distinct_textbook_task_failures"] = failures
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.data.parent, delete=False) as out:
        json.dump(data, out, ensure_ascii=False, indent=2)
        temporary = Path(out.name)
    temporary.replace(args.data)
    print(json.dumps({"changed": changed, "failures": len(failures)}, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
