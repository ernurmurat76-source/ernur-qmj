#!/usr/bin/env python3
"""OCR scanned Atamura books and attach one real exercise to each prepared QMJ.

The script is intentionally conservative.  It never rebuilds a lesson plan and
does not touch timing, actions, descriptors, points, values or Word layout.  It
only replaces the first middle-stage task instruction when that plan does not
already contain an exact textbook exercise, then attaches the matching crop.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import fitz
from PIL import Image, ImageEnhance, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA = ROOT / "data" / "qmj-reference-index.json"
DEFAULT_BOOKS = ROOT.parent / "textbook_extract" / "Гео-Математика Атамұра"
DEFAULT_IMAGES = ROOT / "public" / "textbook-excerpts"
DEFAULT_CACHE = ROOT / ".ocr-cache"

LETTER = r"A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІіЁё"
EXERCISE_START = re.compile(
    rf"(?m)^\s*(?:№\s*)?((?:\d{{1,2}}\.)?\d{{1,4}})\s*([.)])\s+(?=[{LETTER}\d(\[{{])"
)
NUMBER_TOKEN = re.compile(r"^(?:№)?((?:\d{1,2}\.)?\d{1,4})[.)]?$", re.I)
WATERMARK = re.compile(
    r"(?:Все учебники Казахстана|OKULYK\.KZ|Книга предоставлена|"
    r"исключительно в образовательных целях|Приказа Министра|Не для печати)",
    re.I,
)
STOPWORDS = {
    "және", "үшін", "арқылы", "бойынша", "табу", "есептер", "есеп", "сабақ",
    "қасиеттері", "формуласы", "түрлері", "ұғымы", "анықтамасы", "әдістері",
    "оның", "олардың", "мен", "или", "для", "при", "его", "ее", "это",
    "решение", "задачи", "методы", "формула", "свойства", "понятие",
}
VERBS = (
    "табыңдар", "есептеңдер", "орындаңдар", "шығарыңдар", "салыстырыңдар",
    "дәлелдеңдер", "құрыңдар", "анықтаңдар", "жазыңдар", "шешіңдер",
    "найдите", "вычислите", "решите", "выполните", "сравните", "докажите",
    "постройте", "определите", "запишите", "упростите", "сколько", "қанша",
)


@dataclass(frozen=True)
class Exercise:
    page_index: int
    number: str
    text: str


def clean_ocr(text: str) -> str:
    text = text.replace("\x0c", "\n")
    lines: list[str] = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not line or WATERMARK.search(line):
            continue
        if re.fullmatch(r"\d{1,3}", line):
            continue
        lines.append(line)
    joined = "\n".join(lines)
    joined = re.sub(r"(?<=[%s])-\n(?=[%s])" % (LETTER, LETTER), "", joined)
    joined = re.sub(r"[ \t]+", " ", joined)
    return joined.strip()


def words(value: str) -> list[str]:
    value = value.lower()
    # Curriculum wording and the supplied editions sometimes use equivalent
    # Kazakh/Russian loan terms or omit Kazakh keyboard letters.
    value = value.replace("пайызы", "проценті").replace("пайызын", "процентін")
    value = value.replace("пайыз", "процент").replace("косу", "қосу")
    return [
        word.lower() for word in re.findall(rf"[{LETTER}]{{4,}}", value)
        if word.lower() not in STOPWORDS
    ]


def page_score(text: str, topic: str, page: int, hint: int) -> float:
    page_words = words(text)
    if not page_words:
        return -999.0
    topic_words = words(topic)
    score = 0.0
    for token in topic_words:
        if token in page_words:
            score += 16 + min(8, len(token) / 2)
            continue
        ratio = max((SequenceMatcher(None, token, candidate).ratio() for candidate in page_words), default=0)
        if ratio >= 0.82:
            score += 8 * ratio
    normalized_topic = " ".join(topic_words)
    normalized_page = " ".join(page_words)
    if normalized_topic and normalized_topic in normalized_page:
        score += 60
    if "мазмұны" in normalized_page or "содержание" in normalized_page:
        score -= 45
    score -= abs(page - hint) * 0.075
    return score


def heading_score(text: str, topic: str, page: int, hint: int) -> float:
    """Score short heading-like lines, not a later summary or answer key."""
    lowered_page = text.lower()
    if "мазмұны" in lowered_page or "содержание" in lowered_page:
        return -999.0
    topic_words = words(topic)
    best = -999.0
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not 5 <= len(line) <= 180:
            continue
        line_words = words(line)
        if not line_words:
            continue
        hits = 0.0
        for token in topic_words:
            if token in line_words:
                hits += 1.0
            else:
                ratio = max((SequenceMatcher(None, token, candidate).ratio() for candidate in line_words), default=0)
                if ratio >= 0.78:
                    hits += ratio * 0.72
        coverage = hits / max(1, len(topic_words))
        if coverage < 0.28:
            continue
        score = coverage * 100 + hits * 7
        if re.match(r"^\d{1,2}(?:\.\d{1,2})+\.?\s", line):
            score += 35
        if line.endswith(".") or line.endswith(":"):
            score += 3
        score -= abs(page - hint) * 0.02
        best = max(best, score)
    return best


def split_exercises(text: str, page_index: int) -> list[Exercise]:
    text = clean_ocr(text)
    matches = list(EXERCISE_START.finditer(text))
    result: list[Exercise] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        block = text[match.start():end]
        block = re.sub(r"\s*\n\s*", " ", block)
        block = re.sub(r"\s+([,.;:!?])", r"\1", block)
        block = re.sub(r"\s+", " ", block).strip()
        if len(block) > 1400:
            block = block[:1400].rsplit(" ", 1)[0] + "…"
        lower = block.lower()
        early = lower[:220]
        if match.group(2) == ")" and "." not in match.group(1) and int(match.group(1)) < 20:
            continue
        # Chapter headings such as "3.1. Жай бөлшектер" may contain an
        # imperative much later on the page.  Do not mistake such a heading
        # and its whole theory block for a numbered exercise.
        if "." in match.group(1) and not any(verb in early for verb in VERBS):
            continue
        useful = any(verb in lower for verb in VERBS) or bool(re.search(r"[=+−–×·:/]|\d", block[5:]))
        if 18 <= len(block) <= 1401 and useful:
            result.append(Exercise(page_index, match.group(1), block))
    return result


def exercise_topic_score(exercise: Exercise, topic: str) -> float:
    task_words = words(exercise.text)
    if not task_words:
        return 0.0
    score = 0.0
    for token in words(topic):
        if token in task_words:
            score += 2.0
            continue
        ratio = max((SequenceMatcher(None, token, candidate).ratio() for candidate in task_words), default=0)
        if ratio >= 0.8:
            score += ratio
    return score


def epub_image_names(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if re.search(r"\.(?:png|jpe?g|webp)$", name, re.I)]
    def key(name: str) -> tuple[int, str]:
        nums = re.findall(r"\d+", Path(name).stem)
        return (int(nums[-1]) if nums else 10**9, name)
    return sorted(names, key=key)


def page_count(path: Path) -> int:
    if path.suffix.lower() == ".epub":
        return len(epub_image_names(path))
    with fitz.open(path) as document:
        return document.page_count


def render_page(path: Path, page_index: int, dpi: int, epub_names: list[str] | None = None) -> Image.Image:
    if path.suffix.lower() == ".epub":
        names = epub_names or epub_image_names(path)
        with zipfile.ZipFile(path) as archive:
            image = Image.open(io.BytesIO(archive.read(names[page_index]))).convert("RGB")
        if image.width < 1200:
            ratio = 1200 / image.width
            image = image.resize((1200, round(image.height * ratio)), Image.Resampling.LANCZOS)
        return image
    with fitz.open(path) as document:
        page = document.load_page(page_index)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
        return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def prepare_for_ocr(image: Image.Image) -> Image.Image:
    gray = ImageOps.grayscale(image)
    gray = ImageEnhance.Contrast(gray).enhance(1.25)
    return gray


def run_tesseract(
    image: Image.Image, tessdata: Path, output_format: str = "txt", timeout: int = 45, psm: int = 3,
) -> str:
    buffer = io.BytesIO()
    prepare_for_ocr(image).save(buffer, "PNG", optimize=True)
    command = [
        "tesseract", "stdin", "stdout", "-l", "kaz+rus", "--psm", str(psm),
        "--tessdata-dir", str(tessdata), "-c", "preserve_interword_spaces=1",
    ]
    if output_format == "tsv":
        # The uploaded tessdata directory contains language models only, not
        # Tesseract's optional config files.  Enable TSV directly so this also
        # works with a self-contained model directory.
        command.extend(["-c", "tessedit_create_tsv=1"])
    elif output_format != "txt":
        command.append(output_format)
    environment = dict(os.environ)
    environment["OMP_THREAD_LIMIT"] = "1"
    result = subprocess.run(
        command, input=buffer.getvalue(), capture_output=True, timeout=timeout, env=environment,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[:500])
    return result.stdout.decode("utf-8", errors="replace")


def cache_file(cache_dir: Path, book: str, page_index: int) -> Path:
    digest = hashlib.sha256(book.encode("utf-8")).hexdigest()[:16]
    return cache_dir / digest / f"{page_index + 1:04d}.txt"


def task_cache_file(cache_dir: Path, book: str, page_index: int) -> Path:
    digest = hashlib.sha256(book.encode("utf-8")).hexdigest()[:16]
    return cache_dir / digest / "tasks-psm6-v2" / f"{page_index + 1:04d}.txt"


def task_tsv_file(cache_dir: Path, book: str, page_index: int) -> Path:
    return task_cache_file(cache_dir, book, page_index).with_suffix(".tsv")


def ocr_one(path: Path, book: str, page_index: int, tessdata: Path, cache_dir: Path, epub_names: list[str] | None) -> tuple[int, str]:
    cached = cache_file(cache_dir, book, page_index)
    if cached.is_file():
        return page_index, cached.read_text(encoding="utf-8")
    image = render_page(path, page_index, 180, epub_names)
    text = clean_ocr(run_tesseract(image, tessdata))
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(text, encoding="utf-8")
    return page_index, text


def ocr_range(path: Path, book: str, indices: list[int], tessdata: Path, cache_dir: Path, workers: int) -> dict[int, str]:
    epub_names = epub_image_names(path) if path.suffix.lower() == ".epub" else None
    output: dict[int, str] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(ocr_one, path, book, index, tessdata, cache_dir, epub_names): index
            for index in indices
        }
        completed = 0
        for future in as_completed(futures):
            index, text = future.result()
            output[index] = text
            completed += 1
            if completed % 25 == 0 or completed == len(indices):
                print(f"OCR {book}: {completed}/{len(indices)}", flush=True)
    return output


def ocr_task_page(path: Path, book: str, page_index: int, tessdata: Path, cache_dir: Path) -> str:
    cached = task_cache_file(cache_dir, book, page_index)
    cached_tsv = task_tsv_file(cache_dir, book, page_index)
    if cached.is_file() and cached_tsv.is_file():
        return cached.read_text(encoding="utf-8")
    epub_names = epub_image_names(path) if path.suffix.lower() == ".epub" else None
    image = render_page(path, page_index, 240, epub_names)
    try:
        tsv = run_tesseract(image, tessdata, output_format="tsv", psm=6, timeout=75)
    except (RuntimeError, subprocess.TimeoutExpired):
        # Some diagram-heavy scans need less memory.  A 180 dpi retry remains
        # readable while preventing a single page from aborting the full run.
        image = render_page(path, page_index, 180, epub_names)
        tsv = run_tesseract(image, tessdata, output_format="tsv", psm=6, timeout=120)
    text = clean_ocr(tsv_to_text(tsv))
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(text, encoding="utf-8")
    cached_tsv.write_text(tsv, encoding="utf-8")
    return text


def ocr_task_range(
    path: Path, book: str, indices: list[int], tessdata: Path, cache_dir: Path, workers: int,
) -> dict[int, str]:
    output: dict[int, str] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(ocr_task_page, path, book, index, tessdata, cache_dir): index
            for index in indices
        }
        completed = 0
        for future in as_completed(futures):
            index = futures[future]
            output[index] = future.result()
            completed += 1
            if completed % 20 == 0 or completed == len(indices):
                print(f"TASK OCR {book}: {completed}/{len(indices)}", flush=True)
    return output


def tsv_rows(tsv: str) -> list[dict[str, int | str]]:
    rows: list[dict[str, int | str]] = []
    lines = tsv.splitlines()
    if not lines:
        return rows
    header = lines[0].split("\t")
    for line in lines[1:]:
        values = line.split("\t")
        if len(values) != len(header):
            continue
        row = dict(zip(header, values))
        try:
            rows.append({
                "text": row.get("text", "").strip(), "left": int(row["left"]),
                "top": int(row["top"]), "width": int(row["width"]), "height": int(row["height"]),
                "block": int(row.get("block_num", 0)), "paragraph": int(row.get("par_num", 0)),
                "line": int(row.get("line_num", 0)), "word": int(row.get("word_num", 0)),
            })
        except (KeyError, ValueError):
            continue
    return rows


def tsv_to_text(tsv: str) -> str:
    lines: dict[tuple[int, int, int], list[tuple[int, str]]] = defaultdict(list)
    for row in tsv_rows(tsv):
        value = str(row["text"]).strip()
        if value:
            key = (int(row["block"]), int(row["paragraph"]), int(row["line"]))
            lines[key].append((int(row["word"]), value))
    return "\n".join(" ".join(value for _, value in sorted(items)) for _, items in sorted(lines.items()))


def crop_exercise(
    path: Path, book: str, exercise: Exercise, tessdata: Path, cache_dir: Path, destination: Path,
) -> str:
    key = f"{path.name}\0{exercise.page_index + 1}\0{exercise.number}"
    filename = f"task-{hashlib.sha256(key.encode('utf-8')).hexdigest()[:20]}.jpg"
    output = destination / filename
    if output.is_file():
        return filename
    epub_names = epub_image_names(path) if path.suffix.lower() == ".epub" else None
    image = render_page(path, exercise.page_index, 240, epub_names)
    cached_tsv = task_tsv_file(cache_dir, book, exercise.page_index)
    if cached_tsv.is_file():
        tsv = cached_tsv.read_text(encoding="utf-8")
    else:
        tsv = run_tesseract(image, tessdata, "tsv", timeout=75, psm=6)
        cached_tsv.parent.mkdir(parents=True, exist_ok=True)
        cached_tsv.write_text(tsv, encoding="utf-8")
    rows = tsv_rows(tsv)
    matches = []
    for row in rows:
        match = NUMBER_TOKEN.match(str(row["text"]).replace(",", "."))
        if match and match.group(1) == exercise.number:
            matches.append(row)
    if matches:
        anchor = min(matches, key=lambda row: int(row["top"]))
        y0 = max(0, int(anchor["top"]) - 28)
        next_tops = []
        main_is_decimal = "." in exercise.number
        main_integer = int(exercise.number) if not main_is_decimal else 0
        for row in rows:
            raw = str(row["text"]).replace(",", ".")
            match = NUMBER_TOKEN.match(raw)
            if not match or int(row["top"]) <= y0 + 70:
                continue
            candidate = match.group(1)
            if main_is_decimal and "." not in candidate:
                continue
            if not main_is_decimal and main_integer >= 20:
                if "." in candidate or int(candidate) < 20:
                    continue
            next_tops.append(int(row["top"]))
        y1 = min(next_tops) - 18 if next_tops else y0 + round(image.height * 0.30)
        y1 = min(image.height, max(y0 + 220, y1))
    else:
        y0, y1 = round(image.height * 0.22), round(image.height * 0.58)
    x0, x1 = round(image.width * 0.055), round(image.width * 0.945)
    crop = image.crop((x0, y0, x1, y1)).convert("RGB")
    if crop.width > 1200:
        ratio = 1200 / crop.width
        crop = crop.resize((1200, round(crop.height * ratio)), Image.Resampling.LANCZOS)
    crop = ImageEnhance.Contrast(crop).enhance(1.06)
    destination.mkdir(parents=True, exist_ok=True)
    crop.save(output, "JPEG", quality=88, optimize=True, progressive=True, subsampling=1)
    return filename


def middle_stage(plan: dict) -> dict | None:
    return next((stage for stage in plan.get("stages", []) if stage.get("name") == "Сабақтың ортасы"), None)


def choose_topic_page(page_texts: dict[int, str], topic: str, hints: list[int]) -> int:
    hint = min(hints)
    if "жиынтық бағалау" in topic.lower():
        return min(page_texts, key=lambda page: abs((page + 1) - max(hints)))
    # The old binding is only a coarse term-order hint.  Search the complete
    # OCR range so a chapter offset cannot force the wrong subsection.
    candidates = range(min(page_texts), max(page_texts) + 1)
    heading_scores = {
        page: heading_score(page_texts.get(page, ""), topic, page + 1, hint)
        for page in candidates
    }
    best_heading = max(heading_scores, key=heading_scores.get)
    if heading_scores[best_heading] > 20:
        return best_heading
    page_scores = {
        page: page_score(page_texts.get(page, ""), topic, page + 1, hint)
        for page in candidates
    }
    best_page = max(page_scores, key=page_scores.get)
    if page_scores[best_page] <= 0:
        return min(page_texts, key=lambda page: abs((page + 1) - hint))
    return best_page


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--books", type=Path, default=DEFAULT_BOOKS)
    parser.add_argument("--tessdata", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--images", type=Path, default=DEFAULT_IMAGES)
    parser.add_argument("--workers", type=int, default=min(6, os.cpu_count() or 2))
    parser.add_argument("--book", action="append", help="Process only this source filename; may be repeated")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    for language in ("kaz.traineddata", "rus.traineddata"):
        if not (args.tessdata / language).is_file():
            parser.error(f"missing OCR model: {args.tessdata / language}")

    data = json.loads(args.data.read_text(encoding="utf-8"))
    by_book: dict[str, list[dict]] = defaultdict(list)
    for record in data.get("records", []):
        if record.get("term") not in {2, 3, 4}:
            continue
        plan = record.get("prepared_plan") or {}
        if (plan.get("textbookExercise") or {}).get("mode") == "exact-pdf-text":
            continue
        binding = plan.get("textbookPageBinding") or {}
        book = str(binding.get("file") or "")
        if book and (not args.book or book in args.book):
            by_book[book].append(record)

    changed = 0
    report: dict[str, dict[str, int]] = {}
    for book, records in sorted(by_book.items()):
        source = args.books / book
        if not source.is_file():
            raise FileNotFoundError(source)
        count = page_count(source)
        hints = [int((record["prepared_plan"].get("textbookPageBinding") or {}).get("pdfPage") or 1) for record in records]
        low = max(0, min(hints) - 13)
        high = min(count - 1, max(hints) + 9)
        page_texts = ocr_range(source, book, list(range(low, high + 1)), args.tessdata, args.cache, args.workers)

        topic_records: dict[str, list[dict]] = defaultdict(list)
        for record in records:
            topic_records[str(record.get("topic") or "Сабақ")].append(record)

        topic_windows: dict[str, tuple[int, int]] = {}
        task_indices: set[int] = set()
        for topic, items in topic_records.items():
            topic_hints = [int((item["prepared_plan"].get("textbookPageBinding") or {}).get("pdfPage") or 1) for item in items]
            topic_page = choose_topic_page(page_texts, topic, topic_hints)
            search_low = max(low, topic_page)
            hinted_end = min(max(topic_hints) + 3, topic_page + 12)
            search_high = min(high, max(topic_page + 6, hinted_end))
            topic_windows[topic] = (search_low, search_high)
            task_indices.update(range(search_low, search_high + 1))
        task_texts = ocr_task_range(
            source, book, sorted(task_indices), args.tessdata, args.cache, args.workers,
        )

        selected_for_book = 0
        for topic, items in topic_records.items():
            items.sort(key=lambda record: (
                int((record["prepared_plan"].get("textbookPageBinding") or {}).get("pdfPage") or 1),
                str(record.get("id") or ""),
            ))
            search_low, search_high = topic_windows[topic]
            exercises: list[Exercise] = []
            seen: set[tuple[int, str]] = set()
            for page_index in range(search_low, search_high + 1):
                task_text = task_texts.get(page_index, "")
                for exercise in split_exercises(task_text, page_index):
                    marker = (exercise.page_index, exercise.number)
                    if marker not in seen:
                        exercises.append(exercise)
                        seen.add(marker)
            # In school textbooks a large integer is the exercise number,
            # while 1., 2., 3. inside the theory block are usually questions
            # or solution steps.  Prefer the printed exercise sequence when
            # it is present in the selected topic pages.
            numbered = [
                exercise for exercise in exercises
                if "." not in exercise.number and int(exercise.number) >= 20
            ]
            if numbered:
                exercises = numbered
            if exercises:
                scored = [(exercise_topic_score(exercise, topic), exercise) for exercise in exercises]
                maximum = max(score for score, _ in scored)
                relevant = [
                    exercise for score, exercise in scored
                    if score >= max(2.0, maximum * 0.38)
                ]
                if relevant:
                    exercises = relevant
            if not exercises:
                continue
            for index, record in enumerate(items):
                chosen = [exercises[(index * 5 + offset) % len(exercises)] for offset in range(5)]
                exercise = chosen[0]
                plan = record["prepared_plan"]
                stage = middle_stage(plan)
                if not stage or not stage.get("tasks"):
                    continue
                selected = []
                for selected_exercise in chosen:
                    filename = crop_exercise(source, book, selected_exercise, args.tessdata, args.cache, args.images)
                    visual = {
                        "src": f"/textbook-excerpts/{filename}",
                        "alt": f"№{selected_exercise.number} есептің кітаптағы нұсқасы",
                        "caption": f"№{selected_exercise.number} есеп",
                        "kind": "textbook-excerpt",
                    }
                    selected.append({
                        "number": selected_exercise.number,
                        "text": selected_exercise.text,
                        "pdfPage": selected_exercise.page_index + 1,
                        "mode": "exact-scanned-ocr",
                        "visual": visual,
                    })
                # These are the only visible QMJ fields deliberately changed.
                stage["tasks"][0]["instruction"] = exercise.text
                stage["visuals"] = [selected[0]["visual"]]
                plan["visuals"] = [selected[0]["visual"]]
                plan["textbookExercise"] = {
                    "number": exercise.number,
                    "text": exercise.text,
                    "pdfPage": exercise.page_index + 1,
                    "mode": "exact-scanned-ocr",
                }
                plan["textbookExercises"] = selected
                plan["textbookPageBinding"]["pdfPage"] = exercise.page_index + 1
                flags = record.get("quality_flags") or []
                record["quality_flags"] = list(dict.fromkeys(flags + [
                    "textbook_exercise_text_ocr", "textbook_exercise_image_matched",
                ]))
                changed += 1
                selected_for_book += 1
        report[book] = {"records": len(records), "updated": selected_for_book, "pages_ocr": len(page_texts)}

    if not args.dry_run:
        data["version"] = "27-scanned-textbook-ocr"
        data["ocr_textbook_exercise_count"] = sum(
            (record.get("prepared_plan") or {}).get("textbookExercise", {}).get("mode") == "exact-scanned-ocr"
            for record in data.get("records", [])
        )
        data["exact_textbook_exercise_count"] = sum(
            (record.get("prepared_plan") or {}).get("textbookExercise", {}).get("mode") in {"exact-pdf-text", "exact-scanned-ocr"}
            for record in data.get("records", [])
        )
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.data.parent, delete=False) as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            temporary = Path(handle.name)
        temporary.replace(args.data)

    print(json.dumps({"changed": changed, "books": report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
