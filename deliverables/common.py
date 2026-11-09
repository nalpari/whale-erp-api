"""산출물 생성 스크립트가 함께 쓰는 것: 템플릿 열기, 표지·개정 이력 채우기, 표 시트 · 워드 본문, 저장, 내부 기록 정리."""
import json
import os
import re

from docx import Document
from docx.enum.text import WD_BREAK
from docx.shared import Cm

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_XLSX = os.path.join(HERE, "templates", "template.xlsx")
TEMPLATE_DOCX = os.path.join(HERE, "templates", "template.docx")
OUT = os.path.join(HERE, "out")
FONT = "맑은 고딕"


def revision(abbr, version):
    """revisions.json 에서 문서 정보와 그 버전까지의 개정 이력을 꺼낸다. 없는 버전이면 멈춘다."""
    with open(os.path.join(HERE, "revisions.json"), encoding="utf-8") as f:
        doc = json.load(f)[abbr]
    history = []
    for row in doc["history"]:
        history.append(row)
        if row["version"] == version:
            return doc, history
    raise SystemExit(f"revisions.json 의 {abbr} 에 버전 {version} 이 없습니다. 개정 이력 줄을 먼저 넣어 주세요.")


def open_xlsx(abbr, version):
    """템플릿을 열고 표지 자리표시자와 개정 이력을 채운다."""
    doc, history = revision(abbr, version)
    values = {
        "{{문서명}}": doc["name"],
        "{{문서 번호}}": f"WHALE-{abbr}-{version}",
        "{{버전}}": version,
        "{{작성일}}": history[-1]["date"],
        "{{작성자}}": history[-1]["author"],
    }
    wb = load_workbook(TEMPLATE_XLSX)
    for row in wb["표지"].iter_rows():
        for c in row:
            if c.value in values:
                c.value = values[c.value]
    ws = wb["개정 이력"]
    for r in history:
        ws.append([r["version"], r["date"], r["change"], r["author"]])
        for c in ws[ws.max_row]:
            c.style = "본문"
    return wb, doc["name"], values["{{문서 번호}}"]


def table_sheet(wb, title, headers, rows, widths, top_rows=()):
    """머리행 · 테두리 · 틀 고정 · 자동 필터 · 열 너비를 갖춘 표 시트. top_rows 는 표 위에 두는 (이름, 값) 줄."""
    ws = wb.create_sheet(title)
    for label, value in top_rows:
        ws.append([label, value])
        ws.cell(ws.max_row, 1).style = "머리행"
        ws.cell(ws.max_row, 2).style = "본문"
    if top_rows:
        ws.append([])
    ws.append(headers)
    head = ws.max_row
    for c in ws[head]:
        c.style = "머리행"
    for r in rows:
        ws.append(r)
        for c in ws[ws.max_row]:
            c.style = "본문"
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = ws.cell(head + 1, 1)
    ws.auto_filter.ref = f"A{head}:{get_column_letter(len(headers))}{ws.max_row}"
    return ws, head


def save_xlsx(wb, doc_name, file_name):
    """모든 시트에 머리글(문서명) · 바닥글(쪽 번호)을 붙여 out/ 에 저장한다.
    산출물은 수식을 쓰지 않으므로, = 로 시작해 수식으로 잡힌 값은 글자로 되돌린다(원문이 계산되지 않게)."""
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if c.data_type == "f":
                    c.data_type = "s"
        ws.oddHeader.center.text = doc_name
        ws.oddHeader.center.font = FONT
        ws.oddFooter.center.text = "&P / &N"
        ws.oddFooter.center.font = FONT
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, file_name)
    wb.save(path)
    return path


# ── 워드 ──

def _fill(paragraph, values):
    """자리표시자는 한 run 에 있다(build_templates.py)."""
    for r in paragraph.runs:
        if r.text in values:
            r.text = values[r.text]


def open_docx(abbr, version):
    """워드 템플릿을 열고 표지 자리표시자(본문 · 표 · 머리글)와 개정 이력 표를 채운 뒤 새 쪽에서 본문을 잇는다."""
    doc, history = revision(abbr, version)
    values = {"{{문서명}}": doc["name"], "{{문서 번호}}": f"WHALE-{abbr}-{version}", "{{버전}}": version,
              "{{작성일}}": history[-1]["date"], "{{작성자}}": history[-1]["author"]}
    d = Document(TEMPLATE_DOCX)
    cells = [p for t in d.tables for row in t.rows for c in row.cells for p in c.paragraphs]
    for p in d.paragraphs + cells + d.sections[0].header.paragraphs:
        _fill(p, values)
    hist = d.tables[1]
    for r in history:
        for c, v in zip(hist.add_row().cells, (r["version"], r["date"], r["change"], r["author"])):
            c.text = v
    d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    return d, doc["name"], values["{{문서 번호}}"]


def heading(d, text, level):
    return d.add_heading(text, level=level)


def para(d, content, style=None):
    """본문 단락. content 는 글자열 또는 [(글, 굵게)] 조각 목록."""
    p = d.add_paragraph(style=style)
    for text, bold in ([(content, False)] if isinstance(content, str) else content):
        p.add_run(text).bold = bold or None
    return p


def table(d, headers, rows, widths=None):
    """「WHALE 표」. 첫 줄이 머리행. widths 는 cm."""
    t = d.add_table(rows=1, cols=len(headers))
    t.style = d.styles["WHALE 표"]
    for c, v in zip(t.rows[0].cells, headers):
        c.text = v
    for r in rows:
        for c, v in zip(t.add_row().cells, r):
            c.text = str(v)
    if widths:
        for row in t.rows:
            for c, w in zip(row.cells, widths):
                c.width = Cm(w)
    return t


def picture(d, path, width_cm=16):
    return d.add_picture(path, width=Cm(width_cm))


def save_docx(d, file_name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, file_name)
    d.save(path)
    return path


# ── 내부 기록 정리 ──

# 납품 문서에 싣지 않는 내부 표지(2026-11-05 재영): 일감 번호 · PR 번호(저장소 이름 없는 #숫자 포함) ·
# 코드 리뷰 · 소스 파일명 · Manyfast ID · @SkipThrottle.
INTERNAL = re.compile(r"WHALEERP-\d+|\b(?:api|front|staff)\s*#\d*|(?<![\w/&])#\d+|코드 리뷰|[\w./-]+\.ts\b|\b[SFR]-[A-Z]"
                      r"|@SkipThrottle")
EMAIL = re.compile(r"([\w.*+-]+)@(?!example\.com\b)[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<!\d)01[016789]-?\d{3,4}-?\d{4}(?!\d)")


def safe(text):
    """예시 이메일 · 휴대전화번호를 문서용 값으로 바꾼다."""
    if not isinstance(text, str):
        return text
    text = EMAIL.sub(r"\1@example.com", text)
    return PHONE.sub(lambda m: "010-1234-5678" if "-" in m.group() else "01012345678", text)


# 결정 기록 괄호(strip_records). API 명세의 strip_decisions 보다 넓다: 이름이 여럿인 조각 · 일감이 든 조각도 지운다.
_ANY_DATE = re.compile(r"\d{4}-\d{2}(?:-\d{2})?(?:·\d{1,2})*")
_NAMES = re.compile(r"노영주|영주|김민식|민식|최효준|효준|김창수|창수|재영")
_RECORD_WORDS = re.compile(r"제안|승인|정리|결정|확인|확정|질문|요청|리뷰|후속|일감|구현 기준|구현 그대로|변경|바꿈|유지|문구|PR|홈|"
                           r"범위 줄임|직원 앱 문구|직원앱|Plane|[·,~#\s\d—-]")
# 날짜 · 이름 없이 결정 낱말만 있는 괄호. 「(홈)」 같은 보통 괄호를 지우지 않게 낱말을 넓히지 않는다.
_WORD_ONLY = re.compile(r"홈 PR 리뷰|구현 기준|구현 그대로|후속 일감")
# 납품 문서에 남으면 안 되는 팀원 실명. 「운영주체」의 「영주」는 이름이 아니다.
# 영문은 표시 이름 · 커밋 작성자 이름 · Plane ID. 대소문자를 구분하고 앞뒤 경계를 둔다(단독 「Kim」 등은 넣지 않는다). 지영은 「유지영역」 같은 낱말에 걸리지 않게 앞 글자를 본다.
# 정표(「이정표」와 겹침, 실명 미확인)는 넣지 않고 영문 표기만 둔다.
TEAM_NAMES = re.compile(r"노영주|(?<![운경])영주|김민식|민식|최효준|효준|김창수|창수|재영|유상욱|상욱|김홍기|홍기|최창규|창규|류제영|제영|김지영|(?<![가-힣])지영"
                        r"|(?<![A-Za-z0-9._-])(?:hyojun\.choi|JungPyo\.Lee|leejungpyo|jungpyo2001|JeYoung\.Ryu|rjy1537(?:-eng)?|changsoo kim|chang soo"
                        r"|chang-su98|chang-kyu|chang9811|ck_choi|Young Joo|yjnoh|Kim Minsik|Minsiki?|mskim|HONGGI|hkim|JiyoungKim|jyKim|JaeYoung"
                        r"|Jaeyoung Lee|LEE\.JY|jy-lee|nalpari)(?![A-Za-z0-9_-])")
TEAM = re.compile(r"[13]팀|두 팀")  # 납품 문서에 남으면 안 되는 팀 표시
_HISTORY = re.compile(r"(?:바꿈|바로잡음|뺌|걷음|맞춤|정정)$")
_SEP = re.compile(r"(, | · | — |\. )")


def _record(token):
    """날짜 · 이름 · 내부 표지가 있고, 그것과 결정 낱말을 빼면 남는 게 없는 조각."""
    if not (_ANY_DATE.search(token) or _NAMES.search(token) or INTERNAL.search(token)):
        return False
    rest = _RECORD_WORDS.sub("", _NAMES.sub("", _ANY_DATE.sub("", INTERNAL.sub("", token))))
    return not rest.strip()


def strip_records(text, removed=None):
    """괄호 안의 결정 기록 조각과 내부 표지가 든 조각만 지운다. 모두 지워지면 괄호째. removed 목록에 (지운 조각, 괄호 원문)을 쌓는다."""
    def paren(m):
        inner = m.group(2)
        if _WORD_ONLY.fullmatch(inner.strip()):
            if removed is not None:
                removed.append((inner, inner))
            return ""
        if not (_ANY_DATE.search(inner) or _NAMES.search(inner) or INTERNAL.search(inner)):
            return m.group(0)
        parts = _SEP.split(inner)  # [조각, 구분, 조각, ...]
        tokens, seps = parts[0::2], [""] + parts[1::2]
        keep, prev_dropped, prev_plane = [], False, False
        for tok, sep in zip(tokens, seps):
            drop = (_record(tok) or INTERNAL.search(tok) or (prev_plane and re.match(r"\d", tok))
                    or (_HISTORY.search(tok) and (prev_dropped or _NAMES.search(tok))))
            if drop:
                if removed is not None:
                    removed.append((tok, inner))
                prev_plane = prev_plane and re.match(r"\d", tok) or "WHALEERP-" in tok
            else:
                keep.append((sep, tok))
                prev_plane = False
            prev_dropped = bool(drop)
        if len(keep) == len(tokens):
            return m.group(0)
        if not keep:
            return ""
        return f"{m.group(1)}({keep[0][1]}{''.join(s + t for s, t in keep[1:])})"
    out = text
    for _ in range(2):  # 안쪽 괄호 먼저, 안쪽이 지워져 드러난 바깥 괄호를 한 번 더, 그다음 한 겹 감싼 괄호
        out = re.sub(r"(\s*)\(([^()]*)\)", paren, out)
    out = re.sub(r"(\s*)\(((?:[^()]|\([^()]*\))*\([^()]*\)(?:[^()]|\([^()]*\))*)\)", paren, out)
    return re.sub(r"\s+([.,)])", r"\1", out) if out != text else out
