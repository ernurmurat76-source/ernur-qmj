#!/usr/bin/env python3
"""Match term 2–4 prepared plans to the teacher's existing QMJ structure.

Structure: organization 5, beginning 10, middle 25, end 5 minutes.
Descriptors exist only under tasks in the 25-minute middle stage.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path


BOOKS = {
    (5, "Математика", 2): "Математика 5 класс 1 бөлім.pdf",
    (5, "Математика", 3): "Математика 5 класс 2 бөлім.pdf",
    (5, "Математика", 4): "Математика 5 класс 2 бөлім.pdf",
    (6, "Математика", 2): "6 сынып 1 бөлім.pdf",
    (6, "Математика", 3): "Математика 6 сынып 2 бөлім.pdf",
    (6, "Математика", 4): "Математика 6 сынып 2 бөлім.pdf",
    (7, "Алгебра", 2): "Математика 7 сынып.pdf", (7, "Алгебра", 3): "Математика 7 сынып.pdf", (7, "Алгебра", 4): "Математика 7 сынып.pdf",
    (7, "Геометрия", 2): "Геометрия 7 сынып.pdf", (7, "Геометрия", 3): "Геометрия 7 сынып.pdf", (7, "Геометрия", 4): "Геометрия 7 сынып.pdf",
    (8, "Алгебра", 2): "Математика 8 класс.pdf", (8, "Алгебра", 3): "Математика 8 класс.pdf", (8, "Алгебра", 4): "Математика 8 класс.pdf",
    (8, "Геометрия", 2): "Геометрия 8 РШ 2018 (не для печати).epub", (8, "Геометрия", 3): "Геометрия 8 РШ 2018 (не для печати).epub", (8, "Геометрия", 4): "Геометрия 8 РШ 2018 (не для печати).epub",
    (9, "Алгебра", 2): "математика 9 класс.pdf", (9, "Алгебра", 3): "математика 9 класс.pdf", (9, "Алгебра", 4): "математика 9 класс.pdf",
    (9, "Геометрия", 2): "Геометрия 9 сынып.pdf", (9, "Геометрия", 3): "Геометрия 9 сынып.pdf", (9, "Геометрия", 4): "Геометрия 9 сынып.pdf",
    (10, "Алгебра", 2): "Алгебра 10 сынып.pdf", (10, "Алгебра", 3): "Алгебра 10 сынып.pdf", (10, "Алгебра", 4): "Алгебра 10 сынып.pdf",
    (10, "Геометрия", 2): "Геометрия 10 сынып.pdf", (10, "Геометрия", 3): "Геометрия 10 сынып.pdf", (10, "Геометрия", 4): "Геометрия 10 сынып.pdf",
    (11, "Алгебра", 2): "Алгебра 11 сынып орыс 1 бөлім.pdf",
    (11, "Алгебра", 3): "Алгебра 11 сынып орыс 2 бөлім.pdf", (11, "Алгебра", 4): "Алгебра 11 сынып орыс 2 бөлім.pdf",
    (11, "Геометрия", 2): "Геометрия 11 сынып.pdf", (11, "Геометрия", 3): "Геометрия 11 сынып.pdf", (11, "Геометрия", 4): "Геометрия 11 сынып.pdf",
}

PAGES = {
    "6 сынып 1 бөлім.pdf": 208, "Алгебра 11 сынып орыс 2 бөлім.pdf": 149,
    "математика 9 класс.pdf": 224, "Геометрия 11 сынып.pdf": 198,
    "Математика 6 сынып 2 бөлім.pdf": 224, "Геометрия 7 сынып.pdf": 80,
    "Математика 5 класс 1 бөлім.pdf": 224, "Геометрия 9 сынып.pdf": 176,
    "Математика 5 класс 2 бөлім.pdf": 192, "Алгебра 11 сынып орыс 1 бөлім.pdf": 198,
    "Математика 8 класс.pdf": 208, "Математика 7 сынып.pdf": 208,
    "Геометрия 10 сынып.pdf": 112, "Алгебра 10 сынып.pdf": 272,
    "Геометрия 8 РШ 2018 (не для печати).epub": 112,
}


def page_span(record: dict) -> tuple[float, float]:
    grade, term = record["grade"], record["term"]
    if grade in {5, 6} or (grade == 11 and record["subject"] == "Алгебра"):
        return {2: (0.52, 0.94), 3: (0.06, 0.52), 4: (0.52, 0.94)}[term]
    return {2: (0.27, 0.50), 3: (0.50, 0.76), 4: (0.76, 0.94)}[term]


def strip_task_prefix(value: str) -> str:
    return re.sub(r"^\d+-тапсырм[^:]*:\s*", "", str(value or "")).strip()


def lesson_objective_text(value: str) -> str:
    text = re.sub(r"\b\d+(?:\.\d+){2,}\s*", "", str(value or ""))
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" ;.")
    return text[:1].upper() + text[1:] + "." if text else "Сабақ тапсырмаларын орындайды."


def task_text(value: str, prefix: str) -> str:
    return str(value or "").removeprefix(prefix).strip()


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "data/qmj-reference-index.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    groups = defaultdict(list)
    for record in data["records"]:
        if record.get("term") in {2, 3, 4} and record.get("source", {}).get("status") == "teacher-provided-ktz":
            groups[(record["grade"], record["subject"], record.get("track", ""), record["term"])].append(record)

    changed = 0
    pages_used = set()
    for group in groups.values():
        group.sort(key=lambda r: (r.get("source", {}).get("table", 0), r.get("source", {}).get("row", 0), r["id"]))
        for index, record in enumerate(group):
            plan = record.get("prepared_plan") or {}
            old = plan.get("stages") or []
            if len(old) < 3:
                continue
            book = BOOKS[(record["grade"], record["subject"], record["term"])]
            low, high = page_span(record)
            ratio = index / max(1, len(group) - 1)
            pdf_page = max(5, round(PAGES[book] * (low + (high - low) * ratio)))
            pages_used.add((book, pdf_page))
            middle_actions = old[1].get("teacherActions") or []
            while len(middle_actions) < 4:
                middle_actions.append("Оқу мақсатына сәйкес тақырыптық есепті орында.")
            tasks = [
                {"number": 1, "instruction": strip_task_prefix(middle_actions[0]), "descriptor": "есептің берілгендері мен ізделіндісін анықтайды және алғашқы қадамды түсіндіреді", "points": 1},
                {"number": 2, "instruction": strip_task_prefix(middle_actions[1]), "descriptor": "тақырыпқа сәйкес қасиет, формула немесе алгоритмді дұрыс қолданып, жауабын тексереді", "points": 2},
                {"number": 3, "instruction": strip_task_prefix(middle_actions[2]), "descriptor": "мәтіндік есептің моделін құрып, шешу жолы мен жауабының мағынасын түсіндіреді", "points": 2},
                {"number": 4, "instruction": strip_task_prefix(middle_actions[3]), "descriptor": "қатенің орнын және себебін анықтап, дұрыс шешімді жазады", "points": 1},
            ]
            plan.pop("assessmentCriteria", None)
            beginning_task = task_text(
                (old[0].get("teacherActions") or [""])[0],
                "Алдыңғы білімді белсендіретін сұрақ береді: ",
            )
            ending_task = task_text(
                (old[2].get("teacherActions") or [""])[0],
                "Қорытынды тапсырма береді: ",
            )
            plan["lessonObjectives"] = [
                lesson_objective_text(record.get("objectives", "")),
                "Шешу тәсілін математикалық тілде түсіндіріп, нәтижесін тексереді және қатесін түзетеді.",
            ]
            plan["stages"] = [
                {
                    "name": "Ұйымдастыру кезеңі", "minutes": 5, "method": "Сабаққа дайындық", "workForm": "Бүкіл сыныппен жұмыс",
                    "teacherActions": ["Сәлемдесу.", "Сыныптағы оқушылардың көңіл күйлерін сұрап, жағымды ахуал туындату.", "Оқушыларды түгелдеу.", "Сабақтың мақсатымен таныстыру."],
                    "learnerActions": ["Сабаққа қажетті оқу құралдарын дайындайды.", "Сабақтың тақырыбы мен мақсатын қабылдайды."],
                    "descriptors": [], "feedback": "Ауызша бағалау: «Өте жақсы», «Жарайсың».", "resources": ["Тақта", "Оқу құралдары"], "support": "",
                },
                {
                    "name": "Сабақтың басы", "minutes": 10, "method": "Алдыңғы білімді еске түсіру", "workForm": "Жеке және бүкіл сыныппен жұмыс",
                    "teacherActions": ["Алдыңғы білімді анықтайтын қысқа тапсырма береді."], "learnerActions": old[0].get("learnerActions") or [],
                    "tasks": [{"number": 1, "instruction": beginning_task, "descriptor": "алдыңғы білімге сүйеніп, тапсырманың дұрыс жауабын жазады және түсіндіреді", "points": 1}],
                    "descriptors": [], "feedback": "Сұрақ–жауап және қысқа ауызша кері байланыс арқылы алдыңғы білім нақтыланады.",
                    "resources": old[0].get("resources") or ["Тақта"], "support": old[0].get("support", ""),
                },
                {
                    "name": "Сабақтың ортасы", "minutes": 25, "method": old[1].get("method", "Оқулықпен жұмыс"), "workForm": "Жеке және жұптық жұмыс",
                    "teacherActions": ["Оқулықтағы тапсырмаларды ретімен ұсынады, орындалуын бақылайды және қажет кезде бағыттаушы сұрақ береді."],
                    "learnerActions": old[1].get("learnerActions") or [], "tasks": tasks, "descriptors": [],
                    "feedback": "Әр тапсырмадан кейін дескрипторға сүйенген нақты кері байланыс беріледі; оқушы қатесін сол кезеңде түзетеді.",
                    "resources": ["Оқулық", "Тақта", "Оқу құралдары"] + (["Тақырыптық сызба"] if plan.get("visuals") else []),
                    "support": old[1].get("support", ""), "visuals": plan.get("visuals") or [],
                },
                {
                    "name": "Сабақтың соңы", "minutes": 5, "method": "Қорытындылау және рефлексия", "workForm": "Жеке жұмыс",
                    "teacherActions": ["Сабақты қорытындылайтын тапсырма береді.", "ББҮ кестесі арқылы сабақ нәтижесін қорытындылауды ұйымдастырады."],
                    "learnerActions": (old[2].get("learnerActions") or []) + ["ББҮ кестесін толтырады: «Білемін», «Білгім келеді», «Үйрендім»."],
                    "tasks": [{"number": 1, "instruction": ending_task, "descriptor": "қорытынды тапсырманы өздігінен орындайды және жауабын түсіндіреді", "points": 1}],
                    "descriptors": [], "feedback": "Мұғалім жауаптарды қысқаша қорытындылап, келесі оқу қадамын белгілейді.",
                    "resources": ["ББҮ кестесі", "Рефлексия парағы"], "support": "",
                },
            ]
            plan["templateStatus"] = "teacher-provided-qmj-structure"
            plan["textbookPageBinding"] = {"publisher": "Атамұра", "file": book, "pdfPage": pdf_page}
            plan["sourceNote"] = (
                "Тақырып пен оқу мақсаты КТЖ-дан сақталды; оқулықтың бағдарлық PDF беті "
                "бөлімнің оқу ретімен байланыстырылды, ал тапсырма мәтіні оқу мақсатына сай "
                "жаңадан құрастырылды."
            )
            record["prepared_plan"] = plan
            flags = [flag for flag in record.get("quality_flags", []) if flag != "descriptors_middle_only"]
            record["quality_flags"] = list(dict.fromkeys(flags + ["teacher_template_5_10_25_5", "descriptors_follow_tasks", "atamura_pdf_page_bound"]))
            changed += 1

    data["version"] = "17-fixed-stages-bbu"
    data["prepared_plan_count"] = changed
    data["template_policy"] = "teacher QMJ structure: 5+10+25+5; descriptors directly under every learning task"
    data["textbook_page_binding_count"] = changed
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"changed": changed, "unique_book_pages": len(pages_used)}, ensure_ascii=False))
    return 0 if changed else 1


if __name__ == "__main__":
    raise SystemExit(main())
