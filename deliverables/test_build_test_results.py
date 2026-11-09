"""테스트 결과서 자체 검사 — .venv/bin/python test_build_test_results.py

1) 작은 입력으로 정리 · 집계 · 사유 고르기를 확인하고, 2) 실제 결과 파일의 숫자와 문서의 숫자가 같은지, 표에 내부 표지 · 절대경로가 없는지 본다.
"""
import json

from openpyxl import load_workbook

import build_test_results as B

# 정리: 일감 · 쟁점 · 이메일은 지우거나 바꾸고, 운영 정책 인용 · 파일 이름은 남긴다
assert B.clean("동시 등록 (WHALEERP-615)") == "동시 등록"
assert B.clean("수락 — ATT-30 뒤 운영 정책 ATT-25") == "수락 — 뒤 운영 정책 ATT-25"
assert B.clean("a@corp.co.kr 와 01012345678") == "a@example.com 와 01012345678"
assert B.leaks("test/contracts.e2e-spec.ts") == []
assert B.leaks("3팀 WHALEERP-1 /Users/x")
assert B.leaks("작성 jyKim")

# 오류 줄이기: 실행마다 달라지는 값을 뺀다
assert B.error_of("Foreign key constraint violated on the constraint: `a_fkey`") == B.FK_VIOLATION
assert B.error_of("connect ECONNREFUSED 127.0.0.1:59644") == "connect ECONNREFUSED 127.0.0.1"
assert B.error_of("expect(x).toBe(y)\n\nExpected: 403\nReceived: 400\n  at z") == "Expected: 403 / Received: 400"

# jest 결과 읽기: 테스트 밖 실패와 건너뜀
tests = [{"status": "passed", "fullName": "가"}, {"status": "pending", "fullName": "나", "location": {"line": 1}}]
root = B.tempfile.mkdtemp()
B.os.makedirs(B.os.path.join(root, "test"))
open(B.os.path.join(root, "test", "a.e2e-spec.ts"), "w", encoding="utf-8").write("onRealPostgres('나', async () => {});\n")
suites, failures, skips = B.parse_jest({"testResults": [{"name": B.os.path.join(root, "test", "a.e2e-spec.ts"), "status": "failed",
                                                         "assertionResults": tests, "message": "Foreign key constraint violated"}]},
                                       "API", "e2e", root, ["a"])
assert (suites[0]["total"], suites[0]["passed"], suites[0]["skipped"], suites[0]["area"], suites[0]["suiteError"]) == (2, 1, 1, "a", B.HOOK_FAILED)
assert failures[0]["test"] == B.HOOK_FAILED and failures[0]["error"] == B.FK_VIOLATION
assert skips[0]["reason"] == B.SKIP_REASONS[0][1]

# 사유 고르기: 스위트와 오류 모양이 모두 맞아야 납품 문체 사유를 쓴다
known = {"kind": "e2e", "suite": "test/bp-profile.e2e-spec.ts", "error": B.FK_VIOLATION}
assert B.plan_of(known)[1] == "제품 동작 영향 없음"
assert B.plan_of({**known, "error": "다른 오류"})[0].startswith("원인 미분석")
assert B.detail_rows({"failures": [], "skips": []})[0][0] == "없음"

# 실제 결과 파일과 문서
path, snap = B.write("1.0")
wb = load_workbook(path)
assert wb.sheetnames[-3:] == ["요약", "스위트별", "실패 · 제외 목록"]


def body(name):
    ws = wb[name]
    head = next(r for r in range(1, ws.max_row + 1) if ws.cell(r, 1).value == ("구분" if name.startswith("실패") else "저장소"))
    return [[ws.cell(r, c).value for c in range(1, ws.max_column + 1)] for r in range(head + 1, ws.max_row + 1)]


summary, suite_sheet, details = body("요약"), body("스위트별"), body("실패 · 제외 목록")
for k, row in zip(snap["kinds"], summary):
    assert row[:2] == [k["repo"], B.KINDS[k["kind"]]]
    assert row[2:6] == ([k["total"], k["passed"], k["failed"], k["skipped"]] if k["available"] else ["없음"] * 4), row
    assert row[7] == snap["commits"][k["repo"]][:8]
assert len(suite_sheet) == len(snap["suites"])
for k in snap["kinds"]:
    if k["kind"] in ("unit", "e2e") and k["available"]:
        rows = [r for r, s in zip(suite_sheet, snap["suites"]) if s["repo"] == k["repo"] and s["kind"] == k["kind"]]
        assert sum(r[3] for r in rows) == k["total"] and sum(r[4] for r in rows) == k["passed"]
assert len(details) == max(1, len(snap["failures"]) + len(snap["skips"]))
assert not [x for ws in (summary, suite_sheet, details) for r in ws for v in r for x in B.leaks(v)]

raw = open(B.SNAPSHOT, encoding="utf-8").read()
assert not B.ABS_PATH.search(raw) and not B.PHONE.search(raw)
assert "testResults" not in json.loads(raw)
print(f"ok — 스위트 {len(snap['suites'])} · 실패 {len(snap['failures'])} · 제외 {len(snap['skips'])}")
