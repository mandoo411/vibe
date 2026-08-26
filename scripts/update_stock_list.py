import json
import os
import re
import sys
import urllib.request
from html.parser import HTMLParser


def _strip(s: str) -> str:
    return (s or "").strip()


def _code6(raw: str) -> str:
    text = _strip(raw).upper()
    if re.fullmatch(r"[0-9A-Z]{6}", text):
        return text
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


def fetch_naver_etf_list() -> list[dict]:
    """NAVER 금융 ETF 전종목 — KIND 상장법인 목록에 없는 ETF 검색용."""
    url = "https://finance.naver.com/api/sise/etfItemList.nhn?pageSize=2000&page=1"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
    text = raw.decode("euc-kr", errors="replace")
    data = json.loads(text)
    items = (data.get("result") or {}).get("etfItemList") or []
    out = []
    for item in items:
        code = _code6(item.get("itemcode") or "")
        name = _strip(item.get("itemname") or "")
        if code and name:
            out.append({"code": code, "name": name})
    return out


# --- KIS 종목마스터(.mst) 파서: KIND 상장법인목록(corpList.do)에는 우선주가 빠져 있어
#     (회사 단위 목록이라 대표/보통주 1개만 포함) 삼성전자우/삼성물산우 같은 우선주가
#     검색이 안 되는 문제가 있었다. KIS가 공개 배포하는 종목마스터 파일은 개별 "증권"
#     단위 목록이라 우선주를 포함하므로, 여기서 우선주만 추려 별도로 병합한다.
#     포맷 출처: https://github.com/koreainvestment/open-trading-api
#     stocks_info/kis_kospi_code_mst.py, kis_kosdaq_code_mst.py (part2 fixed-width spec)

_KOSPI_TAIL_LEN = 228
_KOSPI_PART2_FIELDS = [
    ("그룹코드", 2), ("시가총액규모", 1), ("지수업종대분류", 4), ("지수업종중분류", 4), ("지수업종소분류", 4),
    ("제조업", 1), ("저유동성", 1), ("지배구조지수종목", 1), ("KOSPI200섹터업종", 1), ("KOSPI100", 1),
    ("KOSPI50", 1), ("KRX", 1), ("ETP", 1), ("ELW발행", 1), ("KRX100", 1),
    ("KRX자동차", 1), ("KRX반도체", 1), ("KRX바이오", 1), ("KRX은행", 1), ("SPAC", 1),
    ("KRX에너지화학", 1), ("KRX철강", 1), ("단기과열", 1), ("KRX미디어통신", 1), ("KRX건설", 1),
    ("Non1", 1), ("KRX증권", 1), ("KRX선박", 1), ("KRX섹터_보험", 1), ("KRX섹터_운송", 1),
    ("SRI", 1), ("기준가", 9), ("매매수량단위", 5), ("시간외수량단위", 5), ("거래정지", 1),
    ("정리매매", 1), ("관리종목", 1), ("시장경고", 2), ("경고예고", 1), ("불성실공시", 1),
    ("우회상장", 1), ("락구분", 2), ("액면변경", 2), ("증자구분", 2), ("증거금비율", 3),
    ("신용가능", 1), ("신용기간", 3), ("전일거래량", 12), ("액면가", 12), ("상장일자", 8),
    ("상장주수", 15), ("자본금", 21), ("결산월", 2), ("공모가", 7), ("우선주", 1),
    ("공매도과열", 1), ("이상급등", 1), ("KRX300", 1), ("KOSPI", 1), ("매출액", 9),
    ("영업이익", 9), ("경상이익", 9), ("당기순이익", 5), ("ROE", 9), ("기준년월", 8),
    ("시가총액", 9), ("그룹사코드", 3), ("회사신용한도초과", 1), ("담보대출가능", 1), ("대주가능", 1),
]

_KOSDAQ_TAIL_LEN = 222
_KOSDAQ_PART2_FIELDS = [
    ("증권그룹구분코드", 2), ("시가총액규모구분코드유가", 1),
    ("지수업종대분류코드", 4), ("지수업종중분류코드", 4), ("지수업종소분류코드", 4), ("벤처기업여부", 1),
    ("저유동성종목여부", 1), ("KRX종목여부", 1), ("ETP상품구분코드", 1), ("KRX100종목여부", 1),
    ("KRX자동차여부", 1), ("KRX반도체여부", 1), ("KRX바이오여부", 1), ("KRX은행여부", 1), ("기업인수목적회사여부", 1),
    ("KRX에너지화학여부", 1), ("KRX철강여부", 1), ("단기과열종목구분코드", 1), ("KRX미디어통신여부", 1),
    ("KRX건설여부", 1), ("투자주의환기종목여부", 1), ("KRX증권구분", 1), ("KRX선박구분", 1),
    ("KRX섹터지수보험여부", 1), ("KRX섹터지수운송여부", 1), ("KOSDAQ150지수여부", 9), ("주식기준가", 5),
    ("정규시장매매수량단위", 5), ("시간외시장매매수량단위", 1), ("거래정지여부", 1), ("정리매매여부", 1),
    ("관리종목여부", 2), ("시장경고구분코드", 1), ("시장경고위험예고여부", 1), ("불성실공시여부", 1),
    ("우회상장여부", 2), ("락구분코드", 2), ("액면가변경구분코드", 2), ("증자구분코드", 3), ("증거금비율", 1),
    ("신용주문가능여부", 3), ("신용기간", 12), ("전일거래량", 12), ("주식액면가", 8), ("주식상장일자", 15),
    ("상장주수", 21), ("자본금", 2), ("결산월", 7), ("공모가격", 1), ("우선주구분코드", 1),
    ("공매도과열종목여부", 1), ("이상급등종목여부", 1), ("KRX300종목여부", 9), ("매출액", 9),
    ("영업이익", 9), ("경상이익", 5), ("단기순이익", 9), ("ROE", 8), ("기준년월", 9),
    ("전일기준시가총액", 3), ("그룹사코드", 1), ("회사신용한도초과여부", 1), ("담보대출가능여부", 1), ("대주가능여부", 1),
]


def _slice_fields(tail: str, fields: list[tuple]) -> dict:
    out = {}
    pos = 0
    for name, width in fields:
        out[name] = tail[pos : pos + width].strip()
        pos += width
    return out


def parse_kis_mst_preferred(path: str, tail_len: int, fields: list[tuple], pref_field: str, market: str) -> list[dict]:
    """KIS 종목마스터(.mst, cp949 고정폭) 파일에서 우선주(우선주 플래그 != '0')만 추린다."""
    out = []
    with open(path, "r", encoding="cp949", errors="replace") as f:
        for row in f:
            if len(row) < tail_len:
                continue
            head = row[: len(row) - tail_len]
            tail = row[-tail_len:]
            code = _strip(head[0:9])
            name = _strip(head[21:])
            if not code or not name:
                continue
            parsed = _slice_fields(tail, fields)
            pref_flag = parsed.get(pref_field, "0")
            if pref_flag and pref_flag != "0":
                out.append({"code": code, "name": name, "market": market})
    return out


def fetch_preferred_stocks(kospi_mst: str | None, kosdaq_mst: str | None) -> list[dict]:
    out = []
    if kospi_mst and os.path.exists(kospi_mst):
        out.extend(parse_kis_mst_preferred(kospi_mst, _KOSPI_TAIL_LEN, _KOSPI_PART2_FIELDS, "우선주", "KOSPI"))
    if kosdaq_mst and os.path.exists(kosdaq_mst):
        out.extend(parse_kis_mst_preferred(kosdaq_mst, _KOSDAQ_TAIL_LEN, _KOSDAQ_PART2_FIELDS, "우선주구분코드", "KOSDAQ"))
    return out


def main():
    if len(sys.argv) < 4:
        print(
            "usage: update_stock_list.py <kospi_file> <kosdaq_file> <output_json> "
            "[kospi_mst_file] [kosdaq_mst_file]",
            file=sys.stderr,
        )
        return 2

    kospi_file, kosdaq_file, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
    kospi_mst = sys.argv[4] if len(sys.argv) > 4 else None
    kosdaq_mst = sys.argv[5] if len(sys.argv) > 5 else None

    with open(kospi_file, "rb") as f:
        kospi = parse_kind_download(f.read())
    with open(kosdaq_file, "rb") as f:
        kosdaq = parse_kind_download(f.read())

    by_code: dict[str, dict] = {}
    for r in kospi:
        by_code[r["code"]] = {"code": r["code"], "name": r["name"], "market": "KOSPI"}
    for r in kosdaq:
        by_code[r["code"]] = {"code": r["code"], "name": r["name"], "market": "KOSDAQ"}

    try:
        etfs = fetch_naver_etf_list()
        added = 0
        for r in etfs:
            if r["code"] in by_code:
                continue
            by_code[r["code"]] = {"code": r["code"], "name": r["name"], "market": "ETF"}
            added += 1
        print(f"Merged {added} ETF rows from NAVER")
    except Exception as exc:
        print(f"WARN: ETF merge skipped: {exc}", file=sys.stderr)

    # 우선주 병합 — KIND 상장법인목록은 회사 단위라 우선주가 구조적으로 빠진다.
    # KIS 종목마스터(.mst)에서 우선주만 추려 별도로 채워 넣는다. (mst 파일이 없으면 건너뜀 — 하위호환)
    try:
        if kospi_mst or kosdaq_mst:
            prefs = fetch_preferred_stocks(kospi_mst, kosdaq_mst)
            added = 0
            for r in prefs:
                if r["code"] in by_code:
                    continue
                by_code[r["code"]] = r
                added += 1
            print(f"Merged {added} preferred-stock rows from KIS 종목마스터 ({len(prefs)} found)")
        else:
            print("WARN: kospi_mst/kosdaq_mst not provided — skipping preferred-stock merge", file=sys.stderr)
    except Exception as exc:
        print(f"WARN: preferred-stock merge skipped: {exc}", file=sys.stderr)

    rows = sorted(by_code.values(), key=lambda x: (x["market"], x["code"]))

    os.makedirs(os.path.dirname(out_json) or ".", exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    print(f"Wrote {len(rows)} rows to {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
