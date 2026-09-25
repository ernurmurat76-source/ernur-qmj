#!/usr/bin/env python3
"""Embed exact numbered exercises from machine-readable Atamura pages."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import fitz
from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
BOOK_DIR = ROOT.parent / "textbook_extract" / "Гео-Математика Атамұра"
IMAGE_DIR = ROOT / "public" / "textbook-excerpts"
WATERMARK = re.compile(
    r"(?:Не для печати|Все учебники Казахстана на OKULYK\.KZ|"
    r"\*Книга предоставлена исключительно.*|согласно Приказа Министра.*|"
    r"от 17 мая 2019 года № 217)", re.I
)
START = re.compile(r"(?<![\d.,])((?:\d{1,2}\.)?\d{2,4})\.\s+(?=\S)")
VERBS = (
    "табыңдар", "есептеңдер", "орындаңдар", "шығарыңдар", "салыстырыңдар",
    "дәлелдеңдер", "құрыңдар", "анықтаңдар", "жазыңдар", "шешіңдер",
    "найдите", "вычислите", "решите", "выполните", "сравните", "докажите",
    "постройте", "определите", "запишите", "упростите", "неше", "қанша",
    "қандай", "қалай", "как", "какова", "каков", "сколько",
)
STOPWORDS = {
    "және", "үшін", "арқылы", "табу", "сандар", "санды", "санның", "мәнін",
    "оның", "қасиеттері", "есептер", "тақырыбы", "бойынша", "the", "and",
    "для", "при", "или", "его", "ее", "значение", "числа",
}


def compact(text: str) -> str:
    lines = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not line or WATERMARK.search(line):
            continue
        if line in {"Н", "Не", "Не д", "Не дл", "Не для", "и", "ти", "ати", "чати", "ечати", "печати"}:
            continue
        if re.fullmatch(r"\d{1,3}", line):
            continue
        lines.append(line)
    text = " ".join(lines)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def topic_tokens(topic: str) -> list[str]:
    words = re.findall(r"[A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІіЁё]{4,}", topic.lower())
    return [word for word in words if word not in STOPWORDS]


def readable_pages(document: fitz.Document) -> list[str]:
    return [compact(page.get_text("text")) for page in document]


def is_machine_readable(pages: list[str]) -> bool:
    rich = sum(len(re.findall(r"[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]", page)) > 350 for page in pages)
    return rich >= max(5, len(pages) // 3)


def locate_topic(pages: list[str], topic: str, hint: int) -> int | None:
    tokens = topic_tokens(topic)
    exact = re.sub(r"\s+", " ", topic.lower()).strip()
    best = (float("-inf"), min(max(hint - 1, 0), len(pages) - 1))
    for index, page in enumerate(pages):
        lower = page.lower()
        hits = sum(1 for token in tokens if token in lower)
        if not hits:
            continue
        score = hits * 20
        if exact and exact in lower:
            score += 80
        if any(word in lower for word in ("мысал", "пример", "тапсырма", "упражнен")):
            score += 12
        if "мазмұны" in lower or "содержание" in lower:
            score -= 60
        score -= abs((index + 1) - hint) * 0.04
        if score > best[0]:
            best = (score, index)
    return None if best[0] == float("-inf") else best[1]


def candidates(text: str) -> list[tuple[str, str]]:
    matches = list(START.finditer(text))
    result = []
    for pos, match in enumerate(matches):
        end = matches[pos + 1].start() if pos + 1 < len(matches) else len(text)
        block = re.sub(r"\s+", " ", text[match.start():end].strip())
        if len(block) > 1000:
            block = block[:1000].rsplit(" ", 1)[0] + "…"
        number = match.group(1)
        lower = block.lower()
        verb = any(word in lower for word in VERBS)
        mathematical = bool(re.search(r"[=+−–·:/]|\d", block))
        if 25 <= len(block) <= 1001 and mathematical and verb:
            result.append((number, block))
    return result


def topic_tail(page: str, topic: str) -> str:
    lower = page.lower()
    exact = re.sub(r"\s+", " ", topic.lower()).strip().rstrip(".")
    position = lower.find(exact)
    if position >= 0:
        return page[position + len(exact):]
    for anchor in sorted(topic_tokens(topic), key=len, reverse=True):
        position = lower.find(anchor)
        if position >= 0:
            return page[position:]
    return page


def choose_exercise(pages: list[str], topic_page: int, topic: str) -> tuple[int, str, str] | None:
    for index in range(topic_page, min(len(pages), topic_page + 5)):
        search_text = topic_tail(pages[index], topic) if index == topic_page else pages[index]
        found = candidates(search_text)
        if found:
            return index, found[0][0], found[0][1]
    return None


def crop_exercise(document: fitz.Document, page_index: int, number: str, key: str) -> str:
    page = document[page_index]
    rects = []
    for needle in (f"{number}.", number):
        rects = page.search_for(needle)
        if rects:
            break
    page_rect = page.rect
    if rects:
        y0 = max(page_rect.y0, rects[0].y0 - 18)
        y1 = min(page_rect.y1, y0 + page_rect.height * 0.38)
    else:
        y0, y1 = page_rect.y0 + page_rect.height * 0.34, page_rect.y0 + page_rect.height * 0.76
    clip = fitz.Rect(page_rect.x0 + page_rect.width * 0.055, y0, page_rect.x1 - page_rect.width * 0.055, y1)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), clip=clip, alpha=False)
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    if image.width > 1100:
        ratio = 1100 / image.width
        image = image.resize((1100, round(image.height * ratio)), Image.Resampling.LANCZOS)
    image = ImageEnhance.Contrast(image).enhance(1.04)
    filename = f"task-{hashlib.sha256(key.encode('utf-8')).hexdigest()[:20]}.jpg"
    image.save(IMAGE_DIR / filename, "JPEG", quality=85, optimize=True, progressive=True, subsampling=1)
    return filename


def middle_stage(plan: dict) -> dict | None:
    return next((stage for stage in plan.get("stages", []) if stage.get("name") == "Сабақтың ортасы"), None)


def main() -> int:
    data_path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "qmj-reference-index.json")
    book_dir = Path(sys.argv[2] if len(sys.argv) > 2 else BOOK_DIR)
    data = json.loads(data_path.read_text(encoding="utf-8"))
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    records_by_book: dict[str, list[dict]] = defaultdict(list)
    for record in data.get("records", []):
        if record.get("term") not in {2, 3, 4}:
            continue
        binding = (record.get("prepared_plan") or {}).get("textbookPageBinding") or {}
        if binding.get("file"):
            records_by_book[str(binding["file"])].append(record)
    changed = 0
    readable_books, skipped_books = [], []
    cache: dict[tuple[str, str], tuple[int, str, str] | None] = {}
    for book, records in records_by_book.items():
        path = book_dir / book
        if path.suffix.lower() != ".pdf" or not path.exists():
            skipped_books.append(book)
            continue
        with fitz.open(path) as document:
            pages = readable_pages(document)
            if not is_machine_readable(pages):
                skipped_books.append(book)
                continue
            readable_books.append(book)
            for record in records:
                plan = record.get("prepared_plan") or {}
                stage = middle_stage(plan)
                if not stage or not stage.get("tasks"):
                    continue
                topic = str(record.get("topic") or "").strip()
                hint = int((plan.get("textbookPageBinding") or {}).get("pdfPage") or 1)
                cache_key = (book, topic.lower())
                if cache_key not in cache:
                    page = locate_topic(pages, topic, hint)
                    cache[cache_key] = choose_exercise(pages, page, topic) if page is not None else None
                selected = cache[cache_key]
                if not selected:
                    continue
                page_index, number, block = selected
                filename = crop_exercise(document, page_index, number, f"{book}\0{page_index+1}\0{number}")
                visual = {"src": f"/textbook-excerpts/{filename}", "alt": f"№{number} есептің кітаптағы нұсқасы", "caption": f"№{number} есеп", "kind": "textbook-excerpt"}
                stage["tasks"][0].update({"instruction": block, "descriptor": "есептің шартын түсініп, тиісті ережені қолданып, толық шешу жолы мен жауабын жазады", "points": 2})
                stage["visuals"] = [visual]
                plan["visuals"] = [visual]
                plan["textbookExercise"] = {"number": number, "text": block, "pdfPage": page_index + 1, "mode": "exact-pdf-text"}
                plan["textbookPageBinding"]["pdfPage"] = page_index + 1
                record["quality_flags"] = list(dict.fromkeys((record.get("quality_flags") or []) + ["textbook_exercise_text_exact", "textbook_exercise_image_matched"]))
                changed += 1
    data["version"] = "25-exact-written-textbook-exercises"
    data["exact_textbook_exercise_count"] = changed
    data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"changed": changed, "readable_books": sorted(readable_books), "skipped_scanned_books": sorted(skipped_books)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
