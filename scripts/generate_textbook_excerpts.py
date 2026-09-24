#!/usr/bin/env python3
"""Create compact textbook exercise excerpts for every prepared term 2–4 plan.

The source books were supplied by the teacher.  The public filenames are
content hashes, so the QMJ never exposes a PDF filename or a PDF page label.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import fitz
from PIL import Image, ImageEnhance, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BOOK_DIR = ROOT.parent / "textbook_extract" / "Гео-Математика Атамұра"
OUTPUT_DIR = ROOT / "public" / "textbook-excerpts"


def safe_excerpt_name(book: str, page: int) -> str:
    digest = hashlib.sha256(f"{book}\0{page}".encode("utf-8")).hexdigest()[:20]
    return f"task-{digest}.jpg"


def snap_crop(image: Image.Image) -> Image.Image:
    """Remove page furniture while retaining the main task/formula region."""
    width, height = image.size
    left, right = round(width * 0.075), round(width * 0.925)
    top, bottom = round(height * 0.105), round(height * 0.895)
    cropped = image.crop((left, top, right, bottom))

    # Trim only near-white outer bands; keep diagrams, colored boxes and rules.
    gray = ImageOps.grayscale(cropped)
    inverted = ImageOps.invert(gray)
    bbox = inverted.point(lambda value: 255 if value > 18 else 0).getbbox()
    if bbox:
        x0, y0, x1, y1 = bbox
        pad_x, pad_y = 12, 14
        x0, y0 = max(0, x0 - pad_x), max(0, y0 - pad_y)
        x1, y1 = min(cropped.width, x1 + pad_x), min(cropped.height, y1 + pad_y)
        if x1 - x0 > cropped.width * 0.62 and y1 - y0 > cropped.height * 0.34:
            cropped = cropped.crop((x0, y0, x1, y1))

    # A focused exercise strip remains readable inside the narrow teacher-action
    # column and does not add a full textbook page to the QMJ.
    target_height = round(cropped.width * 0.82)
    if cropped.height > target_height:
        y0 = max(0, round((cropped.height - target_height) * 0.52))
        cropped = cropped.crop((0, y0, cropped.width, y0 + target_height))

    max_width = 980
    if cropped.width > max_width:
        ratio = max_width / cropped.width
        cropped = cropped.resize((max_width, round(cropped.height * ratio)), Image.Resampling.LANCZOS)
    cropped = ImageEnhance.Contrast(cropped.convert("RGB")).enhance(1.04)
    return cropped


def render_pdf_page(path: Path, page_number: int) -> Image.Image:
    with fitz.open(path) as document:
        index = min(max(0, page_number - 1), document.page_count - 1)
        page = document.load_page(index)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(1.75, 1.75), alpha=False)
        return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def render_epub_page(path: Path, page_number: int) -> Image.Image:
    with zipfile.ZipFile(path) as archive:
        html_name = f"OEBPS/{page_number}.html"
        if html_name not in archive.namelist():
            html_pages = sorted(
                (name for name in archive.namelist() if re.fullmatch(r"OEBPS/\d+\.html", name)),
                key=lambda name: int(Path(name).stem),
            )
            html_name = html_pages[min(max(0, page_number - 1), len(html_pages) - 1)]
        html = archive.read(html_name).decode("utf-8", errors="ignore")
        match = re.search(r'<img[^>]+src=["\']([^"\']+)', html, re.I)
        if not match:
            raise ValueError(f"EPUB page has no image: {html_name}")
        image_name = str((Path(html_name).parent / match.group(1)).as_posix())
        return Image.open(io.BytesIO(archive.read(image_name))).convert("RGB")


def render_book_page(path: Path, page_number: int) -> Image.Image:
    return render_epub_page(path, page_number) if path.suffix.lower() == ".epub" else render_pdf_page(path, page_number)


def excerpt_visual(filename: str, topic: str) -> dict:
    return {
        "src": f"/textbook-excerpts/{filename}",
        "alt": f"{topic} тақырыбына арналған тапсырма",
        "caption": "Тақырыпқа сай тапсырма",
        "kind": "textbook-excerpt",
    }


def main() -> int:
    data_path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "qmj-reference-index.json")
    book_dir = Path(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_BOOK_DIR)
    data = json.loads(data_path.read_text(encoding="utf-8"))
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    bindings: dict[tuple[str, int], list[dict]] = {}
    for record in data.get("records", []):
        if record.get("term") not in {2, 3, 4}:
            continue
        plan = record.get("prepared_plan") or {}
        binding = plan.get("textbookPageBinding") or {}
        book, page = str(binding.get("file") or ""), int(binding.get("pdfPage") or 0)
        if book and page:
            bindings.setdefault((book, page), []).append(record)

    missing: list[str] = []
    created = 0
    for (book, page), records in bindings.items():
        source = book_dir / book
        if not source.is_file():
            missing.append(str(source))
            continue
        filename = safe_excerpt_name(book, page)
        destination = OUTPUT_DIR / filename
        image = snap_crop(render_book_page(source, page))
        image.save(destination, "JPEG", quality=82, optimize=True, progressive=True, subsampling=1)
        created += 1

        for record in records:
            plan = record["prepared_plan"]
            visual = excerpt_visual(filename, str(record.get("topic") or "Сабақ"))
            plan["visuals"] = [visual]
            for stage in plan.get("stages") or []:
                if stage.get("name") == "Сабақтың ортасы":
                    stage["visuals"] = [visual]
                    tasks = stage.get("tasks") or []
                    if tasks:
                        tasks[0]["instruction"] = "Суреттегі тақырыпқа сай тапсырмаларды орында. Таңдаған бір есептің шешу жолын толық жаз."
                        tasks[0]["descriptor"] = "суреттегі есептің шартын дұрыс оқып, бір тапсырманың шешу жолын толық жазады"
                        tasks[0]["points"] = max(1, int(tasks[0].get("points") or 1))
                    resources = [item for item in stage.get("resources") or [] if "сызба" not in str(item).lower()]
                    if "Тақырыптық тапсырма" not in resources:
                        resources.append("Тақырыптық тапсырма")
                    stage["resources"] = resources
            flags = [flag for flag in record.get("quality_flags") or [] if flag != "atamura_visual_support"]
            record["quality_flags"] = list(dict.fromkeys(flags + ["textbook_excerpt_embedded", "word_image_embedded"]))
            alignment = record.get("textbook_alignment") or {}
            alignment["use"] = "topic-aligned exercise excerpt supplied by the teacher"
            alignment["content_policy"] = "teacher-supplied textbook excerpt embedded in QMJ"
            record["textbook_alignment"] = alignment

    if missing:
        print(json.dumps({"missing": sorted(set(missing))}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2

    data["version"] = "19-textbook-excerpts"
    data["visual_plan_count"] = sum(
        bool((record.get("prepared_plan") or {}).get("visuals"))
        for record in data.get("records", []) if record.get("term") in {2, 3, 4}
    )
    data["textbook_alignment"] = "teacher-supplied Atamura exercise excerpts embedded for terms 2-4"
    data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"records": sum(len(items) for items in bindings.values()), "unique_excerpts": len(bindings), "created": created}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
