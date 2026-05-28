from __future__ import annotations

from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
KIS_DIR = ROOT / "kis"


def find_hits(df: pd.DataFrame, needles: list[str], max_rows: int = 140) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    sub = df.iloc[:max_rows, :10].fillna("")
    for i in range(len(sub)):
        row = [str(x) for x in sub.iloc[i].tolist()]
        line = " | ".join(row)
        if any(n in line for n in needles):
            hits.append((i + 1, line[:260]))
    return hits


def sniff_file(path: Path) -> None:
    print(f"\n=== {path.name} ===")
    xls = pd.ExcelFile(path)
    print("sheets:", xls.sheet_names)

    needles = [
        "TR_ID",
        "tr_id",
        "URL",
        "url",
        "Endpoint",
        "엔드포인트",
        "/uapi/",
        "FID_INPUT_ISCD",
        "FID_COND_MRKT_DIV_CODE",
        "output",
        "응답",
        "입력",
        "출력",
        "요청",
        "파라미터",
        "Header",
        "헤더",
    ]

    # Usually the first sheet contains spec; still scan a few.
    for sheet in xls.sheet_names[:4]:
        df = pd.read_excel(path, sheet_name=sheet, header=None)
        hits = find_hits(df, needles)
        if not hits:
            continue
        print(f"\n-- sheet: {sheet} --")
        for (row_i, line) in hits[:40]:
            print(f"{row_i}: {line}")


def main() -> None:
    # 파일명이 한글이라 콘솔/로케일에 따라 깨질 수 있어,
    # 문서 코드(예: -079) 또는 키워드로 파일을 찾는다.
    files = list(KIS_DIR.glob("*.xlsx"))
    if not files:
        print(f"No .xlsx files found in {KIS_DIR}")
        return

    def pick_by_suffix(suf: str) -> Path | None:
        return next((p for p in files if p.name.endswith(suf)), None)

    def pick_by_contains(keyword: str) -> list[Path]:
        return [p for p in files if keyword in p.name]

    picked: list[Path] = []
    for suf in ["-079].xlsx", "-080].xlsx", "-081].xlsx", "-008].xlsx"]:
        hit = pick_by_suffix(suf)
        if hit:
            picked.append(hit)

    # 수급(투자자별 매매동향) 관련 문서도 함께 스캔
    picked += pick_by_contains("투자자")
    picked += pick_by_contains("매매동향")

    # 중복 제거 (순서 유지)
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in picked:
        k = str(p.resolve())
        if k in seen:
            continue
        seen.add(k)
        uniq.append(p)

    for p in uniq:
        sniff_file(p)


if __name__ == "__main__":
    main()

