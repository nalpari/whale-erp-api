"""테스트 결과서(WHALE-TEST) — 세 저장소의 시험 · 타입 · 린트를 실제로 돌린 결과(sources/test_results.json)를 엑셀로 낸다.

    E2E_DATABASE_URL=<localhost 일회용 DB> .venv/bin/python build_test_results.py --run --front <경로> --staff <경로>
    .venv/bin/python build_test_results.py --version 1.0

일회용 DB 를 띄우는 명령은 계획 문서의 「다시 뜨는 법」에 있다. 숫자를 손으로 적지 않는다. 표에 넣는 글에 내부 표지가 남으면 멈춘다.
"""
import argparse
import base64
import datetime
import json
import os
import re
import secrets
import subprocess
import tempfile
from urllib.parse import parse_qs, unquote, urlparse, urlsplit

from build_userflow import ISSUE, strip_issue
from common import EMAIL, HERE, INTERNAL, PHONE, TEAM, TEAM_NAMES, open_xlsx, record_basis, safe, save_xlsx, strip_records, table_sheet

SNAPSHOT = os.path.join(HERE, "sources", "test_results.json")
API = os.path.dirname(HERE)
KINDS = {"unit": "단위", "e2e": "e2e", "type": "타입", "lint": "린트"}
NOT_ALLOWED_DIRTY = (":!deliverables", ":!docs/plans")

# 앞 글자를 본다: 「src/app/home/…」 같은 상대 경로는 절대경로가 아니다
ABS_PATH = re.compile(r"(?<![\w.)\]-])(?:/(?:Users|private|home|tmp|var)/|~/)|\b[A-Za-z]:\\")
ABS_TOKEN = re.compile(r"(?<![\w.)\]-])(?:/(?:Users|private|home|tmp|var)/|~/)\S*|\b[A-Za-z]:\\\S*")
CONN_STRING = re.compile(r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://\S*")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
PACKAGES = {"관리자 웹": "whale-erp-front", "직원 근무 앱": "whale-erp-staff"}
# 소스 파일 이름은 스위트 칸에 그대로 싣는다. 이 칸에서는 파일 이름을 내부 표지로 보지 않는다.
SOURCE_FILE = re.compile(r"[\w./()\[\]-]+\.tsx?\b")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
FK_VIOLATION = "시험 정리 또는 저장 단계의 외래키 위반"
ENV_PREFIX = "환경 오류: "
ENV_ERROR = re.compile(r"ECONNREFUSED|ECONNRESET|ETIMEDOUT|Can't reach database|P100[01]|P1017|Authentication failed|"
                       r"server has closed the connection|Connection terminated|too many clients|database .* does not exist")
SUITE_HEADER = "Test suite failed to run"
HOOK_FAILED = "(시험 전후 처리 단계)"
SUITE_FAILED = "(스위트 실행 실패)"
NO_REASON = "코드에서 사유를 찾지 못함"

# 시험 위치의 코드에서 찾는 건너뜀 사유
SKIP_REASONS = [(re.compile(r"onRealPostgres|E2E_REAL_POSTGRES"),
                 "연결 두 개가 필요한 동시성 시험이라 별도 환경에서만 실행한다. 기본 실행에서 제외"),
                (re.compile(r"E2E_SINGLE_BACKEND"), "연결 하나짜리 시험 DB 에서는 동시 질의를 할 수 없어 별도 환경에서만 실행한다")]
ENV_SKIPS = {reason for _, reason in SKIP_REASONS}  # 환경값으로 켜고 끄는 건너뜀
# 스위트 · 테스트 이름 · 오류 모양이 모두 맞을 때만 쓰는 납품 문체 사유. (사유, 영향, 처리 계획). 스위트 단위 실패는 테스트 이름이 HOOK_FAILED 다.
KNOWN_FAILURES = {
    ("test/bp-code-groups.e2e-spec.ts", "BP 공통코드 관리 (e2e, DB) 대상 BP 플랫폼 사용자의 등록 · 수정 · 삭제는 메뉴 권한이 있어도 403",
     "Expected: 403 / Received: 400"):
        ("시험 요청 본문에 필수 값이 빠져 권한 판정 전에 입력 검증(400)에서 끝남", "제품 동작 영향 없음", "담당 영역에서 시험 수정"),
    ("test/bp-profile.e2e-spec.ts", HOOK_FAILED, FK_VIOLATION):
        ("시험 정리 순서로 외래키 위반. 시험 본문은 모두 통과", "제품 동작 영향 없음", "담당 영역에서 시험 수정"),
}

# 시험 이름마다 파일로 쓰는 node:test 보고기. 테스트 이름은 실패 · 건너뜀에만 쓰고 JSON 에 저장하지 않는다.
NODE_REPORTER = """
export default async function* (source) {
  for await (const ev of source) {
    if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const d = ev.data;
      const err = d.details?.error;
      yield JSON.stringify({ status: ev.type === 'test:pass' ? 'pass' : 'fail', name: d.name, file: d.file, line: d.line,
        type: d.details?.type ?? 'test', skip: d.skip ?? null, todo: d.todo ?? null, failureType: err?.failureType ?? null,
        error: err ? String(err.cause?.message ?? err.message) : null }) + '\\n';
    } else if (ev.type === 'test:diagnostic') {
      yield JSON.stringify({ diagnostic: ev.data.message }) + '\\n';
    }
  }
}
"""


# ── 납품본 정리 ──

def clean(text):
    """표에 넣는 글에서 내부 표지를 지운다. 파일 이름은 남긴다. 「운영 정책 …」 인용도 남는다(strip_issue)."""
    out = strip_records(strip_issue(" ".join((text or "").split())))
    out = INTERNAL.sub(lambda m: m.group() if SOURCE_FILE.fullmatch(m.group()) else "", out)
    return re.sub(r"\s+([.,)])", r"\1", TEAM.sub("", safe(out))).strip()


def leaks(text):
    """납품본에 남으면 안 되는 것. 소스 파일 이름은 표지로 보지 않는다."""
    if not isinstance(text, str):
        return []
    bare = re.sub(r"\.tsx?\b", "", text)  # 확장자만 뗀다. 파일 이름 안의 일감 · 쟁점 번호는 잡는다
    found = INTERNAL.findall(bare) + TEAM.findall(bare) + ISSUE.findall(bare) + TEAM_NAMES.findall(text)
    found += [issue for token in SOURCE_FILE.findall(text) for issue in re.findall(r"(?<![A-Za-z0-9])[A-Z]{2,}-\d+", token)]
    found += ABS_PATH.findall(text) + PHONE.findall(text) + CONN_STRING.findall(text)
    found += [m.group() for m in EMAIL.finditer(text)]
    return found


def sheet_leaks(wb):
    """표지 · 개정 이력 · 요약의 실행 환경 줄까지 모든 칸을 본다."""
    return sorted({x for ws in wb.worksheets for row in ws.iter_rows(values_only=True) for v in row for x in leaks(v)})


def error_of(message):
    """실패 메시지를 실행마다 같은 글로 줄인다(포트 · 제약 이름 제거). 머리글 대신 실제 오류 줄을 쓴다. 자르는 것은 short 가 한다."""
    text = ANSI.sub("", message or "")
    env = ENV_ERROR.search(text)
    if env:
        return ENV_PREFIX + env.group()
    if "Foreign key constraint violated" in text:
        return FK_VIOLATION
    m = re.search(r"Expected: (.+)\n\s*Received: (.+)", text)
    if m:
        return f"Expected: {m.group(1).strip()} / Received: {m.group(2).strip()}"
    line = next((x.strip() for x in text.splitlines() if x.strip() and not re.match(r"\s*(?:●|\w*Error:\s*$)", x)), "")
    return re.sub(r"(127\.0\.0\.1|localhost):\d+", r"\1", line)


def suite_block(message):
    """jest 메시지에서 「Test suite failed to run」 블록의 본문만 뗀다. 시험 실패 블록이 함께 있어도 섞지 않는다."""
    text = ANSI.sub("", message or "")
    if SUITE_HEADER not in text:
        return text
    body = text.split(SUITE_HEADER, 1)[1]
    return re.split(r"^\s*● ", body, maxsplit=1, flags=re.M)[0]


def short(message):
    """경로 · 접속 문자열을 먼저 치환하고 나서 자른다. 잘린 조각이 점검을 빠져나가지 않게 한다."""
    return clean(ABS_TOKEN.sub("(경로)", CONN_STRING.sub("(접속 문자열)", message or "")))[:200]


def local_db(url):
    """접속 대상이 이 컴퓨터뿐인가. 주소의 호스트와 쿼리의 host · hostaddr 를 모두 보고, 다중 호스트 · service · 소켓 경로는 막는다."""
    if not url or "\\" in url or re.search(r"\s", url):
        return False
    parts = urlsplit(url)
    if parts.scheme not in ("postgres", "postgresql"):
        return False
    authority = parts.netloc.rpartition("@")[2]
    query = {k.lower(): v for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
    if "service" in query:
        return False
    targets = [authority] if authority else []
    for key in ("host", "hostaddr"):
        targets += query.get(key, [])
    hosts = []
    for target in targets:
        target = unquote(target)
        if "," in target:
            return False
        hosts.append(re.sub(r"^\[(.*)\](?::\d+)?$|:\d+$", r"\1", target).lower())
    return bool(hosts) and all(h in LOCAL_HOSTS for h in hosts)


def assert_real_failures(repo, kind, suites, failures):
    """DB 가 죽은 실행처럼 환경 오류가 대부분이면 결과로 남기지 않는다."""
    env = sum(f["error"].startswith(ENV_PREFIX) for f in failures)
    bad = sum(1 for s in suites if s["failed"] or s["suiteError"])
    if (env >= 5 and env * 2 > len(failures)) or (suites and bad * 2 > len(suites)):
        raise SystemExit(f"{repo} {kind}: 환경 오류로 보이는 실패가 대부분입니다(환경 오류 {env}건, 실패 스위트 {bad}/{len(suites)}). 결과 파일을 덮어쓰지 않습니다.")


# ── 실행 ──

def run_env(database_url, jwt, data_key):
    """부모 환경을 물려주지 않는다. 메일 · 저장소 · 국세청 값은 넣지 않고, 알림톡은 닿지 않는 주소만 준다."""
    return {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "TERM": "dumb", "TZ": "Asia/Seoul", "APP_ENV": "test",
            "JWT_SECRET": jwt, "DATABASE_URL": database_url, "PERSONAL_DATA_ENCRYPTION_KEY": data_key,
            "AWS_SHARED_CREDENTIALS_FILE": os.devnull, "AWS_CONFIG_FILE": os.devnull, "AWS_EC2_METADATA_DISABLED": "true",
            "BIZPPURIO_BASE_URL": "https://bizppurio.invalid", "BIZPPURIO_ACCOUNT": "e2e", "BIZPPURIO_PASSWORD": "e2e",
            "BIZPPURIO_SENDER_KEY": "e2e", "BIZPPURIO_SMS_FROM": "0212345678"}


def sh(cmd, cwd, env):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=3600)


def check_repo(root):
    head = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
    main = subprocess.check_output(["git", "-C", root, "rev-parse", "origin/main"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", root, "status", "--porcelain", "--", ".", *NOT_ALLOWED_DIRTY], text=True).strip()
    if head != main or dirty:
        raise SystemExit(f"{os.path.basename(root)}: origin/main 커밋의 깨끗한 트리에서 돌려 주세요(변경 {len(dirty.splitlines())}줄).")
    return head


def area_of(repo, suite, src_dirs):
    parts = suite.split("/")
    if suite.startswith("test/"):
        stem = parts[-1].split(".")[0]
        return max((d for d in src_dirs if stem == d or stem.startswith(d + "-")), key=len, default="공통")
    if repo == "API":
        return parts[1] if len(parts) > 2 else "공통"
    return "/".join(parts[1:-1][:2]) or "공통"


def skip_reason(root, suite, line):
    """시험 줄과 그 파일의 건너뜀 선언에서 사유를 찾는다."""
    source = open(os.path.join(root, suite), encoding="utf-8").read().splitlines()
    near = source[line - 1] if line and line <= len(source) else ""
    for pattern, reason in SKIP_REASONS:
        if pattern.search(near):
            return reason
    return NO_REASON


def parse_jest(result, repo, kind, root, src_dirs):
    suites, failures, skips = [], [], []
    for f in sorted(result["testResults"], key=lambda r: r["name"]):  # jest 는 실행 순서로 내놓아 돌릴 때마다 달라진다
        suite = os.path.relpath(f["name"], root)
        tests = f["assertionResults"]
        counts = {s: sum(t["status"] == s for t in tests) for s in ("passed", "failed")}
        skipped = [t for t in tests if t["status"] in ("pending", "todo", "skipped", "disabled")]
        broken = f.get("status") == "failed" and (not counts["failed"] or SUITE_HEADER in ANSI.sub("", f.get("message") or ""))
        suites.append({"repo": repo, "kind": kind, "area": area_of(repo, suite, src_dirs), "suite": suite, "total": len(tests),
                       "passed": counts["passed"], "failed": counts["failed"], "skipped": len(skipped),
                       "suiteError": HOOK_FAILED if broken and tests else SUITE_FAILED if broken else ""})
        for t in tests:
            if t["status"] == "failed":
                failures.append({"repo": repo, "kind": kind, "suite": suite, "test": clean(t["fullName"]),
                                 "error": short(error_of("\n".join(t["failureMessages"])))})
        if broken:
            failures.append({"repo": repo, "kind": kind, "suite": suite, "test": HOOK_FAILED if tests else SUITE_FAILED,
                             "error": short(error_of(suite_block(f.get("message"))))})
        for t in skipped:
            skips.append({"repo": repo, "kind": kind, "suite": suite, "test": clean(t["fullName"]),
                          "reason": skip_reason(root, suite, (t.get("location") or {}).get("line"))})
    return suites, failures, skips


def run_jest(args, repo, kind, root, env, src_dirs, tmp):
    out = os.path.join(tmp, f"{kind}.json")
    proc = sh(["npx", "jest", *args, "--testLocationInResults", "--json", f"--outputFile={out}"], root, env)
    if not os.path.exists(out):
        raise SystemExit(f"{repo} {kind}: jest 결과 파일이 없습니다(exit {proc.returncode}).")
    result = json.load(open(out, encoding="utf-8"))
    suites, failures, skips = parse_jest(result, repo, kind, root, src_dirs)
    count = lambda key: sum(s[key] for s in suites)
    if not count("total"):
        raise SystemExit(f"{repo} {kind}: 돌린 시험이 0건입니다.")
    if (count("total"), count("failed")) != (result["numTotalTests"], result["numFailedTests"]):
        raise SystemExit(f"{repo} {kind}: 스위트 합계가 jest 합계와 다릅니다.")
    assert_real_failures(repo, kind, suites, failures)
    return summary(repo, kind, count("total"), count("passed"), count("failed"), count("skipped"),
                   suite_note(suites)), suites, failures, skips


def suite_note(suites):
    broken = sum(1 for s in suites if s["suiteError"])
    failed = sum(1 for s in suites if s["failed"] or s["suiteError"])
    return f"실패 스위트 {failed} (테스트 밖 실패 {broken})" if failed else ""


def summary(repo, kind, total, passed, failed, skipped, note="", available=True):
    return {"repo": repo, "kind": kind, "available": available, "total": total, "passed": passed, "failed": failed,
            "skipped": skipped, "note": note}


def parse_node(events, repo, root):
    """node:test 이벤트를 파일별로 모은다. describe 의 before · after 실패는 테스트 수에 들지 않아 스위트 오류로 올린다."""
    stats, by_file, failures, skips = {}, {}, [], []
    for e in events:
        m = re.fullmatch(r"(tests|pass|fail|skipped|todo|cancelled) (\d+)", e.get("diagnostic") or "")
        if m:
            stats[m.group(1)] = int(m.group(2))
        if "status" not in e:
            continue
        suite = os.path.relpath(e["file"], root)
        s = by_file.setdefault(suite, {"repo": repo, "kind": "unit", "area": area_of(repo, suite, []), "suite": suite, "total": 0,
                                       "passed": 0, "failed": 0, "skipped": 0, "suiteError": ""})
        if e["type"] == "suite":
            if e["status"] == "fail" and e.get("failureType") == "hookFailed":
                s["suiteError"] = HOOK_FAILED
                failures.append({"repo": repo, "kind": "unit", "suite": suite, "test": f"{HOOK_FAILED} {clean(e['name'])}", "error": short(error_of(e["error"]))})
            continue
        s["total"] += 1
        # 파일 수준 실패(불러오기 실패 · 맨 위 훅 실패)는 이름이 파일 경로다
        whole_file = os.path.basename(e["name"]) == os.path.basename(e["file"])
        if e["skip"] is not None or e["todo"] is not None:
            s["skipped"] += 1
            reason = e["skip"] if isinstance(e["skip"], str) and e["skip"] else e["todo"] if isinstance(e["todo"], str) and e["todo"] else NO_REASON
            skips.append({"repo": repo, "kind": "unit", "suite": suite, "test": clean(e["name"]), "reason": clean(reason)})
        elif e["status"] == "pass":
            s["passed"] += 1
        else:
            s["failed"] += 1
            if whole_file:
                s["suiteError"] = SUITE_FAILED
            failures.append({"repo": repo, "kind": "unit", "suite": suite, "test": SUITE_FAILED if whole_file else clean(e["name"]), "error": short(error_of(e["error"]))})
    return sorted(by_file.values(), key=lambda s: s["suite"]), failures, skips, stats


def run_node_tests(repo, root, env, tmp):
    reporter = os.path.join(tmp, "reporter.mjs")
    with open(reporter, "w", encoding="utf-8") as f:
        f.write(NODE_REPORTER)
    out = os.path.join(tmp, f"{repo}-node.jsonl")
    sh(["node", "--test", f"--test-reporter={reporter}", f"--test-reporter-destination={out}", "src/**/*.test.ts"], root, env)
    events = [json.loads(line) for line in open(out, encoding="utf-8") if line.strip()]
    suites, failures, skips, stats = parse_node(events, repo, root)
    count = lambda key: sum(s[key] for s in suites)
    if not count("total"):
        raise SystemExit(f"{repo} unit: 돌린 시험이 0건입니다.")
    if (count("total"), count("failed")) != (stats.get("tests"), stats.get("fail", 0) + stats.get("cancelled", 0)):
        raise SystemExit(f"{repo} unit: 스위트 합계 {count('total')} 가 node:test 합계 {stats} 와 다릅니다.")
    return summary(repo, "unit", count("total"), count("passed"), count("failed"), count("skipped"), suite_note(suites)), suites, failures, skips


def run_tsc(args, repo, root, env):
    if repo != "API":  # PageProps 같은 Next 전역 타입은 .next/types 에 만들어져 있어야 한다(.next 는 추적하지 않는다)
        gen = sh(["npx", "next", "typegen"], root, env)
        if gen.returncode:
            raise SystemExit(f"{repo} next typegen 실패(exit {gen.returncode}).")
    proc = sh(["npx", "tsc", "--noEmit", *args], root, env)
    errors = re.findall(r"^(\S+?)\((\d+),\d+\): error (TS\d+): (.+)$", proc.stdout, re.M)
    if proc.returncode and not errors:
        raise SystemExit(f"{repo} tsc: 오류를 읽지 못했습니다(exit {proc.returncode}).")
    failures = [{"repo": repo, "kind": "type", "suite": path, "test": f"{code}:{line}", "error": short(msg)}
                for path, line, code, msg in errors]
    return summary(repo, "type", 1, 0 if errors else 1, 1 if errors else 0, 0, f"타입 오류 {len(errors)}"), failures


def run_eslint(targets, repo, root, env, tmp):
    out = os.path.join(tmp, f"{repo}-eslint.json")
    proc = sh(["npx", "eslint", *targets, "-f", "json", "-o", out], root, env)
    if proc.returncode not in (0, 1) or not os.path.exists(out):
        raise SystemExit(f"{repo} eslint: 실행 실패(exit {proc.returncode}).")
    files = json.load(open(out, encoding="utf-8"))
    errors = sum(f["errorCount"] for f in files)
    warnings = sum(f["warningCount"] for f in files)
    bad = [f for f in files if f["errorCount"]]
    failures = [{"repo": repo, "kind": "lint", "suite": os.path.relpath(f["filePath"], root), "test": f"{m.get('ruleId')}:{m.get('line')}",
                 "error": short(m["message"])} for f in bad for m in f["messages"] if m["severity"] == 2]
    return summary(repo, "lint", len(files), len(files) - len(bad), len(bad), 0, f"오류 {errors} · 경고 {warnings}"), failures


def run_all(front, staff):
    url = os.environ.get("E2E_DATABASE_URL", "")
    if not local_db(url):
        raise SystemExit("E2E_DATABASE_URL 에 localhost 일회용 DB 를 주세요. 공용 DB 에서는 돌리지 않습니다.")
    jwt, data_key = secrets.token_urlsafe(48), base64.b64encode(secrets.token_bytes(32)).decode()
    env = run_env(url, jwt, data_key)
    roots = {"API": API, "관리자 웹": os.path.abspath(front), "직원 근무 앱": os.path.abspath(staff)}
    for repo, name in PACKAGES.items():
        actual = json.load(open(os.path.join(roots[repo], "package.json"), encoding="utf-8")).get("name")
        if actual != name:
            raise SystemExit(f"{repo} 경로의 package.json 이름이 {actual} 입니다({name} 이어야 합니다).")
    commits = {repo: check_repo(root) for repo, root in roots.items()}
    src_dirs = [d for d in os.listdir(os.path.join(API, "src")) if os.path.isdir(os.path.join(API, "src", d))]
    for cmd in (["npx", "prisma", "generate"], ["npx", "prisma", "migrate", "deploy"]):
        proc = sh(cmd, API, env)
        if proc.returncode:
            raise SystemExit(f"{' '.join(cmd[1:])} 실패(exit {proc.returncode}).")
    kinds, suites, failures, skips = [], [], [], []
    with tempfile.TemporaryDirectory() as tmp:
        for kind, args in (("unit", []), ("e2e", ["--config", "test/jest-e2e.json", "--runInBand", "--forceExit"])):
            k, s, f, x = run_jest(args, "API", kind, API, env, src_dirs, tmp)
            kinds.append(k), suites.extend(s), failures.extend(f), skips.extend(x)
        k, f = run_tsc(["-p", "tsconfig.json"], "API", API, env)
        kinds.append(k), failures.extend(f)
        k, f = run_eslint(["{src,apps,libs,test,scripts}/**/*.ts"], "API", API, env, tmp)
        kinds.append(k), failures.extend(f)
        for repo in ("관리자 웹", "직원 근무 앱"):
            root = roots[repo]
            k, s, f, x = run_node_tests(repo, root, env, tmp)
            kinds.append(k), suites.extend(s), failures.extend(f), skips.extend(x)
            scripts = json.load(open(os.path.join(root, "package.json"), encoding="utf-8"))["scripts"]
            if "test:e2e" in scripts:
                raise SystemExit(f"{repo}: e2e 스크립트가 생겼습니다. 실행 항목에 넣어 주세요.")
            kinds.append(summary(repo, "e2e", None, None, None, None, "저장소에 e2e 시험 없음", available=False))
            k, f = run_tsc([], repo, root, env)
            kinds.append(k), failures.extend(f)
            k, f = run_eslint(["."], repo, root, env, tmp)
            kinds.append(k), failures.extend(f)
    if {repo: check_repo(root) for repo, root in roots.items()} != commits:
        raise SystemExit("실행 중에 저장소 커밋이 바뀌었습니다. 결과 파일을 쓰지 않습니다.")
    node = sh(["node", "-v"], API, env).stdout.strip()
    data = {"runAt": datetime.date.today().isoformat(), "commits": commits,
            "environment": {"node": node, "disposableDb": True, "database": "일회용 PostgreSQL", "timeZone": env["TZ"]},
            "kinds": kinds, "suites": suites, "failures": failures, "skips": skips}
    text = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    secret = [v for v in (urlparse(url).password, jwt, data_key) if v and v in text]
    left = sorted({x for rows in (suites, failures, skips) for r in rows for v in r.values() for x in leaks(v)})
    paths = len(ABS_PATH.findall(text)) + len(CONN_STRING.findall(text))
    if secret or paths or left:
        raise SystemExit(f"결과 파일에 넣으면 안 되는 값이 있어 쓰지 않습니다: 비밀값 {len(secret)}건, 절대경로 {paths}건, 내부 표지 {len(left)}건 {left[:10]}")
    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        f.write(text)
    return data


# ── 문서 ──

def plan_of(failure):
    if failure["kind"] in ("type", "lint"):
        impact = "데모 파일이라 앱 동작과 무관" if failure["suite"].startswith("docs/demo/") else "미확인"
        return f"{KINDS[failure['kind']]} 오류: {failure['test']} {failure['error']}", impact, "담당 영역에서 확인"
    return KNOWN_FAILURES.get((failure["suite"], failure["test"], failure["error"]),
                              (f"원인 미분석: {failure['error']}", "미확인", "원인 확인 후 결정"))


def summary_rows(snap):
    short = {repo: commit[:8] for repo, commit in snap["commits"].items()}
    return [[k["repo"], KINDS[k["kind"]], *([k[c] for c in ("total", "passed", "failed", "skipped")] if k["available"] else ["없음"] * 4),
             snap["runAt"], short[k["repo"]], k["note"]] for k in snap["kinds"]]


def suite_rows(snap):
    return [[s["repo"], s["area"], s["suite"], s["total"], s["passed"], s["failed"], s["skipped"],
             "시험 전후 처리 단계에서 실패" if s["suiteError"] == HOOK_FAILED else "스위트 실행 실패" if s["suiteError"] else ""] for s in snap["suites"]]


def detail_rows(snap):
    rows = [["실패", f["repo"], f["suite"], f["test"], *plan_of(f)] for f in snap["failures"]]
    rows += [["제외", s["repo"], s["suite"], s["test"], s["reason"], "기본 실행에서 이 시험의 경로는 확인하지 않음",
              "해당 환경값을 준 별도 실행으로 확인" if s["reason"] in ENV_SKIPS else "사유 확인"] for s in snap["skips"]]
    return rows or [["없음", "", "", "실패 · 제외한 시험 없음", "", "", ""]]


def check(snap):
    """집계가 맞지 않으면 멈춘다."""
    for k in snap["kinds"]:
        if k["available"] and k["total"] != k["passed"] + k["failed"] + k["skipped"]:
            raise SystemExit(f"{k['repo']} {k['kind']}: 전체와 합계가 다릅니다.")
        if k["kind"] in ("unit", "e2e") and k["available"]:
            s = [x for x in snap["suites"] if x["repo"] == k["repo"] and x["kind"] == k["kind"]]
            if (sum(x["total"] for x in s), sum(x["failed"] for x in s)) != (k["total"], k["failed"]):
                raise SystemExit(f"{k['repo']} {k['kind']}: 스위트 합계가 요약과 다릅니다.")


def basis(snap):
    return " · ".join(f"{repo} {commit[:8]}" for repo, commit in snap["commits"].items())


def write(version):
    snap = json.load(open(SNAPSHOT, encoding="utf-8"))
    check(snap)
    wb, doc_name, doc_no = open_xlsx("TEST", version)
    e = snap["environment"]
    table_sheet(wb, "요약", ["저장소", "종류", "전체", "통과", "실패", "건너뜀", "실행일", "기준 커밋", "비고"], summary_rows(snap),
                [14, 8, 8, 8, 8, 8, 12, 12, 34],
                top_rows=[("실행 환경", f"Node {e['node']} · {e['database']} · 시간대 {e['timeZone']}"),
                          ("집계 기준", "단위 · e2e 는 테스트 수, 린트는 검사한 파일 수, 타입은 저장소당 한 건")])
    table_sheet(wb, "스위트별", ["저장소", "영역", "스위트(파일)", "건수", "통과", "실패", "건너뜀", "비고"], suite_rows(snap),
                [14, 22, 58, 7, 7, 7, 8, 26])
    table_sheet(wb, "실패 · 제외 목록", ["구분", "저장소", "스위트", "테스트 이름", "사유", "영향", "처리 계획"], detail_rows(snap),
                [7, 12, 40, 56, 52, 28, 28])
    left = sheet_leaks(wb)
    if left:
        raise SystemExit(f"납품본에 내부 표지가 남았습니다: {left[:20]}")
    path = save_xlsx(wb, doc_name, f"{doc_no}_{doc_name}.xlsx")
    record_basis("TEST", version, path, basis(snap))
    return path, snap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--front")
    ap.add_argument("--staff")
    ap.add_argument("--version")
    args = ap.parse_args()
    if args.run:
        if not (args.front and args.staff):
            raise SystemExit("--run 에는 --front · --staff 가 필요합니다.")
        data = run_all(args.front, args.staff)
        print(f"{SNAPSHOT}\n실패 {len(data['failures'])} · 제외 {len(data['skips'])}")
    if args.version:
        path, snap = write(args.version)
        print(f"{path}\n{os.path.getsize(path)} bytes · 실패 {len(snap['failures'])} · 제외 {len(snap['skips'])}")


if __name__ == "__main__":
    main()
