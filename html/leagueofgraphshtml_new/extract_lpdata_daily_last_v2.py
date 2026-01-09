#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LeagueOfGraphs saved HTML -> CSV (date,name,tier,lp,score)
with preprocessing + daily last value.

Features
- Extract Solo/Duo (rankingHistory-1) and Flex (rankingHistory-2)
- Choose queue: --queue solo|flex|both|auto
- Batch: pass many htmls OR use --in-dir
- Output directory: --out-dir
- Preprocessing:
  1) Remove "Iron IV, 0LP" glitch when same-day has other real tier OR sandwich A->Iron0->A
  2) Remove consecutive duplicate states (tier, lp) to kill season-boundary repeats
  3) Keep ONLY the last value per day (KST)

Usage examples
  python extract_lpdata_daily_last.py *.html --queue flex --out-dir out
  python extract_lpdata_daily_last.py --in-dir . --queue solo --out-dir solo_out

Notes
- Works best when lpData/rankData in HTML are JSON-compatible objects (quoted keys).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")

TIER_GROUPS = ["Iron", "Bronze", "Silver", "Gold", "Platinum", "Emerald", "Diamond"]
DIVS = ["IV", "III", "II", "I"]


@dataclass
class Rec:
    ts: int          # epoch ms
    date: str        # YYYY-MM-DD in KST
    name: str
    tier: str        # e.g. "Gold IV"
    lp: int
    score: float


# -----------------------------
# JS literal extraction helpers
# -----------------------------
def _extract_js_literal(text: str, start_idx: int) -> Tuple[str, int]:
    """Extract balanced JS literal starting at '[' or '{' (supports nested + strings)."""
    opener = text[start_idx]
    if opener not in "[{":
        raise ValueError("Literal must start with [ or {")
    closer = "]" if opener == "[" else "}"
    stack = [closer]

    i = start_idx
    in_str = False
    quote = ""
    escape = False

    while i < len(text):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                in_str = False
                quote = ""
            i += 1
            continue

        if ch in ("'", '"', "`"):
            in_str = True
            quote = ch
            i += 1
            continue

        if ch in "[{":
            stack.append("]" if ch == "[" else "}")
        elif ch in "]}":
            if not stack or ch != stack[-1]:
                raise ValueError("Mismatched brackets while scanning JS literal")
            stack.pop()
            if not stack:
                return text[start_idx : i + 1], i + 1
        i += 1

    raise ValueError("Unterminated JS literal")


def _find_var_literal(block: str, var_names: List[str]) -> Optional[str]:
    """
    Find assignment like 'const lpData = {...};' inside a block and return the '{...}' or '[...]'.

    IMPORTANT:
    Some LeagueOfGraphs pages embed these objects near other JS code. A pure bracket-scan can be thrown off
    if the parser accidentally enters an unclosed string state. For robustness we first try a simple
    delimiter-based slice:
      - object: from first '{' after '=' up to the next '};'
      - array:  from first '[' after '=' up to the next '];'
    and fall back to balanced scanning if needed.
    """
    for name in var_names:
        # allow optional var/let/const, and allow assignments without declarations too
        m = re.search(rf"(?:var|let|const)?\s*{re.escape(name)}\s*=\s*", block)
        if not m:
            continue
        after = m.end()
        m2 = re.search(r"[\[\{]", block[after:])
        if not m2:
            continue
        start = after + m2.start()
        opener = block[start]

        # Fast path: slice until the first matching close token '};' or '];'
        close_token = "};" if opener == "{" else "];"
        endpos = block.find(close_token, start)
        if endpos != -1:
            # include the closing bracket/brace, exclude the semicolon
            return block[start:endpos + 1]

        # Fallback: balanced scan
        try:
            lit, _ = _extract_js_literal(block, start)
            return lit
        except Exception:
            continue
    return None


def _try_parse_json(lit: str) -> Any:
    """Parse JSON, with a tiny trailing-comma cleanup."""
    try:
        return json.loads(lit)
    except json.JSONDecodeError:
        sanitized = re.sub(r",\s*([\]}])", r"\1", lit)
        return json.loads(sanitized)


# -----------------------------
# HTML slicing: solo/flex blocks
# -----------------------------
def _slice_block(html: str, block_id: str) -> Optional[str]:
    start = html.find(f'id="{block_id}"')
    if start == -1:
        return None
    nxt = html.find('id="rankingHistory-', start + 1)
    return html[start:nxt] if nxt != -1 else html[start:]


def _extract_name(html: str, fallback_filename: str) -> str:
    m = re.search(r"<title>\s*(.*?)\s*-\s*LeagueOfGraphs\s*</title>", html, re.I)
    if m:
        title = m.group(1).strip()
        title = re.sub(r"\s*\(KR\)\s*$", "", title).strip()
        return title
    base = Path(fallback_filename).stem
    base = re.sub(r"\s*-\s*LeagueOfGraphs.*$", "", base).strip()
    base = re.sub(r"\s*\(KR\)\s*$", "", base).strip()
    return base or "unknown#unknown"


def _ts_to_kst_date(ts_ms: int) -> str:
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).astimezone(KST)
    return dt.date().isoformat()


def _calc_score_from_ids(tier_id: int, rank_id: int, lp: int) -> float:
    # Matches your example: Bronze II 40LP -> 6.4
    return (tier_id - 1) * 4 + (4 - rank_id) + (lp / 100.0)


def _build_records(lp_data: Dict[str, Any], rank_data: Dict[str, Any], name: str) -> List[Rec]:
    recs: List[Rec] = []
    for ts_str, lp_val in lp_data.items():
        if ts_str not in rank_data:
            continue
        try:
            ts = int(ts_str)
            lp = int(float(lp_val))
        except Exception:
            continue

        info = rank_data.get(ts_str, {})
        tier = (info.get("tierRankString") or info.get("rankString") or "").strip()

        try:
            tier_id = int(info.get("tierId", 0))
            rank_id = int(info.get("rankId", 0))
        except Exception:
            tier_id = 0
            rank_id = 0

        if not tier or tier_id == 0 or rank_id == 0:
            continue

        score = round(_calc_score_from_ids(tier_id, rank_id, lp), 2)
        date = _ts_to_kst_date(ts)
        recs.append(Rec(ts=ts, date=date, name=name, tier=tier, lp=lp, score=score))

    recs.sort(key=lambda r: r.ts)
    return recs


# -----------------------------
# Preprocessing rules
# -----------------------------
def _remove_iron0_same_day_glitch(recs: List[Rec]) -> List[Rec]:
    """
    If a day has any non-(Iron IV,0) record, drop all (Iron IV,0) for that day.
    """
    if not recs:
        return recs
    by_date: Dict[str, List[int]] = {}
    for i, r in enumerate(recs):
        by_date.setdefault(r.date, []).append(i)

    drop = set()
    for d, idxs in by_date.items():
        has_non_iron0 = any(not (recs[i].tier == "Iron IV" and recs[i].lp == 0) for i in idxs)
        if has_non_iron0:
            for i in idxs:
                if recs[i].tier == "Iron IV" and recs[i].lp == 0:
                    drop.add(i)
    return [r for i, r in enumerate(recs) if i not in drop]


def _remove_consecutive_duplicates(recs: List[Rec]) -> List[Rec]:
    """Remove consecutive duplicate states (tier, lp)."""
    if not recs:
        return recs
    out = [recs[0]]
    for r in recs[1:]:
        p = out[-1]
        if (r.tier, r.lp) == (p.tier, p.lp):
            continue
        out.append(r)
    return out


def _remove_iron0_sandwich(recs: List[Rec]) -> List[Rec]:
    """Remove pattern A -> (Iron IV,0) -> A (same state on both sides), anywhere."""
    if len(recs) < 3:
        return recs
    out: List[Rec] = []
    i = 0
    while i < len(recs):
        if 0 < i < len(recs) - 1:
            mid = recs[i]
            if mid.tier == "Iron IV" and mid.lp == 0:
                left = recs[i - 1]
                right = recs[i + 1]
                if (left.tier, left.lp) == (right.tier, right.lp):
                    i += 1
                    continue
        out.append(recs[i])
        i += 1
    return out


def _keep_last_per_day(recs: List[Rec]) -> List[Rec]:
    """Keep only the last record per day (KST), based on ts order."""
    last: Dict[str, Rec] = {}
    for r in recs:
        last[r.date] = r
    return [last[d] for d in sorted(last.keys())]


def preprocess(recs: List[Rec]) -> List[Rec]:
    """
    Pipeline:
      0) sort by ts
      1) remove Iron0 glitch if same-day has any real tier
      2) remove consecutive duplicates (season-boundary duplicates, etc.)
      3) remove sandwich Iron0
      4) keep only last per day
    """
    recs = sorted(recs, key=lambda r: r.ts)
    recs = _remove_iron0_same_day_glitch(recs)
    recs = _remove_consecutive_duplicates(recs)
    recs = _remove_iron0_sandwich(recs)
    recs = _keep_last_per_day(recs)
    return recs


# -----------------------------
# Main extraction per queue
# -----------------------------
def extract_queue(html: str, queue: str, name: str) -> List[Rec]:
    """
    queue:
      - solo: rankingHistory-1
      - flex: rankingHistory-2
    """
    block_id = "rankingHistory-1" if queue == "solo" else "rankingHistory-2"
    block = _slice_block(html, block_id)
    if not block:
        return []

    lp_lit = _find_var_literal(block, ["lpData", "lpdata"])
    rank_lit = _find_var_literal(block, ["rankData", "rankdata"])
    if not lp_lit or not rank_lit:
        return []

    try:
        lp_obj = _try_parse_json(lp_lit)
        rank_obj = _try_parse_json(rank_lit)
    except Exception:
        return []

    if not isinstance(lp_obj, dict) or not isinstance(rank_obj, dict):
        return []

    recs = _build_records(lp_obj, rank_obj, name)
    return preprocess(recs)


def write_csv(recs: List[Rec], out_file: Path) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with out_file.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["date", "name", "tier", "lp", "score"])
        for r in recs:
            score_str = f"{r.score:.2f}".rstrip("0").rstrip(".")
            w.writerow([r.date, r.name, r.tier, r.lp, score_str])


def iter_input_files(html_args: List[Path], in_dir: Optional[Path]) -> List[Path]:
    files: List[Path] = []
    if in_dir is not None:
        files.extend(sorted(in_dir.glob("*.html")))
    files.extend(html_args)

    seen = set()
    out: List[Path] = []
    for p in files:
        rp = p.resolve()
        if rp in seen:
            continue
        if rp.exists() and rp.is_file():
            seen.add(rp)
            out.append(rp)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("html", nargs="*", type=Path, help="HTML 파일(여러 개 가능)")
    ap.add_argument("--in-dir", type=Path, default=None, help="폴더 안의 *.html 전부 처리")
    ap.add_argument("--queue", choices=["solo", "flex", "both", "auto"], default="auto",
                    help="뽑을 큐 선택 (auto=있는 것만)")
    ap.add_argument("--out-dir", type=Path, default=Path("out"), help="출력 폴더")
    ap.add_argument("--name", default=None, help="name 컬럼 강제 지정 (미지정 시 title/파일명에서 추출)")
    args = ap.parse_args()

    files = iter_input_files(args.html, args.in_dir)
    if not files:
        raise SystemExit("처리할 HTML 파일이 없음. (*.html)")

    for html_path in files:
        html = html_path.read_text(encoding="utf-8", errors="ignore")
        name = args.name or _extract_name(html, html_path.name)

        has_solo = 'id="rankingHistory-1"' in html
        has_flex = 'id="rankingHistory-2"' in html

        if args.queue == "solo":
            queues = ["solo"]
        elif args.queue == "flex":
            queues = ["flex"]
        elif args.queue == "both":
            queues = ["solo", "flex"]
        else:  # auto
            queues = []
            if has_solo:
                queues.append("solo")
            if has_flex:
                queues.append("flex")

        if not queues:
            print(f"[SKIP] {html_path.name}: rankingHistory 블록이 없음")
            continue

        for q in queues:
            recs = extract_queue(html, q, name)
            if not recs:
                print(f"[SKIP] {html_path.name}: {q} lpData/rankData 파싱 실패 또는 데이터 없음")
                continue

            out_file = args.out_dir / f"{html_path.stem}.{q}.csv"
            write_csv(recs, out_file)
            print(f"[OK] {html_path.name} -> {out_file.name} ({len(recs)} rows)")


if __name__ == "__main__":
    main()
