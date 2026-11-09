"""운영 정책서 자체 검사 — .venv/bin/python test_build_policy.py

1) 작은 예로 결정 기록 괄호 지우기를 확인하고, 2) 원본 규칙 수 · 장 수와 문서가 같은지,
3) 규칙 본문이 정리 규칙을 적용한 원문과 글자 그대로 같은지(잘림 없음), 4) 내부 표지 · 이메일을 본다.
원본은 생성기와 따로 정규식으로 읽는다(lxml 경로와 엇갈리면 잡히게).
"""
import html
import re

from docx import Document

import build_policy as B
from common import INTERNAL, TEAM_NAMES, safe, strip_records

S = strip_records
assert S("둔다(2026-10-30 재영, WHALEERP-618 · 637 리뷰).") == "둔다."
assert S("유지한다(2026-10-20 노영주, api #85). 끝") == "유지한다. 끝"
assert S("가린다(ATT-30, 2026-10-29 재영).") == "가린다(ATT-30)."
assert S("본다(쟁점 ATT-11, 2026-10-20 재영 — 09-18 「막는다」를 바꿈).") == "본다(쟁점 ATT-11)."
assert S("넣는다(2026-10-29 재영, WHALEERP-261 · 321 2차, 619 1차 유지).") == "넣는다."
assert S("바꾼다(2026-10-20 재영 — 토큰만으로 바꾸면 위험해서).") == "바꾼다(토큰만으로 바꾸면 위험해서)."
assert S("센다(노무사 답변 2026-10-14 질문 17).") == "센다(노무사 답변 2026-10-14 질문 17)."  # 외부 검토 근거는 남긴다
assert S("10월 12일(10월 12일 임시저장)") == "10월 12일(10월 12일 임시저장)"  # 결정 기록이 아니면 그대로
assert S("닫는다(앞은 종료 — 처음 「A」를 같은 날 민식 결정(WHALEERP-156)으로 정정).") == "닫는다(앞은 종료)."

assert S("보인다(구현 기준).") == "보인다."
assert S("둔다(후속 일감)") == "둔다"
assert S("간다(홈)") == "간다(홈)"  # 결정 낱말이 아닌 괄호는 그대로
assert not TEAM_NAMES.search("운영주체") and TEAM_NAMES.search("노영주")

path, rules, chapters, removed = B.write("1.0")
src = open(B.SOURCE, encoding="utf-8").read()


def text(fragment):
    fragment = re.sub(r'<span class="src">.*?</span>', "", fragment)
    fragment = re.sub(r"</?b>", lambda m: B.B0 if m.group() == "<b>" else B.B1, fragment)
    return html.unescape(re.sub(r"<[^>]+>", "", fragment))


want = [(rid, B.clean(text(body)).replace(B.B0, "").replace(B.B1, ""))
        for rid, body in re.findall(r'<div class="rule"><span class="id">([^<]+)</span><span class="txt">(.*?)</span></div>',
                                    src)]
assert len(want) == src.count('<div class="rule">') == B.RULES == rules, (len(want), rules)

doc = Document(path)
paras = [" ".join(p.text.split()) for p in doc.paragraphs]
got = {p.split(" ", 1)[0]: p for p in paras if re.match(r"[A-Z]{3}-\d{2} ", p)}
assert len(got) == rules, (len(got), rules)
diff = [rid for rid, body in want if got.get(rid) != " ".join(f"{rid} {body}".split())]
assert not diff, f"원문과 다른 규칙 {len(diff)}건: {diff[:5]}"

h1 = [p.text for p in doc.paragraphs if p.style.name == "Heading 1"]
assert len(h1) == src.count("<h2") + 1 == chapters + 2, h1  # - 근거 + 개정 이력 · 머리말
assert not any(t.startswith(B.DROP_CHAPTER) for t in h1), h1
assert len(doc.tables) == 2 + src.count("<table")  # 표지 · 개정 이력 + 원본 표

cells = "\0".join(paras + [c.text for t in doc.tables for r in t.rows for c in r.cells])
leaks = sorted({m.group() for m in INTERNAL.finditer(cells)})
assert not leaks, f"내부 표지가 남음: {leaks}"
names = sorted({m.group() for m in TEAM_NAMES.finditer(cells)})
assert not names, f"팀원 실명이 남음: {names}"
assert "whale-erp-v2" not in cells and "내부 결정 기록" not in cells
for word in ("(구현 기준)", "(구현 그대로)", "(후속 일감)", "(홈 PR 리뷰)"):
    assert word not in cells, word
assert "노무사 답변 2026-10-14 질문 14)" in cells  # 노무사 답변 괄호는 남긴다
for gone in ("2026-09-16 확정", "전면 교체 · 2026-09-10", "2026-09-29 확인"):
    assert gone not in cells, gone
for kept in ("상태 8종 · 원본 표시와 서명 보관", "GPS 판정으로 전면 교체", "외부 검토 4 · 2차로 미룸 1", "2026-10-19 기준"):
    assert kept in cells, kept
assert 'class="src"' not in cells and "STAFF-5" not in cells  # 출처 줄(예: CTR-04 의 「STAFF-5」)은 없다
emails = set(re.findall(r"[\w.*+-]+@[\w.-]+\.[A-Za-z]{2,}", cells))
assert all(e.endswith("@example.com") for e in emails), emails
assert safe("a@b.co") == "a@example.com"
assert not re.search(r"[가-힣.]\(\s*\)|\s\(\s*\)|, \)|\(, ", cells), "빈 괄호 · 「, )」가 남음"
print(f"ok — 규칙 {rules} = 원본 · 본문 모두 원문과 같음 · 장 {chapters}(+ 머리말) · 지운 조각 {removed} · 내부 표지 0 · "
      f"이메일 {len(emails)}건 example.com 뿐")
