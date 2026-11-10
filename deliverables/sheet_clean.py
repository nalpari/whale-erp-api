"""엑셀 납품본의 내부 기록 정리와 근로계약 옛 상태 이름 바꾸기, 납품본 점검(요구사항정의서 · 테이블정의서 · API 명세).

원문(Manyfast · schema.prisma · Swagger)은 고치지 않고 문서를 만들 때만 바꾼다. 남으면 생성을 멈춘다.
"""
import os
import re
from collections import Counter

from build_policy import is_issue, issues_left, strip_issues
from common import INTERNAL, OUT, TEAM, TEAM_NAMES, strip_records

STATE_WORDS = {"임시저장": "작성 중", "수정 요청": "직원 수정 요청", "거부": "서명 거절", "만료": "계약 기간 만료", "종료": "계약 종료"}
_WORD = "(?:임시저장|수정 요청|거부|만료|종료)"
_SEP = r"(?:·| · |, )"
# 근로계약 상태 나열. 「미가입」과 묶인 나열은 초대 상태일 수 있어 건드리지 않는다.
STATE_LIST = re.compile(rf"(?<![가-힣])(?<!미가입·)(?<!동의 ){_WORD}(?:{_SEP}{_WORD})+(?=[^가-힣]|$|돼|된|되)")
# 문맥이 근로계약 상태로 정해지는 말만 바꾼다. 나머지 「거부」 · 「만료」 등은 다른 뜻일 수 있어 두고 목록으로 낸다.
PHRASES = [
    # 받침이 달라지는 조사를 함께 바꾼다
    (re.compile(r"발송 대기로(?![가-힣])"), "서명 요청 전으로"), (re.compile(r"발송 대기가(?![가-힣])"), "서명 요청 전이"),
    (re.compile(r"발송 대기는(?![가-힣])"), "서명 요청 전은"), (re.compile(r"발송 대기를(?![가-힣])"), "서명 요청 전을"),
    (re.compile(r"발송 대기와(?![가-힣])"), "서명 요청 전과"), (re.compile(r"발송 대기"), "서명 요청 전"),
    (re.compile(r"(?<!직원 )서명 대기"), "직원 서명 대기"),
    (re.compile(r"체결 완료"), "서명 완료"),
    (re.compile(r"(?<![가-힣])거부와 만료"), "서명 거절과 계약 기간 만료"),
    (re.compile(r"(?<=근로계약 )거부(?=[,·\s]|$)"), "서명 거절"),
    (re.compile(r"(?<![가-힣])거부(?=로 (?:변경|처리|닫|확정|바꾼)|된 (?:계약|근로계약|경우|뒤)| 상태| 후에는| 또는 만료)"), "서명 거절"),
    (re.compile(r"(?<=상태가 )거부|(?<=상태를 )거부|(?<=상태는 )거부"), "서명 거절"),
    (re.compile(r"(?<=또는 )만료(?=된 계약)|(?<![가-힣 ])만료(?= 상태)"), "계약 기간 만료"),
    (re.compile(r"(?<![가-힣])임시저장(?= (?:계약|근로계약|상태|초안))|(?<=상태가 )임시저장"), "작성 중"),
    (re.compile(r"(?<![가-힣])(?<!직원 )수정 요청(?= 상태|으로 (?:전환|변경|바꾼))|(?<=상태가 )수정 요청"), "직원 수정 요청"),
]
GONE = re.compile(r"연결 보류|본인인증|가입 연결")
# 근로계약 문맥에 남은 옛 말: 자동으로 바꾸지 않고 목록으로 낸다
AMBIGUOUS = re.compile(r"(?:계약|날인|재발송|서명).{0,25}(?<![가-힣])(?:거부|만료|종료|임시저장)|(?<![가-힣])(?:거부|만료|종료|임시저장).{0,25}(?:계약|날인|재발송|서명)")
COUNTS = Counter()
_TAIL = re.compile(r"\s*\(\s*\)|\s+(?=[.,)])")


def _drop_issue_chain(line):
    """「HOME-2·WORK-4」처럼 붙여 쓴 쟁점 번호와 앞의 「목업」을 지운다. 운영 정책 번호는 남긴다."""
    def drop(m):
        tokens = re.split(r"[·,]\s*", m.group())
        kept = [t for t in tokens if not is_issue(t)]
        return "·".join(kept)
    out = re.sub(r"(?<![A-Za-z0-9_-])[A-Z]{2,}-\d+(?:[·,]\s*[A-Z]{2,}-\d+)*", drop, line)
    if out == line:
        return line
    out = re.sub(r"(?:,\s*)?목업(?=\s*[),]|\s*$)", "", out)
    out = re.sub(r"\(\s*[,·]\s*|\s*[,·]\s*\)", lambda m: "(" if "(" in m.group() else ")", out)
    return re.sub(r"\s*\([가-힣]?\s*\)", "", out)


def _strip_internal(line):
    """이름 · 쟁점 번호 · 팀 표시를 지운다. 괄호 안이면 괄호째, 그 밖이면 낱말만."""
    out = _drop_issue_chain(strip_issues(strip_records(line)))
    out = INTERNAL.sub("", out)
    out = re.sub(r"\s*\([^()]*(?:" + TEAM_NAMES.pattern + r"|" + TEAM.pattern + r")[^()]*\)", "", out)
    out = TEAM.sub("", out)
    out = TEAM_NAMES.sub("", out)
    out = re.sub(r"\b쟁점\s*", "", out).replace("쟁점", "")
    if out == line:
        return line
    out = re.sub(r"\(\s*[,·]\s*", "(", re.sub(r"\s*[,·]\s*\)", ")", out))
    return re.sub(r"  +", " ", _TAIL.sub("", out)).strip()


def _map_list(m):
    return re.sub(_WORD, lambda w: STATE_WORDS[w.group()], m.group())


def states(line):
    new = STATE_LIST.sub(_map_list, line)
    for rx, repl in PHRASES:
        new = rx.sub(repl, new)
    return new


def clean_text(text):
    lines = []
    for line in text.split("\n"):
        out = _strip_internal(line)
        if out != line:
            COUNTS["내부 표시 지움"] += 1
        stated = states(out)
        if stated != out:
            COUNTS["상태 이름 바꿈"] += 1
        if stated.strip(" -·") or not line.strip(" -·"):
            lines.append(stated)
        else:
            COUNTS["빈 줄이 되어 뺀 줄"] += 1
    return "\n".join(lines)


def apply_fixes(wb, fixes, skip=None):
    """없앤 개념을 지금 기능처럼 적은 문장을 바꾼다(원문 → 바꾼 글). 원문을 못 찾으면 멈춘다."""
    found = set()
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and not (skip and skip(ws, c)):
                    for a, b in fixes.items():
                        if a in c.value:
                            found.add(a)
                            c.value = c.value.replace(a, b)
    lost = sorted(set(fixes) - found)
    if lost:
        raise SystemExit(f"고칠 문장을 찾지 못했습니다(원문이 바뀌었는지 확인): {lost}")
    COUNTS["없앤 개념 문장 고침"] = len(found)


def expected(text, fixes=None):
    """자체 검사용: 원문이 문서에서 어떤 글이 되는지."""
    out = clean_text(text)
    for a, b in (fixes or {}).items():
        out = out.replace(a, b)
    return out


def left_in(text):
    return (INTERNAL.findall(text) + TEAM.findall(text) + [m.group() for m in TEAM_NAMES.finditer(text)] + issues_left(text))


def deliver(wb, abbr, fixes=None, skip=None):
    """정리 · 점검을 하고 판단이 갈리는 칸을 out/ 에 적는다. 내부 표시가 남으면 멈춘다."""
    leaks, review = sanitize(wb, skip, fixes)
    if leaks:
        raise SystemExit(f"납품본에 내부 표시가 남음: {sorted(set(leaks))[:20]}")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"정리 검토 목록_{abbr}.tsv"), "w", encoding="utf-8") as f:
        f.writelines(f"{sheet}\t{cell}\t{text!r}\n" for sheet, cell, text in review)
    return dict(COUNTS), len(review)


def sanitize(wb, skip=None, fixes=None):
    """모든 시트의 글자 칸을 정리하고 (점검에 걸린 값, 판단이 갈리는 칸) 을 돌려준다. skip 은 (시트, 칸) 으로 뺄 칸을 정하는 함수."""
    COUNTS.clear()
    leaks, review = [], []
    pending = fixes or {}
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if not isinstance(c.value, str) or (skip and skip(ws, c)):
                    continue
                c.value = clean_text(c.value)
                leaks += [f"{ws.title}: {x}" for x in left_in(c.value)]
                if AMBIGUOUS.search(c.value) or GONE.search(c.value):
                    review.append((ws.title, c.coordinate, c.value))
    if pending:
        apply_fixes(wb, pending, skip)
    return leaks, review
