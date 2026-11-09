"""유저플로우 자체 검사 — .venv/bin/python test_build_userflow.py

1) 작은 흐름으로 단계 표 순서 · 칸을 확인하고, 2) 실제 스냅숏의 흐름 수 = 문서 절 수, 흐름마다 단계 수 = 노드 수,
그림이 빠진 흐름 0건, 내부 표지 0건인지 본다.
"""
import json
import re

from docx import Document

import build_userflow as B
from common import INTERNAL, TEAM_NAMES

wf = {"meta": {"legend": {"entries": {"frontend": {"label": "앱 화면"}}}},
      "lanes": [{"id": "app", "label": "앱"}, {"id": "sys", "label": "시스템"}],
      "phases": [{"label": "진입", "fromCol": 0, "toCol": 0}],
      "nodes": [{"id": "b", "lane": "sys", "col": 0, "type": "backend", "label": "판정", "tag": "S-ABCDEF"},
                {"id": "a", "lane": "app", "col": 0, "type": "frontend", "label": "열기", "sublabel": "지도", "tag": "ATT-3"},
                {"id": "c", "lane": "app", "col": 1, "type": "frontend", "label": "찍기"}],
      "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c", "label": "허용"}, {"from": "b", "to": "a", "label": "거부"}]}
rows = B.steps(wf)
assert rows == [["1", "진입", "앱", "앱 화면", "열기\n지도 (ATT-3)", "→ 판정"],
                ["2", "진입", "시스템", "backend", "판정", "→ 찍기 (허용)\n→ 열기 (거부)"],  # Manyfast ID tag 는 뺀다
                ["3", "", "앱", "앱 화면", "찍기", ""]], rows

# 같은 열에서 위 레인 쪽으로 가는 선: 레인 순서가 아니라 선의 방향을 따른다
up = {"lanes": [{"id": "a"}, {"id": "b"}],
      "nodes": [{"id": "top", "lane": "a", "col": 0}, {"id": "low", "lane": "b", "col": 0}],
      "edges": [{"from": "low", "to": "top"}]}
assert [x["id"] for x in B.ordered(up, {"a": 0, "b": 1})] == ["low", "top"]
assert B.card_item("흐름", "카드", "탈퇴 조건은 미정산 없음 · 약관 전문은 법무 검토 전 초안 · 끝낸다(1팀 MYPAGE-3)") \
    == "탈퇴 조건은 미정산 없음 · 끝낸다"

path, n, figures, total, removed = B.write("1.0")
groups = B.flows()
want = [wf for _, _, items in groups for _, wf, _ in items]
source = json.load(open(B.SOURCE_JSON, encoding="utf-8"))
assert [len(items) for _, _, items in groups] == [15, 5] and len(want) == n == 20, [len(i) for _, _, i in groups]
assert all(re.fullmatch(r"[0-9a-f]{40}", source[k]["commit"]) for k, _, _ in B.CLIENTS)

doc = Document(path)
h2 = [p.text for p in doc.paragraphs if p.style.name == "Heading 2"]
assert len(h2) == n, (len(h2), n)
assert h2 == [B.clean(w["meta"]["title"]) for w in want]
steps = [t for t in doc.tables if [c.text for c in t.rows[0].cells] == B.HEADERS]
assert [len(t.rows) - 1 for t in steps] == [len(w["nodes"]) for w in want], "단계 수 ≠ 노드 수"
# 그림: 절마다 제목 바로 다음 단락에 그림 하나
pics_after = 0
heads = [p for p in doc.paragraphs if p.style.name == "Heading 2"]
for h in heads:
    nxt = h._p.getnext()
    pics_after += bool(nxt is not None and nxt.xpath(".//pic:pic"))
assert figures == len(doc.inline_shapes) == pics_after == n, (figures, len(doc.inline_shapes), pics_after)

texts = [p.text for p in doc.paragraphs] + [c.text for t in doc.tables for r in t.rows for c in r.cells]
leaks = sorted({m.group() for t in texts for m in INTERNAL.finditer(t)})
assert not leaks, f"내부 표지가 남음: {leaks}"
cells = "\0".join(texts)
for memo in ("두 팀 문서가 다르다", "협의 전 미정", "법무 검토 전 초안", "1팀", "3팀"):
    assert memo not in cells, memo
assert not TEAM_NAMES.search(cells)
reverse = 0  # 같은 열에서 단계 번호가 선과 거꾸로 가는 선(순환 제외)
for w in want:
    lanes = {x["id"]: i for i, x in enumerate(w["lanes"])}
    index = {x["id"]: i for i, x in enumerate(B.ordered(w, lanes))}
    col = {x["id"]: x["col"] for x in w["nodes"]}
    pairs = {(e["from"], e["to"]) for e in w["edges"]}
    reverse += sum(col[e["from"]] == col[e["to"]] and index[e["from"]] > index[e["to"]]
                   and (e["to"], e["from"]) not in pairs for e in w["edges"])
assert reverse == 0, reverse
emails = set(re.findall(r"[\w.*+-]+@[\w.-]+\.[A-Za-z]{2,}", cells))
assert all(e.endswith("@example.com") for e in emails), emails
assert not re.search(r"[가-힣.]\(\s*\)|\s\(\s*\)|, \)|\(, ", cells), "빈 괄호 · 「, )」가 남음"
print(f"ok — 흐름 {n} = 절 {len(h2)} · 단계 {total} = 노드 수 · 그림 {figures} 빠짐 0 · 내부 표지 0 · 지운 조각 {removed}")
