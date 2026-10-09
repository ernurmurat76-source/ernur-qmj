#!/usr/bin/env python3
"""Import teacher-provided history and law KTZ tables into the QMJ database."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

from docx import Document


ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / "data" / "qmj-reference-index.json"


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def term_number(value: str) -> int | None:
    match = re.search(r"(?<!\d)([1-4])[-–—\s]*тоқсан\b", clean(value), re.I)
    return int(match.group(1)) if match else None


def objective_codes(value: str) -> list[str]:
    compact = re.sub(r"(?<=\d)\s*\.\s*(?=\d)", ".", value)
    return list(dict.fromkeys(re.findall(r"(?<!\d)(?:5|6|7|8|9|10|11)(?:\.\d+){3}(?!\d)", compact)))


def first_number(values: list[str]) -> int:
    for value in values:
        if re.fullmatch(r"\d+", value):
            number = int(value)
            if 1 <= number <= 20:
                return number
    return 1


def make_id(source: str, table: int, row: int, subject: str, grade: int, track: str) -> str:
    raw = f"history-ktp|{source}|{table}|{row}|{subject}|{grade}|{track}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def parse_table(path: Path, table_index: int, *, subject: str, grade: int, track: str = "") -> list[dict]:
    table = Document(path).tables[table_index]
    current_term = None
    lesson = 0
    records = []
    for row_index, row in enumerate(table.rows[1:], start=1):
        values = [clean(cell.text) for cell in row.cells]
        joined = " | ".join(values)
        found_term = term_number(joined)
        if found_term and sum(bool(value) for value in values) <= max(4, len(values)):
            current_term = found_term
            continue
        if found_term and all(not re.search(r"(?<!\d)(?:5|6|7|8|9|10|11)(?:\s*\.\s*\d+){3}(?!\d)", value) for value in values):
            current_term = found_term
            continue
        if current_term not in {1, 2, 3, 4}:
            continue

        if subject == "Құқық негіздері":
            section = values[0] if values else ""
            subsection = values[1] if len(values) > 1 else ""
            topic = values[2] if len(values) > 2 else ""
            objectives = values[3] if len(values) > 3 else ""
            hours = first_number(values[4:])
            if subsection and subsection != section:
                section = f"{section}. {subsection}"
        elif grade >= 10 and len(values) >= 6:
            section = values[0]
            subsection = values[1]
            topic = values[2]
            objectives = values[3]
            hours = first_number(values[4:])
            if subsection and subsection != section:
                section = f"{section}. {subsection}"
        else:
            section = values[0] if values else ""
            topic = values[1] if len(values) > 1 else ""
            objectives = values[2] if len(values) > 2 else ""
            hours = first_number(values[3:])

        codes = objective_codes(objectives)
        if not topic or not section or (not objectives and not codes):
            continue
        lesson += hours
        records.append({
            "id": make_id(path.name, table_index, row_index, subject, grade, track),
            "grade": grade,
            "subject": subject,
            "track": track,
            "term": current_term,
            "lesson_numbers": list(range(lesson - hours + 1, lesson + 1)),
            "section": section,
            "topic": topic,
            "objectives": objectives,
            "objective_codes": codes,
            "lesson_objectives": objectives,
            "values": "Тәуелсіздік және отаншылдық; әділдік және жауапкершілік; заң және тәртіп",
            "stages": [],
            "methodological_guidance": [
                "Тарихи деректі мазмұны, авторы, уақыты және мақсаты бойынша талдату.",
                "Оқиғаны себеп–салдар, өзгеріс–сабақтастық және тарихи маңыз тұрғысынан қарастыру.",
                "Қорытындыны нақты дерекпен негіздету."
            ],
            "quality_flags": ["teacher_history_ktp", "exact_topic", "exact_objectives", "four_terms", "textbook_binding_pending"],
            "source": {
                "status": "teacher-provided-history-ktz",
                "collection": "КТЖ ТАРИХ.rar",
                "file": path.name,
                "table": table_index,
                "row": row_index,
                "publisher_task_status": "Atamura textbook file not supplied"
            }
        })
    return records


def main(source_dir: Path) -> None:
    mappings = []
    for grade in range(5, 10):
        mappings.append((source_dir / f"k tarih ({grade - 4}).docx", 0, "Қазақстан тарихы", grade, ""))
        mappings.append((source_dir / "ДЖТ" / f"DJT ({grade - 4}).docx", 1, "Дүниежүзі тарихы", grade, ""))

    mappings += [
        (source_dir / "k tarih (7).docx", 1, "Қазақстан тарихы", 10, ""),
        (source_dir / "k tarih (8).docx", 1, "Қазақстан тарихы", 11, "ЖМБ"),
        (source_dir / "k tarih (9).docx", 1, "Қазақстан тарихы", 11, "ҚГБ"),
        (source_dir / "ДЖТ" / "DJT (6).docx", 1, "Дүниежүзі тарихы", 10, "ЖМБ"),
        (source_dir / "ДЖТ" / "DJT (7).docx", 1, "Дүниежүзі тарихы", 10, "ҚГБ"),
        (source_dir / "ДЖТ" / "DJT (8).docx", 1, "Дүниежүзі тарихы", 11, "ЖМБ"),
        (source_dir / "ДЖТ" / "DJT (9).docx", 1, "Дүниежүзі тарихы", 11, "ҚГБ"),
        (source_dir / "k tarih (6).docx", 0, "Құқық негіздері", 9, ""),
        (source_dir / "k tarih (6).docx", 1, "Құқық негіздері", 10, "ЖМБ"),
        (source_dir / "k tarih (6).docx", 2, "Құқық негіздері", 11, "ЖМБ"),
        (source_dir / "k tarih (6).docx", 3, "Құқық негіздері", 10, "ҚГБ"),
        (source_dir / "k tarih (6).docx", 4, "Құқық негіздері", 11, "ҚГБ"),
    ]

    imported = []
    for path, table, subject, grade, track in mappings:
        if not path.is_file():
            raise FileNotFoundError(path)
        imported.extend(parse_table(path, table, subject=subject, grade=grade, track=track))

    data = json.loads(DATABASE.read_text(encoding="utf-8"))
    data["records"] = [r for r in data.get("records", []) if r.get("source", {}).get("status") != "teacher-provided-history-ktz"] + imported
    data["record_count"] = len(data["records"])
    data["history_ktp_import"] = {
        "record_count": len(imported),
        "subjects": sorted({r["subject"] for r in imported}),
        "grades": sorted({r["grade"] for r in imported}),
        "terms": sorted({r["term"] for r in imported}),
        "textbook_task_status": "pending teacher-provided Atamura textbook files"
    }
    DATABASE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(data["history_ktp_import"], ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: import_history_ktp.py EXTRACTED_KTZ_DIR")
    main(Path(sys.argv[1]))
