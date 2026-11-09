"""운영 정책서(WHALE-POL) — sources/운영정책.html(운영 정책 아티팩트 스냅숏)을 워드로 낸다.

    .venv/bin/python build_policy.py --version 1.0

원본의 장(h2) · 소제목 순서를 그대로 따르고, 규칙은 「번호 + 본문」으로 싣는다. 출처 줄(span.src)은 싣지 않고,
본문의 결정 기록 괄호 조각은 지운다(common.strip_records). 원본 규칙 수와 문서 규칙 수가 다르면 멈춘다.
"""
import argparse
import os
import re

from lxml import html

from common import HERE, INTERNAL, heading, open_docx, para, safe, save_docx, strip_records, table

SOURCE = os.path.join(HERE, "sources", "운영정책.html")
# 파일 안에 버전 표기가 없다. v269 · 복사일은 2026-11-05 지시(header 전달)에서 온 값이다.
SOURCE_VERSION, COPIED = "v269", "2026-11-05"
RULES = 220  # 원본 div.rule 수. 스냅숏을 바꾸면 함께 고친다.
# 괄호 밖 문장 본문의 내부 표지는 표지만 지운다(원문 → 바꾼 글). 원문에서 못 찾으면 멈춘다.
SENTENCE_FIXES = {
    "셈법은 front #15 구현을 따른다": "셈법은 구현을 따른다",
    "노영주가 api #85로 정한": "노영주가 정한",
}
# 괄호 없이 문장 뒤에 붙은 결정 표시(「…정한다. 2026-09-29 재영」). 문장 안의 날짜 · 이름은 건드리지 않는다.
STAMP = re.compile(r"(?<=[.)])\s+\d{4}-\d{2}-\d{2} 재영(?=\s|$)")
B0, B1 = "\x01", "\x02"  # 굵게 시작 · 끝 표시
REMOVED, FIXED = [], set()


def marked(el):
    """요소의 글. <b> 는 표시로 감싸고, 출처 줄은 빼고(꼬리 글은 남긴다), 링크 · em · code 는 글자만."""
    out = [el.text or ""]
    for c in el:
        cls = c.get("class") or ""
        if not (c.tag == "span" and "src" in cls.split()):
            inner = marked(c)
            out.append(f"{B0}{inner}{B1}" if c.tag in ("b", "strong") else " " if c.tag == "br" else inner)
        out.append(c.tail or "")
    return "".join(out)


def clean(text):
    """공백 정규화 → 문장 속 표지 바꾸기 → 결정 기록 괄호 지우기 → 예시 이메일 · 번호."""
    text = " ".join(text.split())
    for a, b in SENTENCE_FIXES.items():
        if a in text:
            FIXED.add(a)
            text = text.replace(a, b)
    text = STAMP.sub(lambda m: REMOVED.append((m.group().strip(), "문장 뒤 결정 표시")) or "", text)
    return safe(strip_records(text, REMOVED))


def runs(text):
    """표시가 든 글을 [(글, 굵게)] 로. 표시가 짝이 안 맞으면 멈춘다."""
    out, bold = [], False
    for piece in re.split(f"([{B0}{B1}])", text):
        if piece == B0:
            if bold:
                raise SystemExit(f"굵게 표시가 겹침: {text[:80]}")
            bold = True
        elif piece == B1:
            if not bold:
                raise SystemExit(f"굵게 표시 짝이 없음: {text[:80]}")
            bold = False
        elif piece:
            out.append((piece, bold))
    if bold:
        raise SystemExit(f"굵게 표시가 닫히지 않음: {text[:80]}")
    return out


def plain(el):
    return clean(marked(el)).replace(B0, "").replace(B1, "")


def has(el, cls):
    return cls in (el.get("class") or "").split()


def write_section(d, sec):
    """장 하나. 규칙 수를 돌려준다."""
    h2 = sec.find("h2")
    sub = [s for s in h2 if s.tag == "span" and has(s, "sub")]
    code = [s for s in h2 if s.tag == "span" and has(s, "code")]
    title = " ".join(x for x in ([plain(code[0])] if code else []) +
                     [" ".join(((h2.text or "") + "".join(s.tail or "" for s in h2)).split())] if x)
    heading(d, title, 1)
    for s in sub:
        para(d, plain(s))
    n = 0
    for el in sec:
        if el is h2 or not isinstance(el.tag, str):
            continue
        if el.tag == "p":
            para(d, runs(clean(marked(el))))
        elif has(el, "gh"):
            heading(d, plain(el), 2)
        elif has(el, "group"):
            for r in el.iter("div"):
                if has(r, "rule"):
                    rid, txt = r.find("span"), r.findall("span")[1]
                    para(d, [(rid.text_content().strip(), True), (" ", False)] + runs(clean(marked(txt))))
                    n += 1
        elif has(el, "flow"):
            para(d, " ".join(s.text_content().replace("\xa0", " ").strip() for s in el if s.text_content().strip()))
        elif has(el, "scroll"):
            rows = [[plain(c) for c in tr if c.tag in ("th", "td")] for tr in el.iter("tr")]
            table(d, rows[0], rows[1:], widths=[3.5, 3.5, 9])
        elif has(el, "chips"):
            for c in el:
                para(d, plain(c), style="List Bullet")
        elif has(el, "opens"):
            for o in el:
                if not isinstance(o.tag, str) or not has(o, "open"):
                    continue
                tag = o.find("span")
                body = o.find("div")
                heading(d, plain(body.find("h3")), 2)
                for i, p in enumerate(body.findall("p")):
                    para(d, ([(f"[{plain(tag)}] ", True)] if i == 0 else []) + runs(clean(marked(p))))
        else:
            raise SystemExit(f"모르는 요소: <{el.tag} class={el.get('class')}>")
    return n


def write(version):
    """워드를 쓰고 (경로, 규칙 수, 장 수, 지운 조각 수) 를 돌려준다."""
    root = html.fromstring(open(SOURCE, encoding="utf-8").read())
    wrap = root.xpath('//div[@class="wrap"]')[0]
    d, doc_name, doc_no = open_docx("POL", version)

    head = wrap.find("header")
    heading(d, "머리말", 1)
    para(d, [("원본 ", True), (f"운영 정책 아티팩트 {SOURCE_VERSION}(whale-erp-v2 docs/raw/운영정책.html). 복사한 날 {COPIED}. "
                              "출처 줄과 내부 결정 기록은 싣지 않았다.", False)])
    for el in head:
        if not isinstance(el.tag, str):
            continue
        if has(el, "eyebrow") or has(el, "lede"):
            para(d, runs(clean(marked(el))))
        elif has(el, "changes"):
            heading(d, plain(el.find("h3")), 2)
            para(d, runs(clean(marked(el.find("p")))))
    footer = wrap.find("footer")
    para(d, " · ".join(plain(s) for s in footer))

    sections = wrap.findall("section")
    rules = sum(write_section(d, s) for s in sections)
    if rules != RULES or len(root.xpath('//div[@class="rule"]')) != RULES:
        raise SystemExit(f"원본 규칙 {RULES} · 문서 {rules} 이 다릅니다.")
    lost = sorted(set(SENTENCE_FIXES) - FIXED)
    if lost:
        raise SystemExit(f"SENTENCE_FIXES 의 원문을 찾지 못했습니다(원문이 바뀌었는지 확인): {lost}")
    leaks = sorted({m.group() for p in d.paragraphs for m in INTERNAL.finditer(p.text)})
    if leaks:
        raise SystemExit(f"내부 표지가 남음: {leaks}")
    path = save_docx(d, f"{doc_no}_{doc_name}.docx")
    return path, rules, len(sections), len(REMOVED)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    path, rules, chapters, removed = write(ap.parse_args().version)
    print(f"{path}\n규칙 {rules} · 장 {chapters}(+ 머리말) · 지운 결정 기록 조각 {removed} · 문장 속 표지 바꿈 {len(FIXED)}")


if __name__ == "__main__":
    main()
