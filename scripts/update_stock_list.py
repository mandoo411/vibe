import json
import os
import re
import sys
from html.parser import HTMLParser


def _strip(s: str) -> str:
    return (s or "").strip()


def _code6(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return ""
    if len(digits) == 6:
        return digits
    if len(digits) < 6:
        return digits.zfill(6)
    return digits[-6:]


class _KindTableParser(HTMLParser):
    """
    KRX KIND 'download' returns an HTML table (often served as .xls).
    We parse rows and pick "종목코드" + "회사명" columns.
    """

    def __init__(self):
        super().__init__()
        self.in_tr = False
        self.in_td = False
        self.cur_row = []
        self.rows = []
        self._buf = []

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        if t == "tr":
            self.in_tr = True
            self.cur_row = []
        elif t in ("td", "th") and self.in_tr:
            self.in_td = True
            self._buf = []

    def handle_endtag(self, tag):
        t = tag.lower()
        if t in ("td", "th") and self.in_tr and self.in_td:
            self.in_td = False
            self.cur_row.append(_strip("".join(self._buf)))
            self._buf = []
        elif t == "tr" and self.in_tr:
            self.in_tr = False
            if self.cur_row:
                self.rows.append(self.cur_row)
            self.cur_row = []

    def handle_data(self, data):
        if self.in_tr and self.in_td:
            self._buf.append(data)


def parse_kind_download(raw_bytes: bytes) -> list[dict]:
    # KIND download is commonly cp949/euc-kr.
    for enc in ("cp949", "euc-kr", "utf-8"):
        try:
            text = raw_bytes.decode(enc, errors="replace")
            break
        except Exception:
            continue
    else:
        text = raw_bytes.decode("utf-8", errors="replace")

    p = _KindTableParser()
    p.feed(text)

    # Find header row that contains "종목코드" and "회사명"
    header = None
    header_idx = -1
    for i, row in enumerate(p.rows[:30]):
        if any("종목코드" in c for c in row) and any("회사명" in c for c in row):
            header = row
            header_idx = i
            break

    if header is None:
        raise RuntimeError("Failed to find header row (종목코드/회사명)")

    try:
        code_col = next(j for j, c in enumerate(header) if "종목코드" in c)
        name_col = next(j for j, c in enumerate(header) if "회사명" in c)
    except StopIteration:
        raise RuntimeError("Header row missing columns")

    out = []
    for row in p.rows[header_idx + 1 :]:
        if len(row) <= max(code_col, name_col):
            continue
        code = _code6(row[code_col])
        name = _strip(row[name_col])
        if not code or not name:
            continue
        out.append({"code": code, "name": name})
    return out


def main():
    if len(sys.argv) < 4:
        print("usage: update_stock_list.py <kospi_file> <kosdaq_file> <output_json>", file=sys.stderr)
        return 2

    kospi_file, kosdaq_file, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(kospi_file, "rb") as f:
        kospi = parse_kind_download(f.read())
    with open(kosdaq_file, "rb") as f:
        kosdaq = parse_kind_download(f.read())

    rows = []
    for r in kospi:
        rows.append({"code": r["code"], "name": r["name"], "market": "KOSPI"})
    for r in kosdaq:
        rows.append({"code": r["code"], "name": r["name"], "market": "KOSDAQ"})

    # Stable ordering
    rows.sort(key=lambda x: (x["market"], x["code"]))

    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    print(f"Wrote {len(rows)} rows to {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

