"""API 명세(WHALE-API) — openapi/openapi.json 과 src 의 컨트롤러 · DTO 를 읽어 엑셀로 낸다.

    pnpm openapi:export                                   # 저장소 루트에서, 문서를 코드와 맞춘다
    .venv/bin/python build_api_spec.py --version 1.0

경로 · 파라미터 · 본문 · 응답 · 오류는 openapi.json(nest swagger 플러그인)에서, 권한 데코레이터 · 검증 데코레이터 ·
반환형은 소스에서 읽는다. 설명은 주석 · Swagger 데코레이터에 있는 것만 옮기고, 응답 형태를 정적으로 알 수 없으면
「코드에서 판정 불가」로 적는다. 소스에서 찾은 라우트 수와 문서 줄 수가 다르면 멈춘다.
"""
import argparse
import json
import os
import re

from openpyxl.styles import Alignment, Font

from common import FONT, HERE, open_xlsx, save_xlsx, table_sheet

ROOT = os.path.join(HERE, "..")
OPENAPI = os.path.join(ROOT, "openapi", "openapi.json")
SRC = os.path.join(ROOT, "src")
VERBS = {"Get", "Post", "Put", "Patch", "Delete", "All", "Options", "Head"}
AUTH = {"Public", "UserTypes", "MenuPermission", "UseGuards", "AllowPasswordChangePending"}
NOT_RULE = re.compile(r"@(Api\w*|Type|Transform|Expose|Exclude)\b")
UNKNOWN = "코드에서 판정 불가"
CONSTRAINTS = ("minLength", "maxLength", "minimum", "maximum", "pattern", "format", "minItems", "maxItems")


# ── TypeScript 를 문장 단위로 훑는 작은 렉서. 문자열 · 주석 · 괄호만 안다. ──

def skip_string(t, i):
    q, i = t[i], i + 1
    while i < len(t) and t[i] != q:
        i += 2 if t[i] == "\\" else 1
    return i + 1


def skip_space(t, i):
    while i < len(t):
        if t[i].isspace():
            i += 1
        elif t.startswith("//", i):
            j = t.find("\n", i)
            i = len(t) if j < 0 else j
        elif t.startswith("/*", i):
            i = t.index("*/", i) + 2
        else:
            break
    return i


def close(t, i):
    """t[i] 가 여는 괄호일 때 짝이 닫힌 바로 뒤 위치."""
    depth = 0
    while i < len(t):
        c = t[i]
        if c in "'\"`":
            i = skip_string(t, i)
            continue
        if t.startswith("//", i) or t.startswith("/*", i):
            i = skip_space(t, i)
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return i


def statement_end(t, i):
    """depth 0 의 ; 까지, 또는 depth 0 으로 닫힌 } 뒤 줄 끝까지."""
    while i < len(t):
        c = t[i]
        if c in "'\"`":
            i = skip_string(t, i)
        elif t.startswith("//", i) or t.startswith("/*", i):
            i = skip_space(t, i)
        elif c in "([":
            i = close(t, i)
        elif c == "{":
            i = close(t, i)
            j = i
            while j < len(t) and t[j] in " \t":
                j += 1
            if j < len(t) and t[j] in ";,":
                return j + 1
            if j >= len(t) or t[j] == "\n":
                return j
        elif c == ";":
            return i + 1
        elif c == "}":
            return i  # 감싼 블록의 끝
        else:
            i += 1
    return i


def decorator(t, i):
    """t[i] == '@' 인 데코레이터의 (이름, 원문, 끝 위치)."""
    m = re.compile(r"@([\w.]+)").match(t, i)
    j = m.end()
    if j < len(t) and t[j] == "(":
        j = close(t, j)
    return m.group(1), " ".join(t[i:j].split()), j


MEMBER = re.compile(r"(?:(?:public|private|protected|static|async|readonly|override)\s+)*(\w+)\s*(\??)\s*([(<:=;!])")
CLASS = re.compile(r"(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)([^{]*)\{")


def members(t, start, end):
    """클래스 몸통에서 (이름, 데코레이터 [(이름, 원문)], 괄호 안 원문, 반환형, 선택 여부) 를 차례로."""
    i, pending = start, []
    while True:
        i = skip_space(t, i)
        if i >= end:
            return
        if t[i] == "@":
            name, raw, i = decorator(t, i)
            pending.append((name, raw))
            continue
        m = MEMBER.match(t, i)
        if not m:
            i = statement_end(t, i)
            pending = []
            continue
        params, ret = "", ""
        if m.group(3) in "(<":
            p = t.index("(", m.end(1))
            q = close(t, p)
            params = t[p + 1:q - 1]
            r = re.compile(r"\s*:\s*([^{;]+?)\s*[{;]").match(t, q)
            ret = " ".join(r.group(1).split()) if r else ""
        yield m.group(1), pending, params, ret, m.group(2) == "?"
        i = statement_end(t, m.start())
        pending = []


def classes(path):
    """파일의 최상위 클래스마다 (이름, extends 원문, 데코레이터 [(이름, 원문)], 몸통 시작, 몸통 끝, 원문)."""
    t = open(path, encoding="utf-8").read()
    i, pending = 0, []
    while True:
        i = skip_space(t, i)
        if i >= len(t):
            return
        if t[i] == "@":
            name, raw, i = decorator(t, i)
            pending.append((name, raw))
            continue
        m = CLASS.match(t, i)
        if m:
            body_end = close(t, m.end() - 1)
            yield m.group(1), m.group(2), pending, m.end(), body_end - 1, t
            i = body_end
        else:
            i = statement_end(t, i)
            if i < len(t) and t[i] == "}":
                i += 1
        pending = []


def ts_files(root, suffix):
    for d, _, fs in sorted(os.walk(root)):
        for f in sorted(fs):
            if f.endswith(suffix) and not f.endswith(".spec.ts"):
                yield os.path.join(d, f)


def scan_routes(src):
    """컨트롤러의 라우트 — operationId(클래스_메서드) 순서대로."""
    routes = []
    for path in ts_files(src, ".controller.ts"):
        for cls, _, cdecos, s, e, t in classes(path):
            if not any(n == "Controller" for n, _ in cdecos):
                continue
            cauth = [raw for n, raw in cdecos if n in AUTH]
            for name, decos, params, ret, _ in members(t, s, e):
                verbs = [n for n, _ in decos if n in VERBS]
                if not verbs:
                    continue
                q = re.search(r"@Query\(\)\s*\w+\s*:\s*(\w+)", params)
                routes.append({"op": f"{cls}_{name}", "module": os.path.relpath(path, src).split(os.sep)[0],
                               "verb": verbs[0].upper(), "auth": cauth + [raw for n, raw in decos if n in AUTH],
                               "public": any(n == "Public" for n, _ in cdecos + decos),
                               "void": re.fullmatch(r"(Promise<)?void>?", ret) is not None,
                               "query_dto": q.group(1) if q else None})
    return routes


def scan_dtos(src):
    """클래스 이름 → {extends: 원문, props: {속성: [검증 데코레이터 원문]}}. 이름이 겹치면 앞의 것."""
    out = {}
    for path in ts_files(src, ".ts"):
        if "@" not in open(path, encoding="utf-8").read():
            continue
        for cls, ext, _, s, e, t in classes(path):
            props = {}
            for name, decos, _, _, _ in members(t, s, e):
                rules = [raw for _, raw in decos if not NOT_RULE.match(raw)]
                if decos:
                    props[name] = rules
            out.setdefault(cls, {"extends": ext, "props": props})
    return out


def source_rules(dtos, cls, prop, seen=None):
    """속성의 검증 데코레이터 원문. 자기 클래스에 없으면 extends 에 이름이 나오는 클래스에서 찾는다."""
    seen = seen or set()
    if cls not in dtos or cls in seen:
        return None
    seen.add(cls)
    d = dtos[cls]
    if prop in d["props"]:
        return d["props"][prop]
    for base in re.findall(r"\w+", d["extends"]):
        r = source_rules(dtos, base, prop, seen)
        if r is not None:
            return r
    return None


# ── openapi 스키마 펼치기 ──

def ref_name(s):
    return s["$ref"].rsplit("/", 1)[1]


def unwrap(s):
    """nullable 참조(allOf 하나)를 벗긴다."""
    if "allOf" in s and len(s["allOf"]) == 1:
        return {**s, **s["allOf"][0]}
    return s


def type_of(s):
    s = unwrap(s)
    if "$ref" in s:
        return ref_name(s)
    if s.get("type") == "array":
        return type_of(s.get("items", {})) + "[]"
    if "allOf" in s:
        return " & ".join(type_of(x) for x in s["allOf"])
    if "oneOf" in s or "anyOf" in s:
        return " | ".join(type_of(x) for x in s.get("oneOf") or s["anyOf"])
    t = s.get("type", "")
    return t + ("(" + s["format"] + ")" if s.get("format") and t == "string" else "")


def constraints(s):
    s = unwrap(s)
    out = [f"{k} {s[k]}" for k in CONSTRAINTS if k in s and k != "format"]
    if "enum" in s:
        out.append("enum " + " · ".join(map(str, s["enum"])))
    if s.get("type") == "array" and isinstance(s.get("items"), dict) and "$ref" not in s["items"]:
        out += ["items: " + c for c in constraints(s["items"])]
    return out


def fields(schemas, s, dtos, prefix="", seen=()):
    """(이름, 타입, 필수, 규칙, 설명) 줄. 객체 · 객체 배열은 이름에 점을 붙여 펼친다."""
    s = unwrap(s)
    if len(s.get("allOf", [])) > 1:  # 여러 스키마를 합친 본문(@ApiBody allOf)
        return [x for part in s["allOf"] for x in fields(schemas, part, dtos, prefix, seen)]
    item = s
    while unwrap(item).get("type") == "array":
        item = unwrap(item).get("items", {})
    item = unwrap(item)
    if "$ref" in item:
        cls = ref_name(item)
        if cls in seen or len(seen) > 5:
            return []
        obj, seen = schemas.get(cls, {}), seen + (cls,)
    elif item.get("type") == "object" and "properties" in item:
        cls, obj = None, item
    else:
        return []
    rows, req = [], set(obj.get("required", []))
    for name, p in obj.get("properties", {}).items():
        rules = source_rules(dtos, cls, name) if cls else None
        rows.append([prefix + name, type_of(p), "Y" if name in req else "N",
                     "\n".join(rules if rules is not None else constraints(p)), unwrap(p).get("description", "")])
        rows += fields(schemas, p, dtos, prefix + name + ("[]." if type_of(p).endswith("[]") else "."), seen)
    return rows


def describe(op):
    return "\n\n".join(x for x in (op.get("summary", ""), op.get("description", "")) if x)


def api_blocks(doc, routes, dtos):
    """라우트마다 (route, method, path, op, 표 줄들, 판정 불가 여부)."""
    by_op = {}
    for path, item in doc["paths"].items():
        for method, op in item.items():
            if isinstance(op, dict) and "operationId" in op:
                by_op[op["operationId"]] = (method.upper(), path, op)
    schemas = doc["components"]["schemas"]
    out = []
    for r in routes:
        method, path, op = by_op[r["op"]]
        rows, unknown = [], False
        for p in op.get("parameters", []):
            rules = source_rules(dtos, r["query_dto"], p["name"]) if p["in"] == "query" else None
            rows.append([p["in"], p["name"], type_of(p.get("schema", {})), "Y" if p.get("required") else "N",
                         "\n".join(rules if rules is not None else constraints(p.get("schema", {}))),
                         p.get("description", "")])
        for ctype, c in op.get("requestBody", {}).get("content", {}).items():
            label = "본문" + ("" if ctype == "application/json" else f" ({ctype})")
            sub = fields(schemas, c.get("schema", {}), dtos)
            rows += [[label] + x for x in sub] or [[label, "", type_of(c.get("schema", {})), "", "", ""]]
        for status, res in sorted(op.get("responses", {}).items()):
            desc = res.get("description", "")
            if int(status) >= 400:
                rows.append([f"오류 {status}", "", "", "", "", desc])
                continue
            content = res.get("content", {})
            if not content:
                body = "본문 없음" if r["void"] or status == "204" else UNKNOWN
                unknown |= body == UNKNOWN
                rows.append([f"응답 {status}", body, "", "", "", desc])
            for ctype, c in content.items():
                label = f"응답 {status}" + ("" if ctype == "application/json" else f" ({ctype})")
                s = c.get("schema")
                if not s:
                    unknown = True
                    rows.append([label, UNKNOWN, "", "", "", desc])
                    continue
                rows.append([label, "", type_of(s), "", "\n".join(constraints(s)), desc])
                rows += [[label] + x for x in fields(schemas, s, dtos)]
        out.append((r, method, path, op, rows, unknown))
    return out


def sheet_title(name, used):
    t, n = name[:31], 2
    while t in used:
        t, n = f"{name[:28]}~{n}", n + 1
    used.add(t)
    return t


def auth_text(r):
    return "\n".join(([] if r["public"] else ["JwtAuthGuard(전역)"]) + r["auth"])


def write_module(wb, title, blocks, link_font):
    """영역 시트: API 마다 제목 · 권한 · 설명 세 줄과 표. 각 API 첫 줄 번호를 돌려준다."""
    ws = wb.create_sheet(title)
    for col, w in zip("ABCDEF", (14, 30, 22, 7, 44, 60)):
        ws.column_dimensions[col].width = w
    first, row = {}, 1
    wrap = Alignment(wrap_text=True, vertical="top")
    for r, method, path, op, rows, _ in blocks:
        first[r["op"]] = row
        for label, value in ((method, path), ("권한", auth_text(r)), ("설명", describe(op))):
            ws.cell(row, 1, label).style = "머리행"
            ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=6)
            c = ws.cell(row, 2, value)
            c.style = "본문"
            c.alignment = wrap
            row += 1
        ws.cell(first[r["op"]], 2).font = Font(name=FONT, size=10, bold=True)
        for i, h in enumerate(["구분", "이름", "타입", "필수", "검증 규칙 · 값", "설명"], 1):
            ws.cell(row, i, h).style = "머리행"
        row += 1
        for x in rows:
            for i, v in enumerate(x, 1):
                ws.cell(row, i, v).style = "본문"
            row += 1
        c = ws.cell(row, 1, "API 목록으로")
        c.hyperlink = "#'API 목록'!A1"
        c.font = link_font
        row += 2
    return first


def build(doc, routes, dtos):
    """(블록들, 영역 → 블록들). 문서와 소스가 어긋나면 멈춘다."""
    ops = [op["operationId"] for item in doc["paths"].values() for op in item.values()
           if isinstance(op, dict) and "operationId" in op]
    missing = sorted({r["op"] for r in routes} - set(ops))
    extra = sorted(set(ops) - {r["op"] for r in routes})
    if missing or extra or len(ops) != len(routes):
        raise SystemExit(f"소스 라우트 {len(routes)} · 문서 {len(ops)} — 문서에 없음 {missing} · 소스에 없음 {extra}. "
                         "저장소 루트에서 pnpm openapi:export 를 먼저 돌려 주세요.")
    blocks = api_blocks(doc, routes, dtos)
    modules = {}
    for b in blocks:
        modules.setdefault(b[0]["module"], []).append(b)
    return blocks, modules


def write(version):
    """엑셀을 쓰고 (경로, API 수, 영역 수, 판정 불가 수) 를 돌려준다."""
    doc = json.load(open(OPENAPI, encoding="utf-8"))
    blocks, modules = build(doc, scan_routes(SRC), scan_dtos(SRC))
    wb, doc_name, doc_no = open_xlsx("API", version)
    link = Font(name=FONT, size=10, color="0563C1", underline="single")

    used = {s.title for s in wb.worksheets} | {"API 목록"}
    titles = {m: sheet_title(m, used) for m in modules}
    lst, head = table_sheet(
        wb, "API 목록", ["영역", "메서드", "경로", "이름", "권한"],
        [[b[0]["module"], b[1], b[2], describe(b[3]).split("\n")[0], auth_text(b[0])]
         for m in modules for b in modules[m]],
        [18, 9, 52, 50, 46],
        top_rows=[("원본", "whale-erp-api openapi/openapi.json(pnpm openapi:export) · src 의 컨트롤러 · DTO"),
                  ("참고", "@Public() 이 없는 라우트는 전역 JwtAuthGuard 를 거친다. 오류는 @Api…Response 로 적은 것만 담고, "
                         "서비스가 그 밖에 던지는 오류는 담지 않는다. 응답 형태를 코드에서 알 수 없으면 "
                         f"「{UNKNOWN}」로 적는다. 전역 경로 접두어는 없다.")])
    firsts = {}
    for m, bs in modules.items():
        firsts.update({op: (titles[m], row) for op, row in write_module(wb, titles[m], bs, link).items()})
    for i, b in enumerate(b for m in modules for b in modules[m]):
        title, row = firsts[b[0]["op"]]
        c = lst.cell(head + 1 + i, 3)
        c.hyperlink = f"#'{title}'!A{row}"
        c.font = link
    for row in lst.iter_rows(min_row=head + 1):
        row[4].alignment = Alignment(wrap_text=True, vertical="top")

    path = save_xlsx(wb, doc_name, f"{doc_no}_{doc_name}.xlsx")
    return path, len(blocks), len(modules), sum(1 for b in blocks if b[5])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    path, apis, modules, unknown = write(ap.parse_args().version)
    print(f"{path}\nAPI {apis} · 영역 {modules} · 「{UNKNOWN}」 {unknown}")


if __name__ == "__main__":
    main()
