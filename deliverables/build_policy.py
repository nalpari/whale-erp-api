"""운영 정책서(WHALE-POL) — sources/운영정책.html(운영 정책 아티팩트 스냅숏)을 워드로 낸다.

    .venv/bin/python build_policy.py --version 1.0

원본의 장(h2) · 소제목 순서를 따르되 「근거」 장은 빼고, 규칙은 「번호 + 본문」으로 싣는다. 출처 줄(span.src)은 싣지 않고,
본문의 결정 기록 괄호 조각은 지운다(common.strip_records). 원본 규칙 수와 문서 규칙 수가 다르면 멈춘다.
"""
import argparse
import os
import re

from lxml import html

from common import HERE, INTERNAL, TEAM, TEAM_NAMES, heading, open_docx, para, safe, save_docx, strip_records, table

SOURCE = os.path.join(HERE, "sources", "운영정책.html")
# 파일 안에 버전 표기가 없다. v271 · 복사일은 2026-11-09 지시(header 전달)에서 온 값이다.
SOURCE_VERSION, COPIED = "v271", "2026-11-09"
RULES = 220  # 원본 div.rule 수. 스냅숏을 바꾸면 함께 고친다.
DROP_CHAPTER = "근거"  # 팀원 실명 · 내부 논의가 담긴 장. 납품본에서 뺀다(규칙 없음).
# 문장 속 내부 표지 · 결정 표시를 바꾼다(원문 → 바꾼 글). 문장 자체가 결정 표시뿐이면 문장째 뺀다. 원문에서 못 찾으면 멈춘다.
SENTENCE_FIXES = {
    "셈법은 front #15 구현을 따른다": "셈법은 구현을 따른다",
    " 수정 요청을 진행 중인 계약에 넣은 것은 2026-10-19 재영.": "",
    " 수정 요청을 겹침 대상에 넣은 것은 2026-10-19 재영.": "",
    "(임시저장은 2026-10-12 재영, 수정 요청은 2026-10-19 재영 추가)": "",
    ", 넷째는 2026-10-27 재영": "",
    "질문 14 확인 뒤 2026-10-28 재영 유지": "질문 14",
    "상태 8종(2026-10-12 임시저장 · 2026-10-16 수정 요청 추가) · 원본 표시와 서명 보관 2026-09-16 확정":
        "상태 8종 · 원본 표시와 서명 보관",
    "GPS 판정으로 전면 교체 · 2026-09-10": "GPS 판정으로 전면 교체",
    "외부 검토 4 · 2차로 미룸 1 · 2026-09-29 확인": "외부 검토 4 · 2차로 미룸 1",
    # 팀 간 할 일 · 목업 언급: 문장째 뺀다(\x01 · \x02 는 굵게 표시)
    " 1팀 초기 데이터 요청서(출·퇴근 현황 R)와 다르므로 1팀에 알린다.": "",
    " 1팀 회원 탈퇴 화면에는 탈퇴 전에 내려받으라는 안내와 바로가기를 넣도록 1팀에 제안한다.": "",
    " 확인 전까지 목업은 10원 단위 반올림으로 둔다(2026-10-08 재영).": "",
    "직원 근무 앱 목업에는 화면 구성에 관한 미정 쟁점이 더 남아 있습니다. 알림함 보관 기간(NOTI-3) 등입니다. "
    "정책이 아니라 화면 결정이라 이 문서에는 싣지 않았습니다.": "",
    "ACC-20까지와 ACC-22·ACC-23은 직원 계정에 관한 것이고 3팀이 정합니다.\x02 관리자 로그인·사업자 회원가입·계정 찾기·마이페이지 화면은 "
    "1팀 영역이라 ACC-02·ACC-03·ACC-21에는 \x011팀이 정한 값\x02과 3팀이 그 위에서 쓰는 것만 적었습니다. "
    "1팀은 2026년 9월 23일에 이 세 자리를 모두 확정했습니다.": "ACC-20까지와 ACC-22·ACC-23은 직원 계정에 관한 것입니다.\x02",
    " 안내에는 \x01가맹 점포 직원 자료는": " 회원 탈퇴 화면의 안내에는 \x01가맹 점포 직원 자료는",  # 앞 문장을 뺀 RET-09
    # 팀 표시만 뺀다
    "\x011팀이 정했다.\x02 사업자 회원가입과 그 화면은 1팀 영역이다. ": "",
    "3팀이 쓰는 것은 \x01가맹점은 가입하지 않고 본사가 만들어 준 계정으로 로그인한다\x02는 사실 하나뿐이다.":
        "\x01가맹점은 가입하지 않고 본사가 만들어 준 계정으로 로그인한다.\x02",
    "\x011팀이 정했다.\x02 웹 로그인 화면의 구성과 관리자 로그인 식별자는 1팀 영역이다. ": "",
    "3팀이 쓰는 것은 \x01직원은 웹으로 로그인하지 않고 직원 근무 앱으로 들어온다\x02는 것과, 그 화면에 초대 확인 탭을 두지 않는다는 것이다.":
        "\x01직원은 웹으로 로그인하지 않고 직원 근무 앱으로 들어온다.\x02 웹 로그인 화면에 초대 확인 탭을 두지 않는다.",
    "\x011팀이 정했다.\x02 관리자 웹에서": "관리자 웹에서",
    "비로그인 홈은 3팀이 만들고 완료 문구를": "비로그인 홈에는 완료 문구를",
    "은 1팀 점포 api가 하고, 직원·근로계약 정리는 3팀 서비스 둘을": "은 점포 api가 하고, 직원·근로계약 정리는 서비스 둘을",
    "은 1팀 폐점 트랜잭션": "은 폐점 트랜잭션",
    "점포 테이블(1팀)에": "점포 테이블에",
    "\x011팀 관리자 메일 8종\x02": "\x01관리자 메일 8종\x02",
    "맡고, 1팀 메일 발송 기록은": "맡고, 메일 발송 기록은",
    "(1팀 메일 발송 기록에는": "(메일 발송 기록에는",
    "1팀 점포 이미지(": "점포 이미지(",
    "1팀 권한 그룹(": "권한 그룹(",
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
            if clean(marked(el)):  # 문단째 뺀 것은 빈 줄을 남기지 않는다
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
    para(d, [("원본 ", True), (f"운영 정책 {SOURCE_VERSION}. 복사한 날 {COPIED}.", False)])
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

    all_sections = wrap.findall("section")
    sections = [s for s in all_sections if not (s.find("h2").text or "").strip().startswith(DROP_CHAPTER)]
    if len(all_sections) - len(sections) != 1:
        raise SystemExit(f"「{DROP_CHAPTER}」 장을 하나 찾아야 합니다: 뺀 장 {len(all_sections) - len(sections)}")
    rules = sum(write_section(d, s) for s in sections)
    if rules != RULES or len(root.xpath('//div[@class="rule"]')) != RULES:
        raise SystemExit(f"원본 규칙 {RULES} · 문서 {rules} 이 다릅니다.")
    lost = sorted(set(SENTENCE_FIXES) - FIXED)
    if lost:
        raise SystemExit(f"SENTENCE_FIXES 의 원문을 찾지 못했습니다(원문이 바뀌었는지 확인): {lost}")
    texts = [p.text for p in d.paragraphs] + [c.text for t in d.tables for r in t.rows for c in r.cells]
    leaks = sorted({m.group() for t in texts for rx in (INTERNAL, TEAM, TEAM_NAMES) for m in rx.finditer(t)})
    if leaks:
        raise SystemExit(f"내부 표지 · 팀 표시 · 팀원 실명이 남음: {leaks}")
    path = save_docx(d, f"{doc_no}_{doc_name}.docx")
    return path, rules, len(sections), len(REMOVED)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    path, rules, chapters, removed = write(ap.parse_args().version)
    print(f"{path}\n규칙 {rules} · 장 {chapters}(+ 머리말) · 지운 결정 기록 조각 {removed} · 문장 속 표지 바꿈 {len(FIXED)}")


if __name__ == "__main__":
    main()
