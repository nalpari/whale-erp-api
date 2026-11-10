"""엑셀 납품본의 내부 기록 정리와 근로계약 옛 상태 이름 바꾸기, 납품본 점검(요구사항정의서 · 테이블정의서 · API 명세).

원문(Manyfast · schema.prisma · Swagger)은 고치지 않고 문서를 만들 때만 바꾼다. 팀 표시가 든 문장은 낱말을 지우면 비문이 되므로
생성기의 FIXES 로 문장 단위로 고치고, 여기서는 괄호 속 기록과 쟁점 번호만 지운다. 남으면 생성을 멈춘다.
"""
import os
import re
from collections import Counter

from build_policy import is_issue, issues_left, strip_issues
from common import INTERNAL, OUT, TEAM, TEAM_NAMES, strip_records

UNUSED = "1차에서 쓰지 않는 값"
# 이미 표준인 표기를 다시 바꾸지 않게 앞을 본다
_OLD = r"(?<![가-힣])(?:임시저장|(?<!직원 )수정 요청|(?<!서명 )거부|(?<!기간 )만료|(?<!계약 )종료)"
OLD_WORD = re.compile(_OLD)
NEW = {"임시저장": "작성 중", "수정 요청": "직원 수정 요청", "거부": "서명 거절", "만료": "계약 기간 만료", "종료": "계약 종료"}
_SEP = r"(?:·| · |, | 및 )"
# 나열에는 이미 표준인 이름이 섞일 수 있다(서명 거절 · 계약 기간 만료 · 종료). 표준 이름은 두고 옛 이름만 바꾼다.
_NEW_ITEM = r"(?:작성 중|서명 요청 전|직원 서명 대기|직원 수정 요청|서명 완료|서명 거절|계약 기간 만료|계약 종료)"
_ITEM = rf"(?:{_NEW_ITEM}|{_OLD})"
STATE_LIST = re.compile(rf"{_ITEM}(?:{_SEP}{_ITEM})+(?=[^가-힣]|$|돼|된|되|이면)")
# 근로계약 문장인지 가른다. 계정 · 세션 · 앱 푸시 · 출퇴근 문장은 같은 낱말이 다른 뜻이다.
CONTRACT = re.compile(r"계약|날인|서명|재발송")
NOT_CONTRACT = re.compile(r"세션|계정이면|토큰|로그인|푸시|출퇴근|근무스케줄|미가입|동의")
SENTENCE = re.compile(r"(?<=[다요음])\. ")
STATE_TERMS = re.compile(r"임시저장|발송 대기|(?<!직원 )서명 대기|수정 요청|체결 완료|거부|만료|종료")
_PARTICLE = {"로": "으로", "가": "이", "는": "은", "를": "을", "와": "과"}
ALWAYS = [(re.compile(r"(?<!직원 )서명 대기"), "직원 서명 대기"), (re.compile(r"체결 완료"), "서명 완료"),
          # 상태를 정의하는 줄의 머리말
          (re.compile(r"^- 거부는(?= 사유)"), "- 서명 거절은"), (re.compile(r"^- 임시저장은(?= 근로계약서)"), "- 작성 중은")]
IN_CONTRACT = [
    (re.compile(r"발송 대기([로가는를와])(?![가-힣])"), lambda m: "서명 요청 전" + _PARTICLE[m.group(1)]),
    (re.compile(r"발송 대기"), "서명 요청 전"),
    (re.compile(r"(?<![가-힣])거부와 만료"), "서명 거절과 계약 기간 만료"),
    (re.compile(r"(?<=근로계약 )거부(?=[,·\s]|$)"), "서명 거절"),
    (re.compile(r"(?<=근로계약서 )거부와"), "서명 거절과"),
    (re.compile(r"(?<![가-힣])거부(?=로 (?:변경|처리|닫|확정|바꾼)|된 (?:계약|근로계약)| 상태| 후에는| 또는 만료)"), "서명 거절"),
    (re.compile(r"(?<=상태가 )거부|(?<=상태를 )거부|(?<=상태는 )거부"), "서명 거절"),
    (re.compile(r"(?<=또는 )만료(?=된 계약)|(?<![가-힣 ])만료(?= 상태)"), "계약 기간 만료"),
    (re.compile(r"(?<![가-힣])임시저장(?= (?:계약|근로계약|상태|초안|행))|(?<=상태가 )임시저장"), "작성 중"),
    (re.compile(r"(?<![가-힣])(?<!직원 )수정 요청(?= 상태|으로 (?:전환|변경|바꾼))|(?<=상태가 )수정 요청"), "직원 수정 요청"),
]
# 상태를 차례로 늘어놓은 문장. 버튼 「종료」 는 낫표로 가른다.
_ENUM = re.compile(r"(?<!「)" + _OLD + r"(?=은|는|와|과|,|·| 및| 상태| 행|로 정의)")
GONE = re.compile(r"연결 보류|본인인증|가입 연결")
AMBIGUOUS = re.compile(r"(?:계약|날인|재발송|서명).{0,25}(?<![가-힣])(?:거부|만료|종료|임시저장|수정 요청)|(?<![가-힣])(?:거부|만료|종료|임시저장|수정 요청).{0,25}(?:계약|날인|재발송|서명)")
TOOLS = re.compile(r"Manyfast|\bMCP\b|Plane|BUZZ|Figma|Claude|Orca|목업")
WORK_NO = re.compile(r"\(\d{3}\s*·")
DOUBLE = re.compile(r"계약 기간 계약 기간|직원 직원|계약 계약 종료|서명 서명|서명 거절 서명 거절|작성 중 작성 중")
COUNTS = Counter()
_ISSUE = r"[A-Z]{2,}-\d+"
_MARKED = re.compile(rf"(?:쟁점|채쟁점)\s*{_ISSUE}(?:\s*[·,]\s*{_ISSUE})*")
_MEMO_PAREN = re.compile(r"\s*\((?:목업|PR\b)[^()]*\)|\s*\(218(?:\s*·\s*[^()]*)?\)")


def _drop_issue_chain(line):
    """붙여 쓴 쟁점 번호(HOME-2·WORK-4)와 앞의 「목업」을 지운다. 운영 정책 번호는 남긴다."""
    def drop(m):
        return "·".join(t for t in re.split(r"[·,]\s*", m.group()) if not is_issue(t))
    out = re.sub(rf"(?<![A-Za-z0-9_-]){_ISSUE}(?:[·,]\s*{_ISSUE})*", drop, line)
    return out if out == line else re.sub(r"(?:,\s*)?목업(?=\s*[),]|\s*$)", "", out)


def _drop_paren_items(line):
    """괄호 안에서 이름 · 팀 표시 · 목업이 든 조각만 지운다. 모두 지워지면 괄호째."""
    def paren(m):
        parts = re.split(r"(, | · )", m.group(1))
        items, seps = parts[0::2], [""] + parts[1::2]
        kept = [(s, t) for s, t in zip(seps, items) if not (TEAM_NAMES.search(t) or TEAM.search(t) or "목업" in t)]
        if len(kept) == len(items):
            return m.group(0)
        return f"({kept[0][1]}{''.join(s + t for s, t in kept[1:])})" if kept else ""
    return re.sub(r"\(([^()]*)\)", paren, line)


def _strip_internal(line):
    """쟁점 번호 · 괄호 속 기록 · 숫자 일감 번호를 지운다. 「쟁점」이 붙은 번호는 운영 정책 번호와 겹쳐도 지운다."""
    out = _MARKED.sub("", line)
    out = _MEMO_PAREN.sub("", out)
    out = _drop_paren_items(_drop_issue_chain(strip_issues(strip_records(out))))
    out = re.sub(r",\s*,", ",", out)
    out = INTERNAL.sub("", out)
    if out == line:
        return line
    out = re.sub(r"\(\s*[,·]?\s*", "(", re.sub(r"\s*[,·]?\s*\)", ")", out))
    out = re.sub(r"\s*\([가-힣]?\)", "", out)
    return re.sub(r"  +", " ", re.sub(r"\s+(?=[.,)])", "", out)).strip()


def _map_list(m):
    return OLD_WORD.sub(lambda w: NEW[w.group()], m.group())


def _enum_word(m):
    return NEW[m.group()]


def _sentence_states(sentence):
    if not CONTRACT.search(sentence) or NOT_CONTRACT.search(sentence):
        return sentence
    out = STATE_LIST.sub(_map_list, sentence)
    for rx, repl in IN_CONTRACT:
        out = rx.sub(repl, out)
    if len(set(STATE_TERMS.findall(sentence))) >= 3:
        out = re.sub(r"거부([와는가를])(?![가-힣])", lambda m: "서명 거절" + _PARTICLE[m.group(1)], out)
        out = _ENUM.sub(_enum_word, out)
    return out


def states(line):
    for rx, repl in ALWAYS:  # 먼저 바꿔야 혼합 나열의 항목으로 읽힌다
        line = rx.sub(repl, line)
    return "".join(_sentence_states(s) for s in re.split(r"((?<=[다요음])\. )", line))


def _fix(text, fixes, found=None):
    for a, b in (fixes or {}).items():
        if a in text:
            if found is not None:
                found.add(a)
            text = text.replace(a, b)
    return text


def clean_text(text, fixes=None, found=None):
    lines = []
    for line in _fix(text, fixes, found).split("\n"):
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


def expected(text, fixes=None):
    """자체 검사용: 원문이 문서에서 어떤 글이 되는지."""
    return clean_text(text, fixes)


def left_in(text):
    found = INTERNAL.findall(text) + TEAM.findall(text) + [m.group() for m in TEAM_NAMES.finditer(text)] + issues_left(text)
    found += ["쟁점"] * text.count("쟁점") + TOOLS.findall(text) + WORK_NO.findall(text) + DOUBLE.findall(text)
    return found


def sanitize(wb, skip=None, fixes=None):
    """모든 시트의 글자 칸을 정리하고 (점검에 걸린 값, 판단이 갈리는 칸) 을 돌려준다. 고칠 문장을 못 찾으면 멈춘다."""
    COUNTS.clear()
    leaks, review, found = [], [], set()
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if not isinstance(c.value, str) or (skip and skip(ws, c)):
                    continue
                c.value = clean_text(c.value, fixes, found)
                leaks += [f"{ws.title}: {x}" for x in left_in(c.value)]
                if AMBIGUOUS.search(c.value) or GONE.search(c.value):
                    review.append((ws.title, c.coordinate, c.value))
    lost = sorted(set(fixes or {}) - found)
    if lost:
        raise SystemExit(f"고칠 문장을 찾지 못했습니다(원문이 바뀌었는지 확인): {lost}")
    COUNTS["문장 고침"] = len(found)
    return leaks, review


def deliver(wb, abbr, fixes=None, skip=None):
    """정리 · 점검을 하고 판단이 갈리는 칸을 out/ 에 적는다. 내부 표시가 남으면 멈춘다."""
    leaks, review = sanitize(wb, skip, fixes)
    if leaks:
        raise SystemExit(f"납품본에 내부 표시가 남음: {sorted(set(leaks))[:20]}")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"정리 검토 목록_{abbr}.tsv"), "w", encoding="utf-8") as f:
        f.writelines(f"{sheet}\t{cell}\t{text!r}\n" for sheet, cell, text in review)
    return dict(COUNTS), len(review)
