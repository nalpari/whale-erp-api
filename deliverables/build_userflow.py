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

from common import HERE, INTERNAL, OUT, heading, open_docx, para, picture, safe, save_docx, strip_records, table

FLOW = os.path.join(HERE, "sources", "flow")
SOURCE_JSON = os.path.join(FLOW, "SOURCE.json")
V2 = os.path.expanduser("~/IdeaProjects/whale-erp-v2")
CLIENTS = [("admin", "관리자 웹", "whale-erp-front"), ("staff", "직원 근무 앱", "whale-erp-staff")]
PNG = os.path.join(OUT, "flow_png")
HEADERS = ["단계", "구간", "화면 · 주체", "유형", "내용", "다음 · 분기"]
WIDTHS = [1.2, 2.2, 2.8, 2.2, 4.4, 4.2]
REMOVED = []


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


def clean(text):
    return safe(strip_records(" ".join((text or "").split()), REMOVED))


def steps(wf):
    """단계 표 줄. 순서는 열(col) → 레인 순서. 칸 매핑은 계획 문서의 표."""
    lanes = {l["id"]: (i, l.get("label", l["id"])) for i, l in enumerate(wf["lanes"])}
    legend = wf["meta"].get("legend", {}).get("entries", {})
    label = {n["id"]: n.get("label", n["id"]) for n in wf["nodes"]}
    nodes = sorted(wf["nodes"], key=lambda n: (n["col"], lanes[n["lane"]][0]))
    rows = []
    for i, n in enumerate(nodes, 1):
        phase = next((p["label"] for p in wf.get("phases", []) if p["fromCol"] <= n["col"] <= p["toCol"]), "")
        tag = n.get("tag") if n.get("tag") and not INTERNAL.search(n["tag"]) else ""
        content = "\n".join(x for x in (n.get("label", ""), n.get("sublabel", "")) if x) + (f" ({tag})" if tag else "")
        nexts = "\n".join(f"→ {label.get(e['to'], e['to'])}" + (f" ({e['label']})" if e.get("label") else "")
                          for e in wf["edges"] if e["from"] == n["id"])
        rows.append([str(i), phase, lanes[n["lane"]][1], legend.get(n["type"], {}).get("label", n["type"]),
                     content, nexts])
    return [[clean(c) if "\n" not in c else "\n".join(clean(x) for x in c.split("\n")) for c in r] for r in rows]


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
    pngs = shoot([(k, f, wf, p) for k, _, items in groups for f, wf, p in items])
    d, doc_name, doc_no = open_docx("FLOW", version)
    heading(d, "머리말", 1)
    para(d, [("원본 ", True), ("관리자 웹 · 직원 근무 앱 저장소의 docs/flow(흐름마다 workflow.json 과 그림 HTML). "
                              "1팀 화면 흐름도 들어 있다.", False)])
    table(d, ["클라이언트", "저장소", "커밋", "커밋 시각"],
          [[lbl, source[k]["repo"] + " " + source[k]["ref"], source[k]["commit"], source[k]["committedAt"]]
           for k, lbl, _ in CLIENTS], widths=[3, 4, 6, 4])
    para(d, [("단계 표 ", True), ("workflow.json 의 값만 옮겼다. 단계는 열 순서(같은 열이면 레인 순서), 구간은 그 열이 드는 구간, "
                                "화면 · 주체는 레인, 유형은 노드 종류의 범례 이름, 내용은 노드 이름과 보조 설명(관련 번호), "
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
                para(d, [(clean(card.get("title", "")), True)])
                for item in card.get("items", []):
                    para(d, clean(item), style="List Bullet")
    texts = [p.text for p in d.paragraphs] + [c.text for t in d.tables for r in t.rows for c in r.cells]
    leaks = sorted({m.group() for t in texts for m in INTERNAL.finditer(t)})
    if leaks:
        raise SystemExit(f"내부 표지가 남음: {leaks}")
    n = sum(len(items) for _, _, items in groups)
    path = save_docx(d, f"{doc_no}_{doc_name}.docx")
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
    print(f"{path}\n흐름 {n} · 그림 {figures} · 단계 {total} · 지운 결정 기록 조각 {removed}")


if __name__ == "__main__":
    main()
