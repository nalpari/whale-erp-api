"""화면설계서 자체 검사 — .venv/bin/python test_build_screens.py

1) 납품본 점검 규칙을 작은 예로 확인하고, 2) 실제 데이터로 화면 수 = 문서 절 수, 이미지 빠짐 0, 메뉴 대비 화면, 제외 목록, 내부 표시 0 을 본다.
설명 행이 비어 있는 동안(1단계)은 --draft 로만 생성되는지도 본다.
"""
import json
import os

from docx import Document

import build_screens as B

L = B.leaks
assert L("ATT-2 좌표") and L("(CONFIG-3)") and L("쟁점") and L("1팀") and L("WHALEERP-12") and L("김민식")
assert L("Manyfast") and L("whale-erp-front") and L("협의 전 미정") and L("real@naver.com") and L("010-2841-7702")
for ok in ("운영 정책 ATT-25", "미정산 없음", "SCR-ADM-001", "WHALE-SCR-1.0", "a@example.com로", "010-1234-5678", "TO-DO 기록"):
    assert not L(ok), (ok, L(ok))
assert L("시간 미정 뒤 협의") == ["미결 메모: 협의"]
assert not L("시간 미정") and not L("검토 중", "staff/payslips.html") and L("검토 중", "staff/index.html")

assert B.row_cells({"zone": "목록", "element": "표", "action": "연다", "policies": ["ACC-11", "CTR-19"]})[3] == "운영 정책 ACC-11, 운영 정책 CTR-19"
assert B.row_cells({"zone": "목록", "element": "표", "action": "연다", "policies": []})[3] == "-"
try:
    B.row_cells({"zone": "", "element": "", "action": "", "policies": ["ATT-999"]})
    raise AssertionError("없는 운영 정책 번호가 통과했다")
except SystemExit:
    pass

all_screens = B.screens()
ids = [s["id"] for _, s in all_screens]
assert len(ids) == len(set(ids)), "화면 번호 중복"
assert all(s["images"] and all(os.path.exists(os.path.join(B.IMG, n)) for n in s["images"]) for _, s in all_screens)
names = {n for _, s in all_screens for n in s["images"]}
assert names == set(os.listdir(B.IMG)), set(os.listdir(B.IMG)) ^ names
if os.path.exists(B.VISIBLE_JSON):  # --capture 를 돌린 뒤에만 있다(out/, 커밋하지 않음)
    visible = json.load(open(B.VISIBLE_JSON, encoding="utf-8"))
    assert set(visible) == set(ids) and all(visible.values())
    assert not [s["id"] for _, s in all_screens if L(visible[s["id"]], B.key_of(s))]
    assert not any("whale-2026" in t for t in visible.values()), "비밀번호 칸 값이 저장됐다"
    assert not any("이미 출근한 상태로" in t or "만료된 초대면?" in t for t in visible.values()), "데모 이동 버튼이 남음"
source = json.load(open(B.SOURCE_JSON, encoding="utf-8"))
assert all(len(source[k]["commit"]) == 40 for k in B.REPOS)
excluded = json.load(open(B.EXCLUDED_JSON, encoding="utf-8"))
assert all(excluded.values()) and not set(excluded) & {B.key_of(s) for _, s in all_screens}

blank = [s["id"] for _, s in all_screens if not s["rows"]]
path, total, images, (leaves, active, empty) = B.write("1.0", draft=True)
assert total == len(ids) and empty == len(blank) and images == len(names)
if blank:  # 1단계: 설명 행이 비면 --draft 없이는 멈춘다
    try:
        B.write("1.0")
        raise AssertionError("설명 표가 빈 채로 생성됐다")
    except SystemExit:
        pass
doc = Document(path)
h3 = [p.text for p in doc.paragraphs if p.style.name == "Heading 3"]
assert h3 == [f"{s['id']} {s['name']}" for _, s in all_screens], "화면 절이 다르다"
assert len(doc.inline_shapes) == images, (len(doc.inline_shapes), images)
texts = [p.text for p in doc.paragraphs] + [c.text for t in doc.tables for r in t.rows for c in r.cells]
assert not [x for t in texts for x in L(t)]
covered = {s.get("menuCode") for _, s in all_screens}
assert not [p for c, p, st in B.menu_tree() if st == "ACTIVE" and c not in covered]
print(f"ok — 화면 {total} · 이미지 {images} 빠짐 0 · 말단 메뉴 {leaves}(사용 {active}, 모두 화면 있음) · 설명 빈 화면 {empty}")
