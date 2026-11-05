"""산출물 생성 스크립트가 함께 쓰는 것: 템플릿 열기, 표지·개정 이력 채우기, 표 시트, 저장."""
import json
import os

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_XLSX = os.path.join(HERE, "templates", "template.xlsx")
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
    """모든 시트에 머리글(문서명) · 바닥글(쪽 번호)을 붙여 out/ 에 저장한다."""
    for ws in wb.worksheets:
        ws.oddHeader.center.text = doc_name
        ws.oddHeader.center.font = FONT
        ws.oddFooter.center.text = "&P / &N"
        ws.oddFooter.center.font = FONT
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, file_name)
    wb.save(path)
    return path
