"""요구사항정의서 자체 검사 — .venv/bin/python test_build_requirements.py

1) 작은 스냅숏으로 순서 · 칸을 확인하고, 2) 실제 스냅숏의 항목 수와 시트 줄 수가 같은지,
3) 스냅숏 원문 문자열이 잘리지 않고 셀에 통째로 있는지 본다.
"""
import re

from openpyxl import load_workbook

import build_requirements as B

snap = {"requirements": [{"id": "R-1", "data": {"name": "직원", "description": "설명", "importance": "high",
                                                "progress": "todo", "features": ["F-1"],
                                                "acceptanceCriteria": [{"description": "a", "isDone": True},
                                                                       {"description": "b", "isDone": False}]}}],
        "features": [{"id": "F-1", "data": {"parentId": "R-1", "name": "[2차] 초대", "description": "WHALEERP-12 참고",
                                            "specs": ["S-1"], "slots": {"rules": {"applicability": "active",
                                                                                   "value": "규칙"},
                                                                         "trigger": {"applicability": "na"}},
                                            "devices": ["W", "A"]}}],
        "specs": [{"id": "S-1", "data": {"parentId": "F-1", "name": "발송", "progress": "done",
                                         "description": "(WHALEERP-261 · 321, 2026-10-28) WHALEERP-280·281·282"}}],
        "devices": {"W": "웹", "A": "직원 근무 앱"}}
reqs, feats, specs, _ = B.build(snap)
assert reqs == [["직원", "설명", "[완료] a\nb", "", "할 일", "높음", "", "R-1"]]
assert feats[0][:7] == ["[2차] 초대", "직원", "WHALEERP-12 참고", "", "", "2차", ""] and feats[0][-2:] == ["WHALEERP-12", "F-1"]
assert feats[0][8] == "웹, 직원 근무 앱" and feats[0][9 + 1] == "해당 없음" and feats[0][9 + 7] == "규칙"
assert specs[0][1] == "[2차] 초대" and specs[0][6] == "완료" and specs[0][9 + 1] == ""
assert specs[0][-2] == "WHALEERP-261, WHALEERP-321, WHALEERP-280, WHALEERP-281, WHALEERP-282", specs[0][-2]
rest, tables = B.split_tables("앞 글\n\n<table><tbody><tr><th><p>구분</p></th><th><p>기준</p></th></tr>"
                               "<tr><td><p>가</p><p>나</p></td><td><p>다</p></td></tr></tbody></table>\n\n"
                               "| 구분 | 기준 |\n| --- | --- |\n| 라 | 마 |\n뒤 글")
assert tables == [[["구분", "기준"], ["가\n나", "다"]], [["구분", "기준"], ["라", "마"]]], tables
_, t = B.split_tables("| 머리 |\n| --- |\n| 첫 |\n중간\n<table><tr><th>앞<p>p1</p>x<br>y</th><th colspan=\"2\">넓음</th></tr>"
                      "<tr><td rowspan=\"2\">길게</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>")
assert t[0] == [["머리"], ["첫"]], t  # 본문 순서: 마크다운이 먼저
assert t[1] == [["앞\np1\nx\ny", "넓음", "넓음"], ["길게", "b", "c"], ["길게", "d", "e"]], t[1]
assert rest == "앞 글\n\n(정책 표 1줄은 「정책 표」 시트)\n\n(정책 표 1줄은 「정책 표」 시트)\n뒤 글", rest
assert B.safe("hong@gmail.com · 01098765432 · 010-9876-5432") == "hong@example.com · 01012345678 · 010-1234-5678"

from openpyxl import Workbook
wb0 = Workbook()
wb0.active["A1"] = "=SUM(1,2)"
tmp = B.save_xlsx(wb0, "검사", "_formula_check.xlsx")
assert load_workbook(tmp).active["A1"].data_type == "s"  # = 로 시작해도 수식이 아니라 글자
B.os.remove(tmp)

path, r, f, s = B.write("1.0")
snapshot = B.json.load(open(B.SNAPSHOT, encoding="utf-8"))
wb = load_workbook(path)
for title, key, n in (("요구사항", "requirements", r), ("기능", "features", f), ("명세", "specs", s)):
    ws = wb[title]
    head = next(i for i in range(1, ws.max_row + 1) if ws.cell(i, 1).value == "이름")
    lines = sum(1 for i in range(head + 1, ws.max_row + 1) if ws.cell(i, ws.max_column).value)
    assert len(snapshot[key]) == snapshot["totalCounts"][key] == n == lines, (title, len(snapshot[key]), lines)

# 잘린 본문이 없다: 스냅숏의 모든 본문 문자열(코드값 칸 제외)이 공백 정규화 뒤 어느 셀엔가 통째로 있다
SKIP = {"parentId", "applicability", "progress", "importance", "devices", "roles", "specs", "features"}


def bodies(x, key=None):
    if isinstance(x, str):
        if key not in SKIP and x.strip():
            rest, tables = B.split_tables(x)  # 정책 표는 칸으로 풀어 「정책 표」 시트에 싣는다
            yield from [rest] + [c for t in tables for row in t for c in row]
    elif isinstance(x, dict):
        for k, v in x.items():
            yield from bodies(v, k)
    elif isinstance(x, list):
        for v in x:
            yield from bodies(v, key)


cells = "\0".join(" ".join(str(c.value).split()) for w in wb.worksheets for row in w.iter_rows() for c in row if c.value)
wanted = {" ".join(B.safe(t).split()) for k in ("requirements", "features", "specs") for it in snapshot[k]
          for t in bodies(it["data"])}
missing = [t for t in wanted if t not in cells]
assert not missing, f"셀에 없는 본문 {len(missing)}건: {[m[:60] for m in missing[:3]]}"
by_name = {it["data"]["name"]: it for k in ("features", "specs") for it in snapshot[k]}
assert {"WHALEERP-282", "WHALEERP-283", "WHALEERP-284"} <= set(B.plane(by_name["지원 현황 조회와 문의사항 등록"]["data"]).split(", "))
assert {"WHALEERP-266", "WHALEERP-321"} <= set(B.plane(by_name["직원 알림"]["data"]).split(", "))
na = sum(1 for w in ("기능", "명세") for row in wb[w].iter_rows(values_only=True) for v in row if v == "해당 없음")
want_na = sum(1 for k in ("features", "specs") for it in snapshot[k] for v in (it["data"].get("slots") or {}).values()
              if v.get("applicability") == "na" and not v.get("value"))
assert na == want_na, (na, want_na)
tags = re.findall(r"</?(?:table|tbody|tr|td|th|p|col|colgroup)\b[^>]*>", cells)
assert not tags, f"HTML 태그가 남음: {tags[:3]}"
policy = wb["정책 표"]
phead = next(i for i in range(1, policy.max_row + 1) if policy.cell(i, 1).value == "요구사항")
policy_rows = sum(1 for row in policy.iter_rows(min_row=phead + 1, values_only=True) if row[0])
want_rows = sum(len(t) - 1 for it in snapshot["requirements"] for t in B.split_tables(it["data"]["description"])[1])
assert policy_rows == want_rows, (policy_rows, want_rows)
emails = set(re.findall(r"[\w.*+-]+@[\w.-]+\.[A-Za-z]{2,}", cells))
assert all(e.endswith("@example.com") for e in emails), emails
print(f"ok — 요구사항 {r} · 기능 {f} · 명세 {s} = Manyfast 항목 수 · 본문 {len(wanted)}건 잘림 없음 · 정책 표 {policy_rows}줄 · HTML 태그 0 · 해당 없음 {na}칸")
