"""기본 템플릿 template.xlsx · template.docx 를 만든다. 양식을 바꿀 때만 다시 돌린다.

    .venv/bin/python build_templates.py

{{문서명}} 같은 자리표시자는 생성 스크립트가 채운다. 한 자리표시자는 한 셀(워드는 한 run)에 둔다.
"""
import os

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, NamedStyle, PatternFill, Side

from common import FONT, HERE

HEAD_FILL = "1F4E79"  # 머리행 바탕(짙은 남색), 글자는 흰색
LINE = "BFBFBF"
COVER = [("프로젝트명", "WHALE ERP"), ("문서 번호", "{{문서 번호}}"), ("버전", "{{버전}}"),
         ("작성일", "{{작성일}}"), ("작성 팀", "{{작성 팀}}")]
HISTORY = ["버전", "일자", "변경 내용", "작성자"]


def build_xlsx(path):
    side = Side(style="thin", color=LINE)
    border = Border(left=side, right=side, top=side, bottom=side)
    head = NamedStyle("머리행", font=Font(name=FONT, size=10, bold=True, color="FFFFFF"),
                      fill=PatternFill("solid", fgColor=HEAD_FILL), border=border,
                      alignment=Alignment(horizontal="center", vertical="center", wrap_text=True))
    body = NamedStyle("본문", font=Font(name=FONT, size=10), border=border,
                      alignment=Alignment(vertical="top", wrap_text=True))
    wb = Workbook()
    wb.add_named_style(head)
    wb.add_named_style(body)

    ws = wb.active
    ws.title = "표지"
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 4
    ws.column_dimensions["B"].width = 16
    ws.column_dimensions["C"].width = 40
    ws.merge_cells("B4:C4")
    ws["B4"] = "{{문서명}}"
    ws["B4"].font = Font(name=FONT, size=24, bold=True, color=HEAD_FILL)
    ws.row_dimensions[4].height = 40
    for i, (label, value) in enumerate(COVER, start=7):
        ws.cell(i, 2, label).style = "머리행"
        ws.cell(i, 3, value).style = "본문"
        ws.row_dimensions[i].height = 20

    ws = wb.create_sheet("개정 이력")
    ws.append(HISTORY)
    for c in ws[1]:
        c.style = "머리행"
    for col, w in zip("ABCD", (10, 14, 60, 14)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A2"
    wb.save(path)


TABLE_STYLE = f"""<w:style {nsdecls('w')} w:type="table" w:customStyle="1" w:styleId="WHALETable">
  <w:name w:val="WHALE 표"/><w:basedOn w:val="TableNormal"/><w:qFormat/>
  <w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>
  <w:rPr><w:sz w:val="18"/></w:rPr>
  <w:tblPr>
    <w:tblBorders>
      {''.join(f'<w:{e} w:val="single" w:sz="4" w:space="0" w:color="{LINE}"/>'
               for e in ("top", "left", "bottom", "right", "insideH", "insideV"))}
    </w:tblBorders>
    <w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>
      <w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>
  </w:tblPr>
  <w:tblStylePr w:type="firstRow">
    <w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>
    <w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="{HEAD_FILL}"/></w:tcPr>
  </w:tblStylePr>
</w:style>"""


def set_font(style, size=None, bold=None, color=None):
    style.font.name = FONT
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), FONT)
    if size:
        style.font.size = Pt(size)
    if bold is not None:
        style.font.bold = bold
    if color:
        style.font.color.rgb = RGBColor.from_string(color)


def page_field(paragraph):
    run = paragraph.add_run()
    for xml in ('<w:fldChar %s w:fldCharType="begin"/>', '<w:instrText %s xml:space="preserve"> PAGE </w:instrText>',
                '<w:fldChar %s w:fldCharType="end"/>'):
        run._r.append(parse_xml(xml % nsdecls("w")))


def table(doc, rows, header=True):
    t = doc.add_table(rows=0, cols=len(rows[0]))
    t.style = doc.styles["WHALE 표"]
    for r in rows:
        cells = t.add_row().cells
        for c, v in zip(cells, r):
            c.text = v
    if not header:  # 표지 표는 첫 줄도 본문처럼
        t._tbl.tblPr.find(qn("w:tblLook")).set(qn("w:firstRow"), "0")
    return t


def build_docx(path):
    doc = Document()
    styles = doc.styles
    styles.element.append(parse_xml(TABLE_STYLE))
    set_font(styles["Normal"], 10)
    set_font(styles["Title"], 26, True, HEAD_FILL)
    for name, size in (("Heading 1", 16), ("Heading 2", 13), ("Heading 3", 11)):
        set_font(styles[name], size, True, HEAD_FILL)
    for name in ("Header", "Footer"):
        set_font(styles[name], 9, color="595959")

    # 표지: 머리글·바닥글 없음(첫 쪽 다르게)
    for _ in range(6):
        doc.add_paragraph()
    doc.add_paragraph("{{문서명}}", style="Title")
    doc.add_paragraph()
    table(doc, COVER, header=False)
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    doc.add_heading("개정 이력", level=1)
    table(doc, [HISTORY])

    sec = doc.sections[0]
    sec.different_first_page_header_footer = True
    sec.header.paragraphs[0].text = "{{문서명}}"
    sec.header.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
    sec.footer.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    page_field(sec.footer.paragraphs[0])
    doc.save(path)


if __name__ == "__main__":
    out = os.path.join(HERE, "templates")
    build_xlsx(os.path.join(out, "template.xlsx"))
    build_docx(os.path.join(out, "template.docx"))
    print("templates/template.xlsx, templates/template.docx")
