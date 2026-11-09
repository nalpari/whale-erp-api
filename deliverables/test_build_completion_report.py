"""완료보고서 자체 검사 — .venv/bin/python test_build_completion_report.py

작은 입력으로 영역 표 · 실패 묶음 · 납품본 점검을 확인하고, 실제 문서의 숫자가 원본과 같은지 본다.
"""
import json
import os
import tempfile

from docx import Document

import build_completion_report as R


def stops(fn, *args):
    try:
        fn(*args)
    except SystemExit:
        return True
    return False


def menu(i, name, parent=None, status="ACTIVE"):
    return {"menu_id": i, "name": name, "parent_menu_id": parent, "status": status, "is_deleted": False}


# 영역 표: 사용 메뉴만 세고, 영역과 이어지지 않은 사용 메뉴가 있으면 멈춘다
menus = [menu(1, "직원관리"), menu(2, "직원 목록", 1), menu(3, "숨김", 1, "INACTIVE"), menu(4, "재무관리", None, "INACTIVE")]
areas = [{"client": "admin", "area": "직원관리", "screens": [1, 2]}, {"client": "staff", "area": "홈", "screens": [1]}]
assert R.scope_rows(menus, areas) == ([["관리자 웹", "직원관리", 2, 2], ["직원 근무 앱", "홈", 1, "-"]], 2)
assert stops(R.scope_rows, menus + [menu(5, "고객지원")], areas)

# 실패 묶음: 오류 하나하나를 세고 규칙 이름까지만 적는다
snap = {"kinds": [{"repo": "관리자 웹", "kind": "lint", "available": True, "failed": 1, "skipped": 0},
                  {"repo": "API", "kind": "e2e", "available": True, "failed": 1, "skipped": 1}],
        "suites": [{"repo": "API", "kind": "e2e", "suiteError": ""}],
        "failures": [{"repo": "관리자 웹", "kind": "lint", "suite": "a", "test": "rule-x:1", "error": "긴 문장"},
                     {"repo": "관리자 웹", "kind": "lint", "suite": "a", "test": "rule-x:9", "error": "다른 문장"},
                     {"repo": "API", "kind": "e2e", "suite": "c", "test": "x", "error": "오류"}],
        "skips": [{"repo": "API", "kind": "e2e", "suite": "b", "test": "t", "reason": "사유"}]}
groups = R.failure_groups(snap)
assert [(k[0], k[1], n) for k, n in groups] == [("실패", "관리자 웹", 2), ("실패", "API", 1), ("제외", "API", 1)], groups
assert groups[0][0][3] == "린트 오류: rule-x"
assert stops(R.failure_groups, {**snap, "failures": snap["failures"][:2]})  # 실패가 목록에서 빠지면 멈춘다
assert stops(R.failure_groups, {**snap, "skips": []})

# 납품본 점검: 하나씩 잡는다. 문서 번호와 새 상태 이름은 잡지 않는다.
for bad in ("쟁점", "ATT-5", "1팀", "재영", "WHALEERP-659", "#263", "Manyfast", "미정", "a@b.co.kr", "01099998888",
            "/Users/x", "whale-erp-api", "whale-erp-v2", "src/modules/foo", "docs/plans/a.md", "prisma/schema.prisma",
            "manyfast.json", "github", "Notion", "TODO:", "추후 결정", "010 9999 8888", "+82-10-9999-8888",
            "{{문서명}}", "임시저장", "서명 대기", "서명대기", "승인 대기"):
    assert R.leaks([bad]), bad
assert not R.leaks(["WHALE-RPT-1.0", "직원 서명 대기", "미정산 탈퇴 조건", "담당 영역에서 시험 수정", "소속 승인 대기", "TO-DO",
                    "react-hooks/rules-of-hooks", "법무", "1차 범위"])

# 낡은 메뉴 스냅숏은 --draft 없이는 멈춘다
source = json.load(open(R.MENU.SNAPSHOT, encoding="utf-8"))
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "menus.json")
    json.dump({**source, "lastMigration": "0_old"}, open(path, "w", encoding="utf-8"))
    original, R.MENU.SNAPSHOT = R.MENU.SNAPSHOT, path
    assert stops(R.menu_snapshot, False) and R.menu_snapshot(True)
    R.MENU.SNAPSHOT = original

# 실제 문서: 산출물 9종, 실패 · 제외 건수, 집계가 원본과 같다
out, info = R.write("1.0", draft=True)
doc = Document(out)
assert not R.leaks(R.all_text(doc))
tests = json.load(open(R.TEST.SNAPSHOT, encoding="utf-8"))
assert info["fails"] == len(tests["failures"]) and info["skips"] == len(tests["skips"])
assert len(info["docs"]) == 9
rows = {tuple(c.text for c in r.cells) for t in doc.tables for r in t.rows}
for k in tests["kinds"]:
    if k["available"]:
        cells = (k["repo"], R.TEST.KINDS[k["kind"]], str(k["total"]), str(k["passed"]), str(k["failed"]), str(k["skipped"]), k["note"])
        assert cells in rows, cells
req = json.load(open(R.REQ.SNAPSHOT, encoding="utf-8"))["totalCounts"]
assert any(r[1] == f"요구사항 {req['requirements']} · 기능 {req['features']} · 명세 {req['specs']}" for r in rows)
assert any(r[1] == f"규칙 {R.POL.RULES}" for r in rows)
print(f"ok — 산출물 {len(info['docs'])} · 실패 {info['fails']} · 제외 {info['skips']}")
