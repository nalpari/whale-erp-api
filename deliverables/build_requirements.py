"""요구사항정의서(WHALE-REQ) — sources/manyfast.json(Manyfast 스냅숏)을 엑셀로 낸다.

    .venv/bin/python build_requirements.py --version 1.0

PRD 는 빼고 요구사항 → 기능 → 명세만 싣는다. 값은 Manyfast 에 있는 것만 옮긴다. 이 문서는 추적용이라 API 명세의
내부 표지 제외 규칙은 쓰지 않는다. 예시 이메일 · 휴대전화번호만 example.com · 01012345678 로 바꿔 쓴다.
"""
import argparse
import json
import os
import re
from html.parser import HTMLParser

from openpyxl.styles import Alignment, Font

from common import FONT, HERE, open_xlsx, record_basis, safe, save_xlsx, table_sheet

SNAPSHOT = os.path.join(HERE, "sources", "manyfast.json")
SLOTS = [("preconditions", "전제 조건"), ("trigger", "트리거"), ("action", "동작"), ("outcome", "결과"),
         ("exceptions", "예외"), ("display", "표시"), ("permissions", "권한"), ("rules", "규칙"), ("dataSpec", "데이터")]
PROGRESS = {"todo": "할 일", "in_progress": "진행 중", "inProgress": "진행 중", "done": "완료", "blocked": "차단됨"}
IMPORTANCE = {"high": "높음", "medium": "보통", "low": "낮음"}
# 「WHALEERP-261 · 321」 「WHALEERP-280·281·282」처럼 접두 없이 이어 쓴 번호도 같은 접두로 읽는다.
# 「WHALEERP-137, 2026-10-28」의 날짜는 번호가 아니다(뒤에 - 가 붙는다).
PLANE = re.compile(r"WHALEERP-(\d+)((?:\s*[·,]\s*\d+(?![\d-]))*)")
PHASE = re.compile(r"\[([12])차\]")


class _Table(HTMLParser):
    """Manyfast 의 HTML 표를 줄 · 칸 목록으로 푼다. 칸 안의 <p> · <br> 는 줄바꿈이 되고, <p> 밖의 글자도 남는다.
    colspan 은 같은 값을 옆 칸에, rowspan 은 아래 줄의 같은 칸에 채운다."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.cell, self.span, self.down = [], None, (1, 1), {}  # down: 칸 번호 → (남은 줄 수, 값)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self.rows.append([])
            self._fill_down()
        elif tag in ("td", "th"):
            self.cell = [""]
            self.span = (int(a.get("colspan") or 1), int(a.get("rowspan") or 1))
        elif tag in ("p", "br") and self.cell is not None:
            self.cell.append("")

    def _fill_down(self):
        row = self.rows[-1]
        while len(row) in self.down:
            left, value = self.down[len(row)]
            row.append(value)
            if left <= 1:
                del self.down[len(row) - 1]
            else:
                self.down[len(row) - 1] = (left - 1, value)

    def handle_endtag(self, tag):
        if tag == "p" and self.cell is not None:
            self.cell.append("")
        if tag in ("td", "th") and self.cell is not None:
            value = "\n".join(x.strip() for x in self.cell if x.strip())
            cols, rows = self.span
            for _ in range(cols):
                if rows > 1:
                    self.down[len(self.rows[-1])] = (rows - 1, value)
                self.rows[-1].append(value)
            self.cell = None
            self._fill_down()

    def handle_data(self, data):
        if self.cell is not None:
            self.cell[-1] += data


def split_tables(text):
    """설명에서 정책 표(HTML <table> · 마크다운 | 줄)를 떼어 (남은 글, [표의 줄 목록]) 을 돌려준다. 표의 첫 줄은 머리다."""
    html_tables = []

    def html(m):
        t = _Table()
        t.feed(m.group(0))
        html_tables.append(t.rows)
        return f"\0{len(html_tables) - 1}\0"
    text = re.sub(r"<table\b.*?</table>", html, text or "", flags=re.S)
    tables, out, block = [], [], []  # tables 는 본문에 나온 순서대로다(HTML · 마크다운이 섞여도)

    def note(t):
        tables.append(t)
        return f"(정책 표 {len(t) - 1}줄은 「정책 표」 시트)"
    for line in text.split("\n") + [""]:
        if line.lstrip().startswith("|"):
            block.append(line)
            continue
        if block:
            rows = [[c.strip() for c in b.strip().strip("|").split("|")] for b in block]
            out.append(note([r for r in rows if not all(re.fullmatch(r":?-{3,}:?", c) for c in r)]))
            block = []
        out.append(re.sub(r"\0(\d+)\0", lambda m: note(html_tables[int(m.group(1))]), line))
    return "\n".join(out[:-1]).strip(), tables


def texts(x):
    """항목 data 안의 모든 문자열(Plane 번호 찾기 · 자체 검사용)."""
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from texts(v)
    elif isinstance(x, list):
        for v in x:
            yield from texts(v)


def plane(data):
    nums = (n for t in texts(data) for m in PLANE.finditer(t) for n in [m.group(1)] + re.findall(r"\d+", m.group(2)))
    return ", ".join(dict.fromkeys(f"WHALEERP-{n}" for n in nums))


def phase(data):
    """Manyfast 에 차수 칸이 없어, 이름에 [1차] · [2차] 표시가 있을 때만 적는다."""
    m = PHASE.search(data.get("name", ""))
    return f"{m.group(1)}차" if m else ""


def slot_values(data):
    """상세 칸 값. applicability 가 na 면 「해당 없음」이다."""
    slots = data.get("slots") or {}
    return ["해당 없음" if (slots.get(k) or {}).get("applicability") == "na" and not (slots.get(k) or {}).get("value")
            else (slots.get(k) or {}).get("value") or "" for k, _ in SLOTS]


def ordered(snap):
    """요구사항 순서 → 그 요구사항의 기능 순서 → 그 기능의 명세 순서. 목록에 안 걸린 항목도 뒤에 붙인다."""
    reqs = snap["requirements"]
    feats = {f["id"]: f for f in snap["features"]}
    specs = {s["id"]: s for s in snap["specs"]}
    f_order = [fid for r in reqs for fid in r["data"].get("features", []) if fid in feats]
    f_order += [fid for fid in feats if fid not in f_order]
    s_order = [sid for fid in f_order for sid in feats[fid]["data"].get("specs", []) if sid in specs]
    s_order += [sid for sid in specs if sid not in s_order]
    return reqs, [feats[i] for i in f_order], [specs[i] for i in s_order]


def build(snap):
    """(요구사항 줄, 기능 줄, 명세 줄). 각 줄 맨 끝은 ID 다."""
    reqs, feats, specs = ordered(snap)
    devices = snap.get("devices") or {}
    name = {x["id"]: x["data"].get("name", "") for x in reqs + feats + specs}

    def common(x):
        d = x["data"]
        return [phase(d), PROGRESS.get(d.get("progress"), d.get("progress") or ""),
                IMPORTANCE.get(d.get("importance"), d.get("importance") or "")]

    req_rows = [[r["data"].get("name", ""), split_tables(r["data"].get("description", ""))[0],
                 "\n".join(("[완료] " if a.get("isDone") else "") + a.get("description", "")
                           for a in r["data"].get("acceptanceCriteria") or [])]
                + common(r) + [plane(r["data"]), r["id"]] for r in reqs]

    def child(x):
        d = x["data"]
        return ([d.get("name", ""), name.get(d.get("parentId"), d.get("parentId") or ""), d.get("description", ""),
                 d.get("rationale", ""), d.get("successCriteria", "")] + common(x)
                + [", ".join(devices.get(i, i) for i in d.get("devices") or [])] + slot_values(d)
                + [plane(d), x["id"]])

    return req_rows, [child(f) for f in feats], [child(s) for s in specs], {x["id"]: x for x in reqs + feats + specs}


# 역할(roles)은 PRD 에도 항목에도 값이 없어 칸을 두지 않는다(2026-11-05 스냅숏 기준).
CHILD_HEADERS = (["이름", "상위", "설명", "근거", "성공 기준", "1차/2차", "상태", "중요도", "사용 기기"]
                 + [label for _, label in SLOTS] + ["Plane", "ID"])
CHILD_WIDTHS = [30, 26, 50, 40, 30, 8, 9, 8, 14] + [44] * len(SLOTS) + [16, 11]


def basis(snap):
    return f"기획 명세 스냅숏 {snap['readAt']}"


def write(version):
    """엑셀을 쓰고 (경로, 요구사항 수, 기능 수, 명세 수) 를 돌려준다."""
    snap = json.load(open(SNAPSHOT, encoding="utf-8"))
    req_rows, feat_rows, spec_rows, _ = build(snap)
    counts = snap.get("totalCounts")
    if not counts:
        raise SystemExit("스냅숏에 totalCounts(read_project_meta 의 항목 수)가 없습니다. 스냅숏을 다시 만들어 주세요.")
    for key, rows in (("requirements", req_rows), ("features", feat_rows), ("specs", spec_rows)):
        if counts.get(key) != len(rows):
            raise SystemExit(f"Manyfast {key} {counts[key]} · 문서 {len(rows)} 이 다릅니다. 스냅숏을 다시 만들어 주세요.")
    wb, doc_name, doc_no = open_xlsx("REQ", version)
    source = [("원본", f"Manyfast 「{snap['title']}」 — {snap['method']}. 읽은 날 {snap['readAt']}"),
              ("참고", "PRD 는 싣지 않는다. Plane 칸은 Manyfast 본문에 WHALEERP-번호가 적힌 것만 옮긴다. "
                     "1차/2차 칸은 Manyfast 에 차수 칸이 없어 이름에 [1차] · [2차] 표시가 있을 때만 적는다.")]
    sheets = [("요구사항", ["이름", "설명", "수락 기준", "1차/2차", "상태", "중요도", "Plane", "ID"], req_rows,
               [30, 60, 60, 8, 9, 8, 16, 11]),
              ("기능", CHILD_HEADERS, feat_rows, CHILD_WIDTHS), ("명세", CHILD_HEADERS, spec_rows, CHILD_WIDTHS)]
    rows_at = {}  # ID → (시트, 행)
    made = []
    for title, headers, rows, widths in sheets:
        ws, head = table_sheet(wb, title, headers, [[safe(v) for v in r] for r in rows], widths, top_rows=source)
        for i, r in enumerate(rows):
            rows_at[r[-1]] = (title, head + 1 + i)
        made.append((ws, head, rows))
    link = Font(name=FONT, size=10, color="0563C1", underline="single")
    wrap = Alignment(wrap_text=True, vertical="top")
    parents = {r[-1]: x for x in ({**{f["id"]: f for f in snap["features"]}, **{s["id"]: s for s in snap["specs"]}},)
               for r in feat_rows + spec_rows}
    for ws, head, rows in made:
        for i, r in enumerate(rows):
            for c in ws[head + 1 + i]:
                c.alignment = wrap
            item = parents.get(r[-1], {}).get(r[-1])
            pid = item and item["data"].get("parentId")
            if pid in rows_at:  # 상위 항목으로 링크
                title, row = rows_at[pid]
                c = ws.cell(head + 1 + i, 2)
                c.hyperlink = f"#'{title}'!A{row}"
                c.font = link
    policy, head_row = [], None
    for r in snap["requirements"]:
        for t in split_tables(r["data"].get("description", ""))[1]:
            head_row = head_row or t[0]
            policy += [[r["data"].get("name", "")] + row for row in t[1:]]
    if policy:
        ws, head = table_sheet(wb, "정책 표", ["요구사항"] + (head_row or []), [[safe(v) for v in r] for r in policy],
                               [26, 18, 22, 80], top_rows=[("원본", "요구사항 설명 안의 정책 표(Manyfast 원문의 표를 칸으로 풀었다)")])
        for i, r in enumerate(policy):
            c = ws.cell(head + 1 + i, 1)
            c.hyperlink = f"#'요구사항'!A{rows_at[next(x['id'] for x in snap['requirements'] if x['data'].get('name') == r[0])][1]}"
            c.font = link
            for c in ws[head + 1 + i]:
                c.alignment = wrap
    path = save_xlsx(wb, doc_name, f"{doc_no}_{doc_name}.xlsx")
    record_basis("REQ", version, path, basis(snap))
    return path, len(req_rows), len(feat_rows), len(spec_rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    path, r, f, s = write(ap.parse_args().version)
    print(f"{path}\n요구사항 {r} · 기능 {f} · 명세 {s}")


if __name__ == "__main__":
    main()
