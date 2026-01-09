# extract_lpdata.py
# 사용 예)
#   python extract_lpdata.py "Synow#KR1 (KR) - LeagueOfGraphs.html" --queue solo
#   python extract_lpdata.py "Synow#KR1 (KR) - LeagueOfGraphs.html" --queue flex
#   python extract_lpdata.py "Synow#KR1 (KR) - LeagueOfGraphs.html" --queue both


''' 한번에 다 뽑기
$dir = "flex_out"
mkdir $dir -ea 0
Get-ChildItem *.html | ForEach-Object {
  python .\extract_lpdata.py $_.FullName --queue flex --out ($dir + "\" + $_.BaseName + ".flex.csv")
}

&dir가 폴더이름, fl
'''



from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


KST = ZoneInfo("Asia/Seoul")


@dataclass
class Row:
    date: str
    name: str
    tier: str
    lp: int
    score: float


def extract_title_name(html: str, fallback: str) -> str:
    # <title>Synow#KR1 (KR) - LeagueOfGraphs</title> 같은 형태에서 앞부분만 추출
    m = re.search(r"<title>\s*(.*?)\s*\(KR\)\s*-\s*LeagueOfGraphs\s*</title>", html, re.I)
    if m:
        return m.group(1).strip()

    # fallback: 파일명에서 대충 #KR1 앞까지
    # 예: Synow#KR1 (KR) - LeagueOfGraphs.html
    m2 = re.search(r"(.+?)\s*\(KR\)\s*-\s*LeagueOfGraphs", fallback)
    return (m2.group(1).strip() if m2 else fallback)


def slice_block(html: str, block_id: str) -> str | None:
    # block_id가 있는 지점부터 다음 rankingHistory- 로 넘어가기 전까지를 블록으로 잡음
    start = html.find(f'id="{block_id}"')
    if start == -1:
        return None
    # 다음 rankingHistory- 시작점 찾기
    nxt = html.find('id="rankingHistory-', start + 1)
    return html[start:nxt] if nxt != -1 else html[start:]


def extract_js_object(block: str, varname: str) -> str | None:
    # const lpData = {...}; 또는 const rankData = {...};
    m = re.search(rf"const\s+{re.escape(varname)}\s*=\s*(\{{.*?\}});", block, flags=re.S)
    return m.group(1) if m else None


def build_rows(lp_data: dict, rank_data: dict, name: str) -> list[Row]:
    rows: list[Row] = []
    for ts_str, lp in lp_data.items():
        info = rank_data.get(ts_str)
        if not info:
            continue

        ts_ms = int(ts_str)
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=ZoneInfo("UTC")).astimezone(KST)
        date_str = dt.date().isoformat()

        tier = info.get("tierRankString", "")
        tier_id = int(info.get("tierId", 0))
        rank_id = int(info.get("rankId", 0))

        # 네가 쓰던 점수 방식 (예: Bronze II 40LP -> 6.4)
        score = (tier_id - 1) * 4 + (4 - rank_id) + (int(lp) / 100.0)
        rows.append(Row(date_str, name, tier, int(lp), round(score, 2)))

    # timestamp 순서가 아니라 date 기준만 쓰면 같은 날 중복이 섞일 수 있어서,
    # 여기서는 date만 정렬(필요하면 ts 정렬로 바꿔도 됨)
    rows.sort(key=lambda r: r.date)
    return rows


def parse_queue(html: str, queue: str, name: str) -> list[Row]:
    # 일반적으로:
    #   rankingHistory-1 = 솔랭(메인)
    #   rankingHistory-2 = 자랭(other league)
    block_id = "rankingHistory-1" if queue == "solo" else "rankingHistory-2"
    block = slice_block(html, block_id)
    if not block:
        return []

    lp_obj = extract_js_object(block, "lpData")
    rank_obj = extract_js_object(block, "rankData")
    if not lp_obj or not rank_obj:
        return []

    lp_data = json.loads(lp_obj)
    rank_data = json.loads(rank_obj)
    return build_rows(lp_data, rank_data, name)


def write_csv(rows: list[Row], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "name", "tier", "lp", "score"])
        for r in rows:
            w.writerow([r.date, r.name, r.tier, r.lp, f"{r.score:g}"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html", type=Path, help="LeagueOfGraphs HTML 파일 경로")
    ap.add_argument("--queue", choices=["solo", "flex", "both"], default=None,
                    help="솔랭/자랭 선택 (미지정 시 있으면 물어봄)")
    ap.add_argument("--out", type=Path, default=None, help="출력 CSV 경로(미지정 시 자동)")
    args = ap.parse_args()

    html_text = args.html.read_text(encoding="utf-8", errors="ignore")
    name = extract_title_name(html_text, args.html.name)

    has_solo = 'id="rankingHistory-1"' in html_text
    has_flex = 'id="rankingHistory-2"' in html_text

    queue = args.queue
    if queue is None:
        # 간단 인터랙티브 선택
        options = []
        if has_solo: options.append(("solo", "솔랭(420) / Ranked Solo-Duo"))
        if has_flex: options.append(("flex", "자랭(440) / Ranked Flex"))
        if has_solo and has_flex: options.append(("both", "둘 다"))

        if not options:
            raise SystemExit("rankingHistory 블록을 못 찾았음 (이 HTML은 티어 히스토리가 없을 수 있음).")

        print("뽑을 큐를 선택:")
        for i, (_, label) in enumerate(options, 1):
            print(f"  {i}) {label}")
        pick = int(input("> ").strip())
        queue = options[pick - 1][0]

    rows_all: list[Row] = []
    if queue in ("solo", "both"):
        rows_all.extend(parse_queue(html_text, "solo", name))
    if queue in ("flex", "both"):
        rows_all.extend(parse_queue(html_text, "flex", name))

    if not rows_all:
        raise SystemExit("lpData/rankData를 못 찾았음. (페이지 구조가 바뀌었거나 데이터가 없음)")

    # 출력 파일 자동 이름
    if args.out:
        out_path = args.out
    else:
        suffix = queue
        out_path = args.html.with_suffix(f".{suffix}.csv")

    write_csv(rows_all, out_path)
    print(f"OK: {out_path} ({len(rows_all)} rows)")


if __name__ == "__main__":
    main()
