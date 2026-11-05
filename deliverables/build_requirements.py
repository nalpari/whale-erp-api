"""요구사항정의서(WHALE-REQ) — sources/manyfast.json(Manyfast 스냅숏)을 엑셀로 낸다.

    .venv/bin/python build_requirements.py --version 1.0

PRD 는 빼고 요구사항 → 기능 → 명세만 싣는다. 값은 Manyfast 에 있는 것만 옮긴다. 이 문서는 추적용이라 API 명세의
내부 표지 제외 규칙은 쓰지 않는다. 예시 이메일 · 휴대전화번호만 example.com · 01012345678 로 바꿔 쓴다.
"""
import argparse
import json
import os
import re

from openpyxl.styles import Alignment, Font

from common import FONT, HERE, open_xlsx, save_xlsx, table_sheet

SNAPSHOT = os.path.join(HERE, "sources", "manyfast.json")
SLOTS = [("preconditions", "전제 조건"), ("trigger", "트리거"), ("action", "동작"), ("outcome", "결과"),
         ("exceptions", "예외"), ("display", "표시"), ("permissions", "권한"), ("rules", "규칙"), ("dataSpec", "데이터")]
PROGRESS = {"todo": "할 일", "in_progress": "진행 중", "inProgress": "진행 중", "done": "완료", "blocked": "차단됨"}
IMPORTANCE = {"high": "높음", "medium": "보통", "low": "낮음"}
PLANE = re.compile(r"WHALEERP-\d+")
PHASE = re.compile(r"\[([12])차\]")
EMAIL = re.compile(r"([\w.*+-]+)@(?!example\.com\b)[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<!\d)01[016789]-?\d{3,4}-?\d{4}(?!\d)")


def safe(text):
    """예시 이메일 · 휴대전화번호를 문서용 값으로 바꾼다."""
    if not isinstance(text, str):
        return text
    text = EMAIL.sub(r"\1@example.com", text)
    return PHONE.sub(lambda m: "010-1234-5678" if "-" in m.group() else "01012345678", text)


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
    return ", ".join(dict.fromkeys(m for t in texts(data) for m in PLANE.findall(t)))


def phase(data):
    """Manyfast 에 차수 칸이 없어, 이름에 [1차] · [2차] 표시가 있을 때만 적는다."""
    m = PHASE.search(data.get("name", ""))
    return f"{m.group(1)}차" if m else ""


def slot_values(data):
    slots = data.get("slots") or {}
    return [(slots.get(k) or {}).get("value") or "" for k, _ in SLOTS]


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
    name = {x["id"]: x["data"].get("name", "") for x in reqs + feats + specs}

    def common(x):
        d = x["data"]
        return [phase(d), PROGRESS.get(d.get("progress"), d.get("progress") or ""),
                IMPORTANCE.get(d.get("importance"), d.get("importance") or "")]

    req_rows = [[r["data"].get("name", ""), r["data"].get("description", ""),
                 "\n".join(("[완료] " if a.get("isDone") else "") + a.get("description", "")
                           for a in r["data"].get("acceptanceCriteria") or [])]
                + common(r) + [plane(r["data"]), r["id"]] for r in reqs]

    def child(x):
        d = x["data"]
        return ([d.get("name", ""), name.get(d.get("parentId"), d.get("parentId") or ""), d.get("description", ""),
                 d.get("rationale", ""), d.get("successCriteria", "")] + common(x) + slot_values(d)
                + [plane(d), x["id"]])

    return req_rows, [child(f) for f in feats], [child(s) for s in specs], {x["id"]: x for x in reqs + feats + specs}


CHILD_HEADERS = (["이름", "상위", "설명", "근거", "성공 기준", "1차/2차", "상태", "중요도"]
                 + [label for _, label in SLOTS] + ["Plane", "ID"])
CHILD_WIDTHS = [30, 26, 50, 40, 30, 8, 9, 8] + [44] * len(SLOTS) + [16, 11]


def write(version):
    """엑셀을 쓰고 (경로, 요구사항 수, 기능 수, 명세 수) 를 돌려준다."""
    snap = json.load(open(SNAPSHOT, encoding="utf-8"))
    req_rows, feat_rows, spec_rows, _ = build(snap)
    counts = snap.get("totalCounts") or {}
    for key, rows in (("requirements", req_rows), ("features", feat_rows), ("specs", spec_rows)):
        if counts.get(key) is not None and counts[key] != len(rows):
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
    path = save_xlsx(wb, doc_name, f"{doc_no}_{doc_name}.xlsx")
    return path, len(req_rows), len(feat_rows), len(spec_rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    path, r, f, s = write(ap.parse_args().version)
    print(f"{path}\n요구사항 {r} · 기능 {f} · 명세 {s}")


if __name__ == "__main__":
    main()
