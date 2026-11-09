"""유저플로우(WHALE-FLOW) — sources/flow/(front · staff 저장소 docs/flow 스냅숏)를 워드로 낸다.

    .venv/bin/python build_userflow.py --snapshot          # 두 저장소 origin/main 에서 스냅숏을 다시 뜬다
    .venv/bin/python build_userflow.py --version 1.0

장 = 클라이언트, 절 = 흐름(meta.title). 흐름마다 그림(HTML 을 헤드리스 Chromium 으로 찍은 SVG) · 단계 표 · 결정 목록을 싣는다.
단계 표는 workflow.json 의 값만 옮긴다(매핑은 계획 문서). 그림을 하나라도 못 찍으면 멈춘다.
"""
import argparse
import json
import os
import re
import shutil
import subprocess

from common import (HERE, INTERNAL, OUT, TEAM, TEAM_NAMES, heading, open_docx, para, picture, record_basis, safe, save_docx, source_basis,
                    strip_records, table)

FLOW = os.path.join(HERE, "sources", "flow")
SOURCE_JSON = os.path.join(FLOW, "SOURCE.json")
V2 = os.path.expanduser("~/IdeaProjects/whale-erp-v2")
CLIENTS = [("admin", "관리자 웹", "whale-erp-front"), ("staff", "직원 근무 앱", "whale-erp-staff")]
PNG = os.path.join(OUT, "flow_png")
HEADERS = ["단계", "구간", "화면 · 주체", "유형", "내용", "다음 · 분기"]
WIDTHS = [1.2, 2.2, 2.8, 2.2, 4.4, 4.2]
REMOVED = []
# 카드 항목을 「 · 」로 나눈 조각에 이 말이 있으면 미결 · 팀 간 메모로 보고 싣지 않는다. 「미정산」은 탈퇴 조건이라 뺀다.
MEMO = re.compile(r"미정(?!산)|보류|협의|법무|노무사|검토|확인 중|[13]팀|두 팀")
# 결정 문장 끝의 「(1팀 MYPAGE-3)」, 「진입과 홈」의 앞머리, 약관 조각의 팀 표시. 나머지 사실 설명은 남긴다.
TEAM_MARK = re.compile(r"\([13]팀 [^)]*\)|로그인·가입·계정 찾기는 1팀 화면이다 — |(?<=약관 ③~⑥은 )3팀 ")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
# 그림 · 표 칸의 내부 메모(원문 → 바꾼 글, 빈 글이면 그림에서 뺀다). 원본 스냅숏은 고치지 않는다.
FIGURE_FIXES = {
    "2026-09-17 · 발송은 3팀": "",
    "1팀 화면 · 초대 확인은 앱에서": "",
    "1팀 화면 · 아이디 로그인": "아이디 로그인",
    "3팀 화면 · 스스로 끝냄": "스스로 끝냄",
    "3팀 · 늘 전체 범위": "늘 전체 범위",
    "홈 (3팀)": "홈",
    "전문 한 곳 · 초안 v0.7": "전문 한 곳",
    "3팀 공통 기반": "",
    "S-RCJXIG": "", "S-VFGQLI": "", "F-OFBCVL": "",  # 화면에는 투명하게 그려지는 Manyfast ID
}
DROPPED = []  # 뺀 카드 조각 (흐름 제목, 카드 제목, 조각)
# 목업 쟁점 번호(ATT-2, CONFIG-3, HOME-4 등). 「운영 정책 ATT-25」처럼 인용한 번호는 지우지 않는다.
_ISSUE = r"(?<!운영 정책 )(?<![A-Za-z0-9_-])[A-Z]{2,}-\d+(?:[·~]\d+)*"
ISSUE = re.compile(_ISSUE)
_ISSUE_PAREN = re.compile(rf"\s*\((?:{_ISSUE})(?:\s*[·,]\s*(?:{_ISSUE}))*\)")
_ISSUE_CHAIN = re.compile(rf"(?:{_ISSUE})(?:\s*·\s*(?:{_ISSUE}|\d+(?![0-9A-Za-z가-힣])))*(?:\s*·\s*|\s+|$)")
# 원문에 「운영 정책」 없이 적힌 운영 정책 번호. 납품본에는 「운영 정책 」을 붙인다(2026-11-09 재영).
POLICY_CITES = re.compile(r"(?<!운영 정책 )(?<![A-Za-z0-9_-])(?:ACC-11|CTR-19|CTR-26)\b")
COMMON_POLICY = re.compile(r"\s*\(공통정책 \d+\)")
ISSUE_REMOVED = []


def snapshot():
    """두 저장소 origin/main 의 docs/flow/<폴더>/ 에서 *.workflow.json · *.html(visual-check 제외)만 복사한다."""
    shutil.rmtree(FLOW, ignore_errors=True)
    source = {}
    for key, _, repo in CLIENTS:
        root = os.path.join(V2, repo)
        commit = subprocess.check_output(["git", "-C", root, "rev-parse", "origin/main"], text=True).strip()
        files = subprocess.check_output(["git", "-C", root, "ls-tree", "-r", "--name-only", commit, "docs/flow"],
                                        text=True).split()
        n = 0
        for f in files:
            parts = f.split("/")
            if len(parts) != 4 or ".visual-check." in parts[3] or not parts[3].endswith((".workflow.json", ".html")):
                continue
            dst = os.path.join(FLOW, key, parts[2], parts[3])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as out:
                out.write(subprocess.check_output(["git", "-C", root, "show", f"{commit}:{f}"]))
            n += 1
        date = subprocess.check_output(["git", "-C", root, "log", "-1", "--format=%cI", commit], text=True).strip()
        source[key] = {"repo": repo, "ref": "origin/main", "commit": commit, "committedAt": date, "files": n}
    with open(SOURCE_JSON, "w", encoding="utf-8") as f:
        json.dump(source, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return source


def flows():
    """[(클라이언트 키, 이름, [(폴더, workflow, html 경로)])]. 폴더마다 workflow.json · html 이 하나씩 있어야 한다."""
    out = []
    for key, label, _ in CLIENTS:
        items = []
        for folder in sorted(os.listdir(os.path.join(FLOW, key))):
            d = os.path.join(FLOW, key, folder)
            js = [f for f in os.listdir(d) if f.endswith(".workflow.json")]
            hs = [f for f in os.listdir(d) if f.endswith(".html")]
            if len(js) != 1 or len(hs) != 1:
                raise SystemExit(f"{key}/{folder}: workflow.json {len(js)} · html {len(hs)} — 하나씩이어야 합니다.")
            items.append((folder, json.load(open(os.path.join(d, js[0]), encoding="utf-8")), os.path.join(d, hs[0])))
        out.append((key, label, items))
    return out


def strip_issue(text):
    """쟁점 번호를 지운다. 괄호 안에 번호뿐이면 괄호째, 앞머리 번호는 뒤의 구분자까지."""
    def gone(m):
        ISSUE_REMOVED.extend(ISSUE.findall(m.group()))
        return ""
    text = POLICY_CITES.sub(lambda m: f"운영 정책 {m.group()}", text)
    return _ISSUE_CHAIN.sub(gone, _ISSUE_PAREN.sub(gone, text))


def issues_left(text):
    return ISSUE.findall(text) + re.findall(r"공통정책 \d+", text)


def clean(text):
    text = " ".join((text or "").split())
    return COMMON_POLICY.sub("", safe(strip_records(strip_issue(FIGURE_FIXES.get(text, text)), REMOVED)))


def card_item(title, card_title, item):
    """카드 항목에서 미결 · 팀 간 메모 조각을 뺀 글. 남는 조각이 없으면 빈 글."""
    keep = []
    for piece in TEAM_MARK.sub("", item).split(" · "):
        if MEMO.search(piece):
            DROPPED.append((title, card_title, piece))
        else:
            piece = strip_issue(piece)
            if piece:
                keep.append(piece)
    return " · ".join(keep)


def ordered(wf, lane_order):
    """열 순서로, 같은 열 안에서는 선의 방향대로. 순서가 없거나 순환이면 레인 순서가 앞선 노드부터."""
    out = []
    for col in sorted({n["col"] for n in wf["nodes"]}):
        rest = sorted((n for n in wf["nodes"] if n["col"] == col), key=lambda n: lane_order[n["lane"]])
        while rest:
            ids = {n["id"] for n in rest}
            blocked = {e["to"] for e in wf["edges"] if e["from"] in ids and e["to"] in ids and e["from"] != e["to"]}
            n = next((x for x in rest if x["id"] not in blocked), rest[0])
            out.append(n)
            rest.remove(n)
    return out


def steps(wf):
    """단계 표 줄. 순서는 ordered(). 칸 매핑은 계획 문서의 표."""
    lanes = {l["id"]: (i, l.get("label", l["id"])) for i, l in enumerate(wf["lanes"])}
    legend = wf["meta"].get("legend", {}).get("entries", {})
    label = {n["id"]: n.get("label", n["id"]) for n in wf["nodes"]}
    nodes = ordered(wf, {k: v[0] for k, v in lanes.items()})
    rows = []
    for i, n in enumerate(nodes, 1):
        phase = next((p["label"] for p in wf.get("phases", []) if p["fromCol"] <= n["col"] <= p["toCol"]), "")
        tag = n.get("tag") if n.get("tag") and not INTERNAL.search(n["tag"]) and not TEAM.search(n["tag"]) else ""
        tag = strip_issue(tag)
        tag = "" if re.fullmatch(r"[\d\s·]*", tag) else tag
        content = "\n".join(x for x in (n.get("label", ""), FIGURE_FIXES.get(n.get("sublabel", ""), n.get("sublabel", ""))) if x) + (f" ({tag})" if tag else "")
        nexts = "\n".join(f"→ {label.get(e['to'], e['to'])}" + (f" ({e['label']})" if e.get("label") else "")
                          for e in wf["edges"] if e["from"] == n["id"])
        rows.append([str(i), phase, lanes[n["lane"]][1], legend.get(n["type"], {}).get("label", n["type"]),
                     content, nexts])
    return [[clean(c) if "\n" not in c else "\n".join(clean(x) for x in c.split("\n")) for c in r] for r in rows]


# 그림 글자를 고치고(빈 글이면 지우고) 남은 글자 목록을 돌려준다.
FIX_LABELS = """(svg, fixes) => [...svg.querySelectorAll('text')].flatMap(t => {
  const s = t.textContent.trim();
  if (!(s in fixes)) return [s];
  if (fixes[s]) { t.textContent = fixes[s]; return [fixes[s]]; }
  t.remove();
  return [];
})"""


def shoot(items):
    """흐름 HTML 을 열어 그림 SVG 를 PNG 로 찍는다. {html 경로: png 경로}. 하나라도 실패하면 멈춘다."""
    from playwright.sync_api import sync_playwright
    os.makedirs(PNG, exist_ok=True)
    out = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1800, "height": 1200}, color_scheme="light", device_scale_factor=2)
        for key, folder, wf, path in items:
            png = os.path.join(PNG, f"{key}-{folder}.png")
            try:
                page.goto("file://" + path)
                page.wait_for_load_state("networkidle")
                vb = wf["meta"].get("viewBox")
                sel = f"svg[viewBox='0 0 {vb[0]} {vb[1]}']" if vb else "svg[data-quality-profile]"
                svg = page.locator(sel).first
                texts = svg.evaluate("s => [...s.querySelectorAll('text')].map(t => t.textContent.trim())")
                fixes = {t: strip_issue(FIGURE_FIXES.get(t, t)) for t in set(texts)}
                labels = svg.evaluate(FIX_LABELS, {a: b for a, b in fixes.items() if a != b})
                bad = sorted({t for t in labels for rx in (INTERNAL, TEAM, TEAM_NAMES, DATE) if rx.search(t)}
                             | {t for t in labels if issues_left(t)})
                if bad:
                    raise RuntimeError(f"그림에 내부 메모가 남음: {bad}")
                box = svg.bounding_box()
                if not box or box["width"] < 300 or box["height"] < 150:
                    raise RuntimeError(f"그림 크기 {box}")
                svg.screenshot(path=png)
            except Exception as e:  # 빈 칸을 두지 않는다
                browser.close()
                raise SystemExit(f"{key}/{folder} 그림을 찍지 못했습니다: {e}")
            out[path] = png
        browser.close()
    return out


def write(version):
    """워드를 쓰고 (경로, 흐름 수, 그림 수, 단계 수, 지운 조각 수) 를 돌려준다."""
    source = json.load(open(SOURCE_JSON, encoding="utf-8"))
    groups = flows()
    ISSUE_REMOVED.clear()
    pngs = shoot([(k, f, wf, p) for k, _, items in groups for f, wf, p in items])
    d, doc_name, doc_no = open_docx("FLOW", version)
    heading(d, "머리말", 1)
    para(d, [("원본 커밋", True)])
    table(d, ["클라이언트", "저장소", "커밋", "커밋 시각"],
          [[lbl, source[k]["repo"] + " " + source[k]["ref"], source[k]["commit"], source[k]["committedAt"]]
           for k, lbl, _ in CLIENTS], widths=[3, 4, 6, 4])
    para(d, [("단계 표 ", True), ("단계는 열 순서(같은 열 안에서는 선의 방향, 순서가 없으면 레인 순서), 구간은 그 열이 드는 구간, "
                                "화면 · 주체는 레인, 유형은 노드 종류의 범례 이름, 내용은 노드 이름과 보조 설명, "
                                "다음 · 분기는 그 노드에서 나가는 선의 대상과 선 이름이다.", False)])
    figures, total = 0, 0
    for key, label, items in groups:
        heading(d, label, 1)
        for folder, wf, path in items:
            heading(d, clean(wf["meta"]["title"]), 2)
            picture(d, pngs[path], width_cm=17)
            figures += 1
            rows = steps(wf)
            if len(rows) != len(wf["nodes"]):
                raise SystemExit(f"{key}/{folder}: 단계 {len(rows)} · 노드 {len(wf['nodes'])}")
            total += len(rows)
            table(d, HEADERS, rows, widths=WIDTHS)
            for card in wf.get("cards", []):
                kept = [x for x in (card_item(wf["meta"]["title"], card.get("title", ""), i)
                                    for i in card.get("items", [])) if x]
                if kept:
                    para(d, [(clean(card.get("title", "")), True)])
                    for item in kept:
                        para(d, clean(item), style="List Bullet")
    texts = [p.text for p in d.paragraphs] + [c.text for t in d.tables for r in t.rows for c in r.cells]
    leaks = sorted({m.group() for t in texts for rx in (INTERNAL, TEAM, TEAM_NAMES) for m in rx.finditer(t)})
    if leaks:
        raise SystemExit(f"내부 표지 · 팀 표시 · 팀원 실명이 남음: {leaks}")
    left = sorted({x for t in texts for x in issues_left(t)})
    if left:
        raise SystemExit(f"쟁점 번호가 남음: {left}")
    n = sum(len(items) for _, _, items in groups)
    path = save_docx(d, f"{doc_no}_{doc_name}.docx")
    record_basis("FLOW", version, path, source_basis(SOURCE_JSON))
    return path, n, figures, total, len(REMOVED)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version")
    ap.add_argument("--snapshot", action="store_true")
    a = ap.parse_args()
    if a.snapshot:
        for k, v in snapshot().items():
            print(f"{k}: {v['repo']} {v['commit']} · 파일 {v['files']}")
        return
    if not a.version:
        ap.error("--version 이 필요합니다")
    path, n, figures, total, removed = write(a.version)
    print(f"{path}\n흐름 {n} · 그림 {figures} · 단계 {total} · 지운 결정 기록 조각 {removed} · 지운 쟁점 번호 {len(ISSUE_REMOVED)}")


if __name__ == "__main__":
    main()
