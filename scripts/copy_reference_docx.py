#!/usr/bin/env python3
"""Copy the teacher's term-1 DOCX files to stable reference URLs."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    source_root = Path(sys.argv[1] if len(sys.argv) > 1 else root.parent / "imported_qmj" / "Атамура 1 токсан Меруерт")
    data = json.loads((root / "data" / "qmj-reference-index.json").read_text(encoding="utf-8"))
    target = root / "data" / "reference-docx"
    target.mkdir(parents=True, exist_ok=True)
    copied = 0
    missing = []
    for record in data.get("records", []):
        if record.get("term") != 1:
            continue
        source = record.get("source", {})
        path = source_root / str(source.get("group", "")) / str(source.get("file", ""))
        if not path.is_file():
            missing.append(str(path))
            continue
        shutil.copy2(path, target / f"{record['id']}.docx")
        copied += 1
    print(json.dumps({"copied": copied, "missing": missing}, ensure_ascii=False))
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
