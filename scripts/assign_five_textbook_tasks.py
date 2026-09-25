#!/usr/bin/env python3
"""Place five existing exact textbook exercises into every prepared QMJ.

The script deliberately preserves the teacher's V26/V27 plan structure.  It
only replaces the beginning task and the four middle tasks, attaches the
matching crops to those tasks, and moves the solution route to the learner
column so the Word table remains balanced.
"""

from __future__ import annotations

import argparse
import json
import re
import tempfile
from collections import defaultdict
from pathlib import Path


EXACT_MODES = {"exact-pdf-text", "exact-scanned-ocr"}
WORD_RE = re.compile(r"[0-9A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]+")


def words(value: str) -> set[str]:
    return {item.lower() for item in WORD_RE.findall(value or "") if len(item) > 2}


def stage(plan: dict, name: str) -> dict | None:
    return next((item for item in plan.get("stages", []) if item.get("name") == name), None)


def candidate(record: dict) -> dict | None:
    plan = record.get("prepared_plan") or {}
    exercise = plan.get("textbookExercise") or {}
    if exercise.get("mode") not in EXACT_MODES:
        return None
    visual = next(iter(plan.get("visuals") or []), None)
    if not visual:
        middle = stage(plan, "Сабақтың ортасы") or {}
        visual = next(iter(middle.get("visuals") or []), None)
    if not visual or not visual.get("src"):
        return None
    binding = plan.get("textbookPageBinding") or {}
    return {
        "number": str(exercise.get("number") or "").strip(),
        "text": str(exercise.get("text") or "").strip(),
        "page": int(exercise.get("pdfPage") or binding.get("pdfPage") or 1),
        "mode": exercise.get("mode"),
        "visual": visual,
        "book": str(binding.get("file") or ""),
        "topic": str(record.get("topic") or ""),
        "section": str(record.get("section") or ""),
    }


def unique(items: list[dict]) -> list[dict]:
    result, seen = [], set()
    for item in items:
        marker = (item["book"], item["page"], item["number"], item["text"])
        if marker not in seen:
            result.append(item)
            seen.add(marker)
    return result


def score(item: dict, record: dict, page: int) -> tuple:
    topic_words = words(str(record.get("topic") or ""))
    section_words = words(str(record.get("section") or ""))
    item_topic = words(item["topic"])
    item_section = words(item["section"])
    return (
        len(topic_words & item_topic) * 20,
        len(section_words & item_section) * 8,
        -abs(item["page"] - page),
        -item["page"],
    )


def solution_route(number: str, instruction: str) -> str:
    low = instruction.lower()
    if any(token in low for token in ("сыз", "кескін", "координат", "график", "диаграм")):
        action = "сызбадағы берілгендерді белгілеп, қажетті қасиетті қолданады"
    elif any(token in low for token in ("салыстыр", ">", "<")):
        action = "сандарды ортақ түрде көрсетіп, салыстыру белгісін негіздеп қояды"
    elif any(token in low for token in ("теңдеу", "теңсіздік")):
        action = "белгісізді оқшаулайтын амалдарды ретімен орындап, нәтижені тексереді"
    elif any(token in low for token in ("өрнек", "мәнін тап", "есепте")):
        action = "амалдардың орындалу ретін сақтап есептеп, нәтижені кері амалмен тексереді"
    else:
        action = "берілгені мен ізделіндіні жазып, тиісті ереже бойынша амалдарды ретімен орындайды"
    return f"№{number} есептің шешу жолы: {action}; жауабын жазады және тексереді."


def task_from(source: dict, template: dict, number: int) -> dict:
    instruction = re.sub(rf"^\s*(?:№\s*)?{re.escape(source['number'])}\s*[.)]?\s*", "", source["text"], count=1)
    return {
        **template,
        "number": number,
        "exerciseNumber": source["number"],
        "instruction": instruction or source["text"],
        "visual": source["visual"],
        "textbookPage": source["page"],
        "textbookMode": source["mode"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.data.read_text(encoding="utf-8"))
    records = data.get("records", [])

    by_book: dict[str, list[dict]] = defaultdict(list)
    all_candidates = []
    for record in records:
        item = candidate(record)
        if item:
            by_book[item["book"]].append(item)
            all_candidates.append(item)
    for book in list(by_book):
        by_book[book] = unique(by_book[book])
    all_candidates = unique(all_candidates)

    changed = 0
    for record in records:
        if int(record.get("term") or 0) not in {2, 3, 4}:
            continue
        plan = record.get("prepared_plan") or {}
        beginning = stage(plan, "Сабақтың басы")
        middle = stage(plan, "Сабақтың ортасы")
        current = candidate(record)
        if not beginning or not middle or not current or not middle.get("tasks"):
            continue

        page = current["page"]
        existing = []
        for item in plan.get("textbookExercises") or []:
            visual = item.get("visual")
            item_page = int(item.get("pdfPage") or page)
            if visual and item.get("number") and item.get("text") and abs(item_page - page) <= 6:
                existing.append({
                    "number": str(item["number"]), "text": str(item["text"]),
                    "page": item_page, "mode": item.get("mode") or current["mode"],
                    "visual": visual, "book": current["book"], "topic": str(record.get("topic") or ""),
                    "section": str(record.get("section") or ""),
                })
        pool = [item for item in by_book.get(current["book"], all_candidates) if item["topic"] == str(record.get("topic") or "")]
        ranked = sorted(pool, key=lambda item: score(item, record, page), reverse=True)
        selected = unique(existing + [current] + ranked)[:5]
        if not selected:
            continue
        topical = list(selected)
        while len(selected) < 5:
            selected.append(topical[(len(selected) - len(topical)) % len(topical)])

        beginning_template = dict((beginning.get("tasks") or [{}])[0])
        beginning["tasks"] = [task_from(selected[0], beginning_template, 1)]
        beginning["learnerActions"] = [solution_route(selected[0]["number"], selected[0]["text"])]
        beginning.pop("visuals", None)

        old_tasks = list(middle.get("tasks") or [])
        while len(old_tasks) < 4:
            old_tasks.append(dict(old_tasks[-1] if old_tasks else beginning_template))
        middle["tasks"] = [task_from(selected[index + 1], dict(old_tasks[index]), index + 1) for index in range(4)]
        middle["learnerActions"] = [solution_route(item["number"], item["text"]) for item in selected[1:5]]
        middle.pop("visuals", None)

        plan["visuals"] = [item["visual"] for item in selected]
        plan["textbookExercises"] = [
            {"number": item["number"], "text": item["text"], "pdfPage": item["page"], "mode": item["mode"]}
            for item in selected
        ]
        flags = record.get("quality_flags") or []
        record["quality_flags"] = list(dict.fromkeys(flags + ["five_numbered_textbook_tasks", "task_images_embedded"]))
        changed += 1

    data["version"] = "28-five-numbered-textbook-tasks"
    data["five_textbook_task_plan_count"] = changed
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.data.parent, delete=False) as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        temporary = Path(handle.name)
    temporary.replace(args.data)
    print(json.dumps({"changed": changed, "candidate_count": len(all_candidates)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
