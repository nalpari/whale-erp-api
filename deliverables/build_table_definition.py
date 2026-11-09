"""테이블정의서(WHALE-TBL) — prisma/schema.prisma 를 읽어 엑셀로 낸다.

    .venv/bin/python build_table_definition.py --version 1.0

설명 칸은 /// 주석을 그대로 옮기고, 없으면 비운다.
SQL 에만 있는 제약(CHECK · SQL 에만 있는 외래키 · 부분 고유 인덱스)은 schema.prisma 에 없어 담지 않는다.
"""
import argparse
import io
import math
import os
import re

from openpyxl.drawing.image import Image as XlImage
from PIL import Image, ImageDraw, ImageFont

from openpyxl.styles import Alignment, Font

from common import FONT, HERE, last_commit, open_xlsx, record_basis, save_xlsx, table_sheet

SCHEMA = os.path.join(HERE, "..", "prisma", "schema.prisma")
SCALAR = {"String": "text", "Int": "integer", "BigInt": "bigint", "Boolean": "boolean", "Float": "double precision",
          "Decimal": "numeric", "DateTime": "timestamp(3)", "Json": "jsonb", "Bytes": "bytea"}
DB_TYPE = {"Timestamptz": "timestamptz", "Date": "date", "Time": "time", "Decimal": "numeric", "VarChar": "varchar",
           "Char": "char", "Uuid": "uuid", "Text": "text", "SmallInt": "smallint", "JsonB": "jsonb"}


def attr_arg(text, name):
    """'@name(' 뒤 괄호 안 문자열(따옴표 · 중첩 괄호 고려). 없으면 None."""
    i = text.find(name + "(")
    if i < 0:
        return None
    i += len(name) + 1
    depth, quote, j = 1, False, i
    while j < len(text):
        ch = text[j]
        if ch == '"' and text[j - 1] != "\\":
            quote = not quote
        elif not quote and ch == "(":
            depth += 1
        elif not quote and ch == ")":
            depth -= 1
            if depth == 0:
                return text[i:j]
        j += 1
    return None


def names(arg):
    """'[a, b(sort: Desc)], map: "x"' → ['a', 'b']"""
    inner = arg[arg.index("[") + 1:arg.index("]")]
    return [n.split("(")[0].strip() for n in inner.split(",") if n.strip()]


def map_name(arg):
    m = re.search(r'map:\s*"([^"]+)"', arg or "")
    return m.group(1) if m else None


def parse(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    model_names = {m.group(1) for l in lines if (m := re.match(r"model (\w+) \{", l))}
    enums, enum_list, models, doc, cur = {}, [], [], [], None
    for line in lines:
        s = line.strip()
        if cur is None:
            if s.startswith("///"):
                doc.append(s[3:].strip())
            elif m := re.match(r"(model|enum) (\w+) \{", s):
                cur = {"kind": m.group(1), "name": m.group(2), "table": m.group(2), "doc": " ".join(doc),
                       "fields": [], "fks": [], "indexes": [], "pk": [], "values": []}
                doc = []
            elif s and not s.startswith("//"):
                doc = []
            continue
        if s == "}":
            if cur["kind"] == "model":
                models.append(cur)
            else:
                enums[cur["name"]] = cur["table"]
                enum_list.append(cur)
            cur, doc = None, []
            continue
        if s.startswith("///"):
            doc.append(s[3:].strip())
            continue
        if not s or s.startswith("//"):
            continue
        if cur["kind"] == "enum" and not s.startswith("@@map"):
            cur["values"].append((s.split()[0], " ".join(doc)))
            doc = []
            continue
        if s.startswith("@@"):
            kind = s[2:s.index("(")]
            arg = attr_arg(s, "@@" + kind)
            if kind == "map":
                cur["table"] = arg.strip('"')
            elif kind == "id":
                cur["pk"] = names(arg)
            elif kind in ("unique", "index"):
                cur["indexes"].append({"name": map_name(arg), "fields": names(arg), "unique": kind == "unique"})
            continue
        m = re.match(r"(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$", s)
        fname, ftype, arr, opt, rest = m.groups()
        if ftype in model_names:  # 관계 필드: 컬럼이 아니다
            rel = attr_arg(rest, "@relation")
            if rel and "fields:" in rel:
                refs = re.search(r"references:\s*\[([^\]]*)\]", rel).group(1)
                cur["fks"].append({"fields": names(rel[rel.index("fields:"):]), "model": ftype,
                                   "refs": [r.strip() for r in refs.split(",")]})
            doc = []
            continue
        cur["fields"].append({"name": fname, "type": ftype, "array": bool(arr), "optional": bool(opt),
                              "rest": rest, "doc": " ".join(doc)})
        doc = []
    for mdl in models:
        for f in mdl["fields"]:
            m = re.search(r'@map\("([^"]+)"\)', f["rest"])
            f["column"] = m.group(1) if m else f["name"]
            if "@id" in re.findall(r"@\w+", f["rest"]):
                mdl["pk"] = [f["name"]]
            if re.search(r"@unique\b", f["rest"]):
                mdl["indexes"].append({"name": map_name(attr_arg(f["rest"], "@unique")), "fields": [f["name"]],
                                       "unique": True})
    return models, enums, enum_list


def col_type(f, enums):
    if f["type"] in enums:
        t = enums[f["type"]]
    else:
        m = re.search(r"@db\.(\w+)(\(([^)]*)\))?", f["rest"])
        t = SCALAR.get(f["type"], f["type"])
        if m:
            t = DB_TYPE.get(m.group(1), m.group(1).lower()) + (f"({m.group(3).replace(' ', '')})" if m.group(2) else "")
    return t + ("[]" if f["array"] else "")


def default(f, enums):
    """Prisma 표기를 마이그레이션 SQL 의 DEFAULT 값으로 바꾼다."""
    arg = attr_arg(f["rest"], "@default")
    if arg is None:
        return ""
    if arg == "autoincrement()":
        return "IDENTITY"  # SQL 은 GENERATED ALWAYS AS IDENTITY (schema.prisma 머리 주석)
    if arg.startswith("dbgenerated("):
        arg = attr_arg(arg, "dbgenerated").strip('"')
        if arg != "now()":
            return arg
    if arg == "now()":  # SQL 의 now() 와 같은 값(마이그레이션 SQL 표기에 맞춘다)
        return "CURRENT_TIMESTAMP"
    if arg == "[]":
        return "'{}'"
    if arg.startswith('"'):
        return f"'{arg[1:-1]}'" + ("::jsonb" if f["type"] == "Json" else "")
    if f["type"] in enums:
        return f"'{arg}'"
    return arg  # true · false · 숫자


def rows_of(mdl, by_name, enums):
    field_col = {f["name"]: f["column"] for f in mdl["fields"]}
    rows = []
    for f in mdl["fields"]:
        keys = []
        if f["name"] in mdl["pk"]:
            keys.append("PK")
        for fk in mdl["fks"]:
            if f["name"] in fk["fields"]:
                ref = by_name[fk["model"]]
                ref_col = {x["name"]: x["column"] for x in ref["fields"]}[fk["refs"][fk["fields"].index(f["name"])]]
                keys.append(f"FK({ref['table']}.{ref_col})")
        idx = []
        for ix in mdl["indexes"]:
            if f["name"] in ix["fields"]:
                if ix["unique"] and len(ix["fields"]) == 1:
                    keys.append("UNIQUE")
                label = ix["name"] or ("UNIQUE" if ix["unique"] else "INDEX")
                if len(ix["fields"]) > 1:
                    label += " (" + ", ".join(field_col[x] for x in ix["fields"]) + ")"
                idx.append(label)
        rows.append([f["column"], col_type(f, enums), "Y" if f["optional"] else "N", default(f, enums),
                     ", ".join(keys), "\n".join(idx), f["doc"]])
    return rows


def font(size):
    for p in ("C:/Windows/Fonts/malgun.ttf", "/Library/Fonts/Malgun Gothic.ttf",
              "/System/Library/Fonts/AppleSDGothicNeo.ttc", "/usr/share/fonts/truetype/nanum/NanumGothic.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    raise SystemExit("ERD 에 쓸 한글 글꼴(맑은 고딕 · Apple SD 고딕 Neo · 나눔고딕)을 찾지 못했습니다. 글꼴을 설치해 주세요.")


def erd(models, by_name, enums):
    """테이블 상자를 격자로 놓고 Prisma 관계를 선으로 잇는다. 선을 먼저 그려 상자 아래에 깔린다."""
    W, LH, HH, GAP = 340, 19, 46, 70
    f_head, f_sub, f_body = font(16), font(12), font(13)
    cols = max(1, math.ceil(math.sqrt(len(models) * 1.3)))
    heights = [HH + LH * len(m["fields"]) + 8 for m in models]
    row_h = [max(heights[i:i + cols]) for i in range(0, len(models), cols)]
    pos, y = {}, GAP
    for r, h in enumerate(row_h):
        for c, m in enumerate(models[r * cols:(r + 1) * cols]):
            pos[m["name"]] = (GAP + c * (W + GAP), y, heights[r * cols + c])
        y += h + GAP
    img = Image.new("RGB", (GAP + cols * (W + GAP), y), "white")
    d = ImageDraw.Draw(img)
    for m in models:
        x0, y0, h0 = pos[m["name"]]
        for fk in m["fks"]:
            if fk["model"] not in pos or fk["model"] == m["name"]:
                continue
            x1, y1, h1 = pos[fk["model"]]
            a = (x0 + W / 2, y0 + h0 / 2)
            b = (x1 + W / 2, y1 + h1 / 2)
            d.line([a, b], fill="#9DB4CF", width=2)
    for m in models:
        x, y0, h = pos[m["name"]]
        d.rectangle([x, y0, x + W, y0 + h], fill="white", outline="#1F4E79", width=2)
        d.rectangle([x, y0, x + W, y0 + HH], fill="#1F4E79")
        d.text((x + 8, y0 + 4), m["table"], font=f_head, fill="white")
        d.text((x + 8, y0 + 26), m["doc"][:28], font=f_sub, fill="#DDE6F0")
        for i, r in enumerate(rows_of(m, by_name, enums)):
            ty = y0 + HH + 4 + i * LH
            key = ("PK " if "PK" in r[4] else "") + ("FK" if "FK(" in r[4] else "")
            d.text((x + 8, ty), key, font=f_sub, fill="#C00000")
            d.text((x + 50, ty), r[0], font=f_body, fill="#222222")
            d.text((x + W - 8, ty), r[1], font=f_sub, fill="#7F7F7F", anchor="ra")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf, img.size


def sheet_title(table, used):
    t = table[:31]
    n = 2
    while t in used:
        t = f"{table[:28]}~{n}"
        n += 1
    used.add(t)
    return t


def basis():
    return f"API 커밋 {last_commit('../prisma/schema.prisma')}"


def write(version):
    """엑셀을 쓰고 (경로, 테이블 수, 컬럼 수) 를 돌려준다."""
    models, enums, enum_list = parse(SCHEMA)
    by_name = {m["name"]: m for m in models}
    wb, doc_name, doc_no = open_xlsx("TBL", version)

    ws = wb.create_sheet("ERD")
    ws.append(["Prisma 관계(@relation)만 선으로 잇는다. SQL 에만 있는 외래키는 선이 없다."])
    buf, (w, h) = erd(models, by_name, enums)
    pic = XlImage(buf)
    pic.width, pic.height = w // 2, h // 2  # 원본 해상도는 그대로, 확대하면 선명하다
    ws.add_image(pic, "A3")

    used = {s.title for s in wb.worksheets} | {"테이블 목록"}
    titles = {m["name"]: sheet_title(m["table"], used) for m in models}
    lst, head = table_sheet(wb, "테이블 목록", ["테이블명", "설명", "컬럼 수"],
                            [[m["table"], m["doc"], len(m["fields"])] for m in models], [36, 50, 10],
                            top_rows=[("원본", "whale-erp-api prisma/schema.prisma"),
                                      ("참고", "CHECK · SQL 에만 있는 외래키 · 부분 고유 인덱스 등 SQL 에만 있는 제약은 담지 않는다 "
                                             "(prisma/migrations 의 SQL 이 원문).")])
    for i, m in enumerate(models):
        c = lst.cell(head + 1 + i, 1)
        c.hyperlink = f"#'{titles[m['name']]}'!A1"
        c.font = Font(name=FONT, size=10, color="0563C1", underline="single")

    els, ehead = table_sheet(wb, "enum 목록", ["enum", "Prisma 이름", "설명", "값"],
                             [[e["table"], e["name"], e["doc"],
                               "\n".join(v + (f" — {d}" if d else "") for v, d in e["values"])] for e in enum_list],
                             [34, 30, 50, 40])
    enum_row = {e["name"]: ehead + 1 + i for i, e in enumerate(enum_list)}
    for row in els.iter_rows(min_row=ehead + 1):
        row[3].alignment = Alignment(wrap_text=True, vertical="top")

    for m in models:
        ws, head = table_sheet(wb, titles[m["name"]],
                            ["컬럼", "타입", "NULL", "기본값", "PK/FK/UNIQUE", "인덱스", "설명"],
                            rows_of(m, by_name, enums), [28, 16, 7, 16, 30, 44, 60],
                            top_rows=[("테이블명", m["table"]), ("설명", m["doc"])])
        ws.cell(1, 4, "테이블 목록으로").hyperlink = "#'테이블 목록'!A1"
        for i, f in enumerate(m["fields"]):
            if f["type"] in enum_row:  # 컬럼 타입이 enum 이면 enum 목록의 그 줄로
                c = ws.cell(head + 1 + i, 2)
                c.hyperlink = f"#'enum 목록'!A{enum_row[f['type']]}"
                c.font = Font(name=FONT, size=10, color="0563C1", underline="single")

    path = save_xlsx(wb, doc_name, f"{doc_no}_{doc_name}.xlsx")
    record_basis("TBL", version, path, basis())
    return path, len(models), sum(len(m["fields"]) for m in models)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    path, tables, columns = write(ap.parse_args().version)
    print(f"{path}\n테이블 {tables} · 컬럼 {columns}")


if __name__ == "__main__":
    main()
