"""완료보고서(WHALE-RPT) — 다른 산출물의 원본과 셈 함수에서 숫자를 읽어 워드로 낸다.

    .venv/bin/python build_completion_report.py --version 1.0

손으로 적은 숫자는 없다. 값을 못 읽거나 합이 맞지 않으면 멈춘다. 전체 재생성의 맨 마지막에 돌린다.
기준 칸은 각 생성기가 문서를 만들 때 남긴 out/manifest.json 을 읽는다.
납품본은 산출물 8종, 기준 일치, 깨끗한 작업 트리를 확인한다. --draft 는 이 확인을 건너뛰고 표지 · 머리글 · 파일 이름에 초안을 표시한다.
"""
import argparse
import json
import os
import re
from collections import Counter

from lxml import html

import build_api_spec as API
import build_menu_structure as MENU
import build_policy as POL
import build_requirements as REQ
import build_screens as SCR
import build_table_definition as TBL
import build_test_results as TEST
import build_userflow as FLOW
from common import HERE, MANIFEST, OUT, heading, open_docx, para, read_manifest, revision, save_docx, sha256, source_basis, table, tree_clean

PRD = os.path.join(HERE, "sources", "manyfast_prd.json")
RAW_POLICY = os.path.expanduser("~/IdeaProjects/whale-erp-v2/docs/raw/운영정책.html")
EXCLUDE_CHAPTER, OPEN_CHAPTER = "1차 범위에서 제외", "아직 정해지지 않은 것"
FORMATS = {"REQ": "xlsx", "MENU": "xlsx", "API": "xlsx", "TBL": "xlsx", "POL": "docx", "FLOW": "docx", "SCR": "docx",
           "TEST": "xlsx", "RPT": "docx"}
CLIENTS = {"admin": "관리자 웹", "staff": "직원 근무 앱", "public": "비로그인 화면"}
# 비로그인 화면 중 서비스를 소개만 하는 화면. 이름만 적으면 재무관리 · 부가서비스를 제공하는 것처럼 읽힌다.
INTRO_ROUTES = {"/store-operations", "/finance-management", "/franchise", "/add-on-services"}
PHASE2 = "2차"
BEFORE_OPEN = "서비스를 열기 전에 끝나야"
ANY_ID = re.compile(r"\s*\([A-Z]{2,}-\d+[^()]*\)|\s*· 2차로 미룸")
# 납품본 점검에서 test_results.leaks 가 보지 않는 것. 화면설계서 점검의 도구 · 경로 · 번호 형태를 다시 쓴다.
# 그 점검의 MEMO 는 「법무」 「1차」처럼 이 문서가 본문으로 쓰는 말까지 잡아 쓰지 않는다.
EXTRA_LEAKS = [SCR.TOOLS, SCR.REPO_PATH, SCR.PHONE_LOOSE,
               re.compile(r"쟁점|미정(?!산)|보류|추후|TBD|FIXME|TODO|\{\{|\b(?:src|docs|prisma|deliverables|test)/[\w./-]*"
                          r"|임시저장|발송 대기|체결 완료|(?<!직원 )서명 ?대기|(?<!소속 )승인 대기"),
               re.compile(r"localhost|E2E_"),
               re.compile(r"manyfast|plane|buzz|figma|claude|orca|archify|github|notion|DESKTOP-\w+", re.I),
               re.compile(r"(?<![A-Za-z])(?:Kim|Lee|Noh|Choi|Ryu|Minsik|Honggi|Jeyoung|Jungpyo|Hyojun|Changsoo|Jiyoung|Young Joo|Jaeyoung)(?![A-Za-z])", re.I)]
DEMO_FILE = "데모 파일"  # 린트 실패의 영향 설명. 화면설계서 점검의 「데모」는 화면 이미지용이라 이 말만 뺀다
FINAL_LEAKS = re.compile(r"미분석|미확인")  # 납품본에서만 멈춘다


def prd():
    with open(PRD, encoding="utf-8") as f:
        data = json.load(f)
    if not data["goal"] or not data["targetUser"]:
        raise SystemExit("PRD 스냅숏의 목적 · 대상을 읽지 못했습니다.")
    return data


def req_counts(snap):
    """셈은 요구사항정의서와 같이 하고, 원본의 항목 수와 다르면 멈춘다."""
    counts = dict(zip(("requirements", "features", "specs"), map(len, REQ.ordered(snap))))
    if counts != snap["totalCounts"]:
        raise SystemExit(f"요구사항 스냅숏 항목 수가 다릅니다: {snap['totalCounts']} · 실제 {counts}")
    return counts


def menu_snapshot(draft):
    snap = json.load(open(MENU.SNAPSHOT, encoding="utf-8"))
    latest = max(d for d in os.listdir(MENU.MIGRATIONS) if os.path.isdir(os.path.join(MENU.MIGRATIONS, d)))
    if snap["lastMigration"] != latest:
        message = f"메뉴 스냅숏이 낡았습니다: 스냅숏 {snap['lastMigration']} · 저장소 {latest}."
        if not draft:
            raise SystemExit(f"{message} menus.json 을 다시 만들어 주세요(초안은 --draft).")
        print(f"경고: {message}")
    if not len(MENU.tree_rows(snap)[0]) == len(snap["menus"]) == snap["menuCount"]:
        raise SystemExit("메뉴 스냅숏의 행 수가 맞지 않습니다.")
    return snap


def is_used(menu):
    return menu["status"] == "ACTIVE" and not menu["is_deleted"]


def feature_rows(menus, areas):
    """[구분, 영역, 사용 중 메뉴 또는 화면 이름]. 메뉴가 있는 영역은 사용 중인 하위 메뉴, 없는 영역은 화면 이름을 적는다."""
    by_name = {m["name"]: m for m in menus if m["parent_menu_id"] is None and is_used(m)}
    rows = []
    for a in areas:
        root = by_name.get(a["area"]) if a["client"] == "admin" else None
        if root:
            kids = sorted((m for m in menus if m["parent_menu_id"] == root["menu_id"] and is_used(m)), key=lambda m: (m["sort_order"], m["menu_id"]))
            names = [m["name"] for m in kids] or [root["name"]]
        else:
            intro = [s["name"] for s in a["screens"] if s.get("route") in INTRO_ROUTES]
            names = [s["name"] for s in a["screens"] if s.get("route") not in INTRO_ROUTES]
            names += [f"서비스 소개({' · '.join(intro)})"] if intro else []
        rows.append([CLIENTS[a["client"]], a["area"], " · ".join(dict.fromkeys(names))])
    return rows


def scope_rows(menus, areas):
    """[클라이언트, 영역, 화면 수, 사용 메뉴 수]. 메뉴에 없는 영역은 사용 메뉴 칸을 「-」로 둔다. 사용 메뉴를 빠뜨리면 멈춘다."""
    by_id = {m["menu_id"]: m for m in menus}

    def root(m):
        while m["parent_menu_id"] is not None:
            m = by_id[m["parent_menu_id"]]
        return m

    used = [m for m in menus if is_used(m)]
    per_root = Counter(root(m)["name"] for m in used)
    rows = [[CLIENTS[a["client"]], a["area"], len(a["screens"]),
             per_root.pop(a["area"]) if a["client"] == "admin" and a["area"] in per_root else "-"] for a in areas]
    if per_root:
        raise SystemExit(f"화면 영역과 이어지지 않은 사용 메뉴: {dict(per_root)}")
    return rows, len(used)


def chapters():
    root = html.fromstring(open(POL.SOURCE, encoding="utf-8").read())
    return root.xpath('//div[@class="wrap"]/section'), root


def chapter(sections, prefix):
    found = [s for s in sections if prefix in s.find("h2").text_content()]
    if len(found) != 1:
        raise SystemExit(f"운영 정책에서 「{prefix}」 장을 하나 찾아야 합니다: {len(found)}")
    return found[0]


def exclusions(section):
    items = [POL.plain(c) for chips in section.xpath('./div[@class="chips"]') for c in chips]
    if not items:
        raise SystemExit("운영 정책의 1차 범위 제외 목록을 읽지 못했습니다.")
    return items


def open_items(section):
    """(외부 검토 [검토처, 항목, 비고], 2차 항목 [항목, 내용]). 번호는 지운다."""
    external, later = [], []
    for o in section.xpath('.//div[contains(concat(" ", @class, " "), " open ")]'):
        body = o.find("div")
        tag = POL.plain(o.find("span"))
        name = ANY_ID.sub("", " ".join(body.find("h3").text_content().split()))
        text = " ".join(POL.plain(p) for p in body.findall("p"))
        if tag == PHASE2:
            later.append([name, ANY_ID.sub("", text)])
        else:
            external.append([tag, name, "서비스를 열기 전에 완료 필요" if BEFORE_OPEN in text else ""])
    if not external or not later:
        raise SystemExit(f"운영 정책의 미정 항목을 읽지 못했습니다: 외부 검토 {len(external)} · 2차 {len(later)}")
    return external, later


def bases(req_snap, menu_snap, test_snap):
    """지금 원본 기준으로 계산한 기준 값. 기록과 대조하는 데 쓴다."""
    return {"REQ": REQ.basis(req_snap), "MENU": MENU.basis(menu_snap), "API": API.basis(), "TBL": TBL.basis(), "POL": POL.basis(),
            "FLOW": source_basis(FLOW.SOURCE_JSON), "SCR": source_basis(SCR.SOURCE_JSON), "TEST": TEST.basis(test_snap)}


def latest_versions():
    with open(os.path.join(HERE, "revisions.json"), encoding="utf-8") as f:
        docs = json.load(f)
    if set(docs) != set(FORMATS):
        raise SystemExit(f"revisions.json 의 문서가 9종과 다릅니다: {sorted(set(docs) ^ set(FORMATS))}")
    return {abbr: (doc["name"], doc["history"][-1]["version"]) for abbr, doc in docs.items()}


def policy_differs():
    """운영 정책 원본이 있으면 사본과 대조한다. 원본을 볼 수 없으면 대조하지 않는다."""
    return os.path.exists(RAW_POLICY) and sha256(RAW_POLICY) != sha256(POL.SOURCE)


def delivery_problems(manifest, current, versions, out=OUT):
    """납품본을 만들어도 되는지 본다. 문제 목록을 돌려준다."""
    problems = [] if tree_clean() else ["작업 트리가 깨끗하지 않습니다."]
    if policy_differs():
        problems.append("운영 정책 사본이 원본과 다릅니다.")
    for abbr, basis in current.items():
        e = manifest.get(abbr)
        if not e:
            problems.append(f"{abbr}: 기준 기록이 없습니다.")
            continue
        path = os.path.join(out, e["file"])
        if not os.path.exists(path):
            problems.append(f"{abbr}: 산출물 파일이 없습니다.")
        elif sha256(path) != e["sha256"]:
            problems.append(f"{abbr}: 산출물 파일이 기록과 다릅니다.")
        if e["version"] != versions[abbr][1]:
            problems.append(f"{abbr}: 버전이 다릅니다.")
        if e["basis"] != basis:
            problems.append(f"{abbr}: 기준이 다릅니다(기록 {e['basis']} · 지금 {basis}).")
        if not e["clean"]:
            problems.append(f"{abbr}: 깨끗하지 않은 작업 트리에서 만들었습니다.")
    if manifest.get("POL") and manifest["POL"].get("sourceSha") != sha256(POL.SOURCE):
        problems.append("POL: 문서를 만든 뒤 운영 정책 사본이 바뀌었습니다.")
    return problems


def deliverables(manifest, versions, version):
    """산출물 목록. 기준은 생성 때 남긴 기록을 읽는다."""
    rows = []
    for abbr, (name, v) in versions.items():
        v = version if abbr == "RPT" else v
        basis = "위 8종의 기준" if abbr == "RPT" else manifest.get(abbr, {}).get("basis", "기준 기록 없음")
        rows.append([f"WHALE-{abbr}-{v}", name, FORMATS[abbr], v, basis])
    return rows


def results(counts, menu_snap, used_menus):
    tables, columns = counts["tbl"]
    leaves = SCR.menu_tree()
    return [["요구사항 · 기능 · 명세", f"요구사항 {counts['req']['requirements']} · 기능 {counts['req']['features']} · 명세 {counts['req']['specs']}", "요구사항정의서"],
            ["메뉴", f"전체 {menu_snap['menuCount']} · 사용 {used_menus} · 사용 중 말단 {sum(1 for x in leaves if x[2] == 'ACTIVE')}", "메뉴구조도"],
            ["테이블 · 컬럼", f"테이블 {tables} · 컬럼 {columns}", "테이블정의서"],
            ["API", f"API {counts['api'][0]} · 영역 {counts['api'][1]}", "API 명세"],
            ["운영 정책 규칙", f"규칙 {counts['rules']}", "운영 정책서"],
            ["화면", f"화면 {counts['screens'][0]} · 이미지 {counts['screens'][1]}", "화면설계서"],
            ["유저플로우", f"흐름 {counts['flows'][0]} · 단계 {counts['flows'][1]}", "유저플로우"]]


def count_all():
    models, *_ = TBL.parse(TBL.SCHEMA)
    with open(API.OPENAPI, encoding="utf-8") as f:
        blocks, modules = API.build(json.load(f), API.scan_routes(API.SRC), API.scan_dtos(API.SRC))
    root = chapters()[1]
    rules = len(root.xpath('//div[@class="rule"]'))
    if rules != POL.RULES:
        raise SystemExit(f"운영 정책 규칙 수가 다릅니다: 원본 {rules} · 생성기 {POL.RULES}")
    screens = SCR.screens()
    groups = FLOW.flows()
    return {"tbl": (len(models), sum(len(m["fields"]) for m in models)), "api": (len(blocks), len(modules)), "rules": rules,
            "screens": (len(screens), sum(len(s["images"]) for _, s in screens)),
            "flows": (sum(len(g[2]) for g in groups), sum(len(w["nodes"]) for g in groups for _, w, _ in g[2]))}


def check_listed(snap):
    """요약의 실패 · 제외 칸과 목록이 어긋나면(실패가 목록에서 빠지면) 멈춘다."""
    for k in (k for k in snap["kinds"] if k["available"]):
        where = lambda x: x["repo"] == k["repo"] and x["kind"] == k["kind"]
        listed = [f for f in snap["failures"] if where(f)]
        if k["kind"] in ("unit", "e2e"):
            expected = k["failed"] + sum(1 for s in snap["suites"] if where(s) and s["suiteError"])
            ok = len(listed) == expected and sum(map(where, snap["skips"])) == k["skipped"]
        elif k["kind"] == "lint":
            ok = len({f["suite"] for f in listed}) == k["failed"]
        else:
            ok = bool(listed) == (k["failed"] > 0)
        if not ok:
            raise SystemExit(f"{k['repo']} {k['kind']}: 요약과 실패 · 제외 목록이 어긋납니다.")


def failure_groups(snap):
    """[(구분, 저장소, 종류, 사유, 영향, 처리 계획), 건수]. 린트 · 타입 오류의 사유는 규칙 이름까지만. 합이 원본 목록 수와 다르면 멈춘다."""
    groups = Counter()
    for f in snap["failures"]:
        reason, impact, plan = TEST.plan_of(f)
        if f["kind"] in ("type", "lint"):
            reason = f"{TEST.KINDS[f['kind']]} 오류: {f['test'].rsplit(':', 1)[0]}"
        elif reason.startswith("원인 미분석"):  # 오류 원문은 싣지 않는다
            reason = "원인 미분석"
        groups[("실패", f["repo"], TEST.KINDS[f["kind"]], reason, impact, plan)] += 1
    for row, skip in zip(TEST.detail_rows({**snap, "failures": []}), snap["skips"]):
        groups[("제외", row[1], TEST.KINDS[skip["kind"]], row[4], row[5], row[6])] += 1
    if sum(groups.values()) != len(snap["failures"]) + len(snap["skips"]):
        raise SystemExit("실패 · 제외 건수의 합이 원본 목록 수와 다릅니다.")
    check_listed(snap)
    return list(groups.items())


def leaks(texts, final=False):
    patterns = EXTRA_LEAKS + ([FINAL_LEAKS] if final else [])
    texts = [(t or "").replace(DEMO_FILE, "") for t in texts]
    return sorted({x for t in texts for x in TEST.leaks(t) + [m.group() for rx in patterns for m in rx.finditer(t)]})


def all_text(d):
    cells = [p.text for t in d.tables for r in t.rows for c in r.cells for p in c.paragraphs]
    section = d.sections[0]
    c = d.core_properties
    props = [c.author, c.last_modified_by, c.title, c.subject, c.comments, c.keywords, c.category]
    return [p.text for p in d.paragraphs] + cells + [p.text for p in section.header.paragraphs + section.footer.paragraphs] + props


def write(version, draft=False):
    """워드를 쓰고 (경로, 절마다 보고할 값) 을 돌려준다."""
    revision("RPT", version)  # 없는 버전이면 여기서 멈춘다
    with open(REQ.SNAPSHOT, encoding="utf-8") as f:
        req_snap = json.load(f)
    with open(TEST.SNAPSHOT, encoding="utf-8") as f:
        test_snap = json.load(f)
    TEST.check(test_snap)
    menu_snap = menu_snapshot(draft)
    versions = latest_versions()
    manifest = read_manifest()
    if not draft:
        problems = delivery_problems(manifest, bases(req_snap, menu_snap, test_snap), {k: v for k, v in versions.items()})
        if problems:
            raise SystemExit("납품본을 만들 수 없습니다(초안은 --draft):\n" + "\n".join(problems))
    purpose = prd()
    area_list = [a for _, a in SCR.load_areas()]
    scope, used_menus = scope_rows(menu_snap["menus"], area_list)
    sections = chapters()[0]
    excluded = exclusions(chapter(sections, EXCLUDE_CHAPTER))
    external, later = open_items(chapter(sections, OPEN_CHAPTER))
    docs = deliverables(manifest, versions, version)
    features = feature_rows(menu_snap["menus"], area_list)
    counts = {**count_all(), "req": req_counts(req_snap)}
    result_rows = results(counts, menu_snap, used_menus)
    groups = failure_groups(test_snap)

    d, doc_name, doc_no = open_docx("RPT", version, draft)
    heading(d, "프로젝트 개요", 1)
    para(d, [("목적 ", True), (purpose["goal"], False)])
    para(d, [("대상 ", True), (purpose["targetUser"], False)])
    para(d, [("화면 구분 ", True), (" · ".join(dict.fromkeys(r[0] for r in features)), False)])
    heading(d, "제공 기능", 2)
    para(d, "메뉴가 있는 영역은 사용 중인 메뉴를, 메뉴가 없는 영역은 화면을 적는다.")
    table(d, ["구분", "영역", "메뉴 · 화면"], features, widths=[2.6, 3.6, 10.3])

    heading(d, "수행 범위", 1)
    para(d, f"1차 범위는 아래 영역의 화면 {sum(r[2] for r in scope)}개와 사용 메뉴 {used_menus}개다. "
            "사용 메뉴 칸의 「-」는 메뉴 테이블에 없는 영역이다.")
    table(d, ["구분", "영역", "화면 수", "사용 메뉴 수"], scope, widths=[4, 7, 2.5, 3])
    heading(d, "제외 범위", 2)
    for item in excluded:
        para(d, item, style="List Bullet")

    heading(d, "산출물 목록", 1)
    table(d, ["문서 번호", "산출물", "형식", "버전", "기준"], docs, widths=[3.8, 3.2, 1.3, 1.2, 7])

    heading(d, "결과 요약", 1)
    table(d, ["항목", "수", "산출물"], result_rows, widths=[4.5, 8.5, 3.5])

    heading(d, "테스트 결과 요약", 1)
    env = test_snap["environment"]
    para(d, f"실행일 {test_snap['runAt']}. Node {env['node']}, {env['database']}, 시간대 {env['timeZone']}. "
            "단위 · e2e 는 테스트 수, 린트는 검사한 파일 수, 타입은 저장소당 한 건으로 센다.")
    table(d, ["저장소", "종류", "전체", "통과", "실패", "제외", "비고"],
          [[*r[:6], r[8]] for r in TEST.summary_rows(test_snap)], widths=[2.8, 1.5, 1.6, 1.6, 1.3, 1.3, 6.4])
    heading(d, "실패 · 제외 내역", 2)
    para(d, "건수는 실패한 테스트, 테스트 밖 실패, 린트 오류를 하나씩 센 값이라 위 표의 실패 칸과 다를 수 있다. 시험별 내역은 테스트 결과서에 있다.")
    table(d, ["구분", "저장소", "종류", "건수", "사유"], [[k[0], k[1], k[2], n, k[3]] for k, n in groups],
          widths=[1.3, 2.4, 1.3, 1.2, 10.3])

    heading(d, "잔여 사항", 1)
    heading(d, "외부 검토", 2)
    table(d, ["검토처", "항목", "비고"], external, widths=[2.2, 10, 4.3])
    heading(d, "2차로 미룬 항목", 2)
    table(d, ["항목", "내용"], later, widths=[6, 10.5])
    heading(d, "테스트 실패 처리 계획", 2)
    fails = [k for k, _ in groups if k[0] == "실패"]
    table(d, ["저장소", "사유", "영향", "처리 계획"], [[k[1], k[3], k[4], k[5]] for k in fails], widths=[2.4, 7.5, 3.1, 3.5])

    left = leaks(all_text(d), final=not draft)
    if left:
        raise SystemExit(f"납품본에 내부 표지가 남았습니다: {left[:30]}")
    path = save_docx(d, f"{doc_no}_{doc_name}{'_초안' if draft else ''}.docx")
    return path, {"docs": docs, "results": result_rows, "scope": (len(scope), used_menus), "fails": sum(n for k, n in groups if k[0] == "실패"),
                  "skips": sum(n for k, n in groups if k[0] == "제외"), "external": len(external), "later": len(later)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--draft", action="store_true", help="낡은 메뉴 스냅숏을 허용한다")
    a = ap.parse_args()
    path, info = write(a.version, a.draft)
    print(f"{path} ({os.path.getsize(path) / 1024:.0f}KB)")
    for r in info["results"]:
        print(f"{r[0]}: {r[1]}")
    print(f"영역 {info['scope'][0]} · 사용 메뉴 {info['scope'][1]} · 실패 {info['fails']} · 제외 {info['skips']} · 외부 검토 {info['external']} · 2차 {info['later']}")


if __name__ == "__main__":
    main()
