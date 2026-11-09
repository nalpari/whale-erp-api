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
assert B.error_of("connect ECONNREFUSED 127.0.0.1:59644") == B.ENV_PREFIX + "ECONNREFUSED"
assert B.error_of("Error: boom on localhost:5432") == "Error: boom on localhost"
assert B.error_of(B.suite_block("  ● Test suite failed to run\n\n    TypeError: x is not a function\n\n  ● 다른 시험\n\n    Error: y")) == "TypeError: x is not a function"
assert B.error_of("  ● Test suite failed to run\n\n    PrismaClientKnownRequestError:\n\n    Invalid call").startswith("Invalid call")

# 접속 대상 판정: 실제 DB 에는 접속하지 않고 판정만 본다
for ok in ("postgresql://u:p@localhost:5432/d", "postgres://u:p@127.0.0.1/d", "postgresql://u:p@[::1]:5432/d",
           "postgresql://u:p@localhost/d?host=localhost", "postgresql:///d?host=127.0.0.1", "postgresql://u:p@LOCALHOST/d?sslmode=disable"):
    assert B.local_db(ok), ok
for bad in ("", "postgresql://u:p@db.example.com/d", "postgresql://u:p@localhost/d?host=db.example.com", "postgresql://u:p@localhost/d?HOST=db.example.com",
            "postgresql://u:p@localhost/d?hostaddr=10.0.0.5", "postgresql://u:p@localhost,db.example.com/d", "postgresql://u:p@localhost:1,localhost:2/d",
            "postgresql://u:p@localhost/d?host=localhost,db.example.com", "postgresql://u:p@localhost/d?host=localhost&host=db.example.com",
            "postgresql://u:p@localhost/d?host=db%2Eexample%2Ecom", "postgresql://u:p@localhost.example.com/d", "postgresql://u:p@localhost/d?service=prod",
            "postgresql:///d", "postgresql://u:p@localhost/d?host=/var/run/postgresql", "mysql://u:p@localhost/d", "postgresql://localhost\\@db.example.com/d"):
    assert not B.local_db(bad), bad

# 치환한 뒤에 자른다. 잘린 경로 조각이 남지 않는다
long = "x" * 195 + " /Users/someone/repo/secret.ts"
assert "/Use" not in B.short(long) and "/Users" not in B.short("y /var/folders/ab/c 그리고 postgresql://u:p@h/d")
assert "(접속 문자열)" in B.short("postgresql://u:p@h/d 실패")

# 납품 점검: 파일 이름 안의 일감 · 쟁점 번호, 경로, 접속 문자열
assert B.leaks("test/WHALEERP-12.e2e-spec.ts") and B.leaks("src/a/ATT-3-row.test.ts") and B.leaks("src/a/x-ATT-3.test.ts")
assert B.leaks("/var/folders/ab/c") and B.leaks("~/repo") and B.leaks("postgresql://u:p@localhost/d")
assert not B.leaks("src/app/home/one-store-view.test.ts")
sheet = load_workbook(B.os.path.join(B.HERE, "templates", "template.xlsx"))
sheet["개정 이력"].append(["1.0", "2026-11-09", "3팀 수정", "인터플러그"])
assert "3팀" in B.sheet_leaks(sheet)
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

# 실패한 시험이 있어도 스위트 오류(afterAll)를 싣고, 머리글이 아닌 실제 오류 줄을 쓴다
mixed = [{"status": "failed", "fullName": "다", "failureMessages": ["Expected: 1\nReceived: 2"]}]
s2, f2, _ = B.parse_jest({"testResults": [{"name": B.os.path.join(root, "test", "a.e2e-spec.ts"), "status": "failed", "assertionResults": mixed,
                                           "message": "  ● 다\n\n    Expected: 1\n\n  ● Test suite failed to run\n\n    TypeError: 정리 실패\n"}]},
                         "API", "e2e", root, ["a"])
assert s2[0]["suiteError"] == B.HOOK_FAILED and [x["test"] for x in f2] == ["다", B.HOOK_FAILED] and f2[1]["error"] == "TypeError: 정리 실패"
s3, f3, _ = B.parse_jest({"testResults": [{"name": B.os.path.join(root, "test", "a.e2e-spec.ts"), "status": "failed", "assertionResults": mixed,
                                           "message": "  ● 다\n\n    Expected: 1\n"}]}, "API", "e2e", root, ["a"])
assert s3[0]["suiteError"] == "" and len(f3) == 1

# node:test: describe 훅 실패 · 파일 수준 실패(이름이 절대경로) · 묶음의 시험 실패
F = B.os.path.join(root, "src", "a", "x.test.ts")
ev = [{"status": "pass", "name": "통과", "file": F, "type": "test", "skip": None, "todo": None, "failureType": None, "error": None},
      {"status": "fail", "name": "묶음", "file": F, "type": "suite", "skip": None, "todo": None, "failureType": "hookFailed", "error": "after boom"},
      {"status": "fail", "name": "시험 실패 묶음", "file": F, "type": "suite", "skip": None, "todo": None, "failureType": "subtestsFailed", "error": "x"},
      {"status": "fail", "name": F, "file": F, "type": "test", "skip": None, "todo": None, "failureType": "testCodeFailure", "error": "load boom"},
      {"diagnostic": "tests 2"}, {"diagnostic": "fail 1"}]
s4, f4, _, st = B.parse_node(ev, "관리자 웹", root)
assert (s4[0]["total"], s4[0]["failed"], st["tests"]) == (2, 1, 2) and s4[0]["suiteError"]
assert [x["test"] for x in f4] == [f"{B.HOOK_FAILED} 묶음", B.SUITE_FAILED] and not B.leaks(f4[1]["test"])

# 환경 오류가 대부분이면 멈춘다. 평소의 실패는 그대로 둔다
def stops(*a):
    try:
        B.assert_real_failures("API", "e2e", *a)
    except SystemExit:
        return True
    return False
good = [{"failed": 0, "suiteError": ""}] * 9 + [{"failed": 1, "suiteError": ""}]
assert not stops(good, [{"error": "Expected: 403 / Received: 400"}])
assert stops(good, [{"error": B.ENV_PREFIX + "ECONNREFUSED"}] * 5 + [{"error": "x"}])
assert stops([{"failed": 1, "suiteError": ""}] * 6 + [{"failed": 0, "suiteError": ""}] * 4, [{"error": "x"}] * 6)
assert not stops(good, [{"error": B.ENV_PREFIX + "ECONNREFUSED"}])

# 사유 고르기: 스위트와 오류 모양이 모두 맞아야 납품 문체 사유를 쓴다
known = {"kind": "e2e", "suite": "test/bp-profile.e2e-spec.ts", "test": B.HOOK_FAILED, "error": B.FK_VIOLATION}
assert B.plan_of(known)[1] == "제품 동작 영향 없음"
for other in ({"error": "다른 오류"}, {"test": "새로 실패한 시험"}, {"test": B.SUITE_FAILED}):
    assert B.plan_of({**known, **other})[0].startswith("원인 미분석") and B.plan_of({**known, **other})[1] == "미확인"
assert B.detail_rows({"failures": [], "skips": [{"repo": "관리자 웹", "suite": "a", "test": "b", "reason": "다른 사유"}]})[0][-1] == "사유 확인"
assert B.detail_rows({"failures": [], "skips": [{"repo": "API", "suite": "a", "test": "b", "reason": B.SKIP_REASONS[0][1]}]})[0][-1] == "해당 환경값을 준 별도 실행으로 확인"
assert B.detail_rows({"failures": [], "skips": []})[0][0] == "없음"

# 실제 결과 파일과 문서
path, snap = B.write("1.0")
assert all(B.plan_of(f)[1] == "제품 동작 영향 없음" for f in snap["failures"] if f["kind"] == "e2e")  # 실제 이름 · 오류와 표가 맞는다
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
