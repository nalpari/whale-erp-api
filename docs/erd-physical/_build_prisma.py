#!/usr/bin/env python3
"""3팀 물리 모델 → prisma/schema.prisma 의 3팀 부분. docs/erd-physical/_build_physical.py 의 모델을 그대로 읽는다.

    python3 docs/erd-physical/_build_prisma.py      (api 루트에서. 물리 생성기를 먼저 돌린다)

schema.prisma 의 「3팀 1차 물리 모델」 표시 줄 아래를 통째로 다시 쓴다. 그 위(견본 모델)는 건드리지 않는다.

결정 (재영 2026-10-06, 기획 세션 전달 「1A, 2B, 3A」)
  - 견본 4개(Item·StockMovement·Staff·Customer)는 그대로 두고 3팀 모델을 옆에 더한다.
  - 1팀 테이블은 모델로 두지 않는다. 그 외래키는 정수 컬럼만 두고 제약은 SQL 쪽에.
  - schema.prisma 까지만. 마이그레이션은 만들지 않는다.
"""
import contextlib
import io
import os
import re
import sys

API = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCHEMA = os.path.join(API, "prisma", "schema.prisma")
MARK = "// 3팀 1차 물리 모델"
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
with contextlib.redirect_stdout(io.StringIO()):
    import _build_physical as B
M = B.M


def camel(s):
    p = s.split("_")
    return p[0] + "".join(x[:1].upper() + x[1:] for x in p[1:])


def pascal(s):
    return "".join(x[:1].upper() + x[1:] for x in s.split("_"))


cat = B.read_catalog()
dropped = B.transform(cat)
model = B.build_model(cat)
MODEL = {t: pascal(B.singular(t)) for t in model}

# 관계: 3팀 안의 외래키만. 1팀(EXTERNAL) 은 정수 컬럼만 둔다.
rels = []  # (src_table, col, dst_table)
for t in model.values():
    for c in t.cols:
        if c.ref and c.ref[0] in model:
            rels.append((t.name, c.name, c.ref[0]))
pair_count = {}
for s, c, d in rels:
    k = tuple(sorted((s, d)))
    pair_count[k] = pair_count.get(k, 0) + 1


def role_of(col, dst):
    base = B.singular(dst) + "_id"
    return None if col == base else col[: -len(base)].rstrip("_") or None


def rel_name(s, c, d):
    if pair_count[tuple(sorted((s, d)))] > 1 or s == d:
        return f"{MODEL[s]}_{camel(c)}"
    return None


def is_one_to_one(s, c):
    pk = model[s].pk
    return pk == [c]


def fk_field(s, c, d):
    r = role_of(c, d)
    return camel(r + "_" + B.singular(d)) if r else camel(B.singular(d))


def back_field(s, c, d):
    r = role_of(c, d)
    base = camel(B.singular(s)) if is_one_to_one(s, c) else camel(s)
    return base + ("As" + pascal(r) if r else "")


back = {}  # dst → [(field, type, relname)]
for s, c, d in rels:
    n = rel_name(s, c, d)
    typ = MODEL[s] + ("?" if is_one_to_one(s, c) else "[]")
    back.setdefault(d, []).append((back_field(s, c, d), typ, n))

SQL_ONLY = []  # (테이블, 종류, 내용)


def default_attr(c):
    if c.identity:
        return "@default(autoincrement())"
    d = c.default
    if d is None:
        return ""
    if d == "CURRENT_TIMESTAMP":
        return "@default(now())"
    if d in ("true", "false") or re.match(r"^-?\d+$", d):
        return f"@default({d})"
    m = re.match(r"^'([A-Z_]+)'$", d)
    if m:
        return f"@default({m.group(1)})"
    raise SystemExit(f"{c.name}: 옮기지 못한 기본값 {d}")


def enum_name(n):
    p = pascal(n)
    return p + "Value" if p in MODEL.values() else p


def ftype(c):
    if c.enum:
        return enum_name(c.enum[0]) + ("[]" if c.array else ""), ""
    t = c.type
    return {"integer": ("Int", ""), "text": ("String", ""), "boolean": ("Boolean", ""),
            "timestamptz(6)": ("DateTime", "@db.Timestamptz(6)"), "date": ("DateTime", "@db.Date"),
            "jsonb": ("Json", ""), "bytea": ("Bytes", ""), "time": ("DateTime", "@db.Time(6)")}[t]


out = []
for t in model.values():
    lines = []
    for c in t.cols:
        typ, db = ftype(c)
        opt = "" if (c.notnull or c.array) else "?"
        attrs = []
        if c.pk and len(t.pk) == 1:
            attrs.append("@id")
        if c.name == "updated_at":
            attrs.append("@updatedAt")
        da = default_attr(c)
        if da:
            attrs.append(da)
        if camel(c.name) != c.name:
            attrs.append(f'@map("{c.name}")')
        if db:
            attrs.append(db)
        doc = c.lc.attr + (f" — {c.lc.note}" if c.lc.note else "")
        lines.append((f"/// {doc}", camel(c.name), typ + opt, " ".join(attrs)))
    for s, c, d in rels:
        if s != t.name:
            continue
        n = rel_name(s, c, d)
        col = next(x for x in t.cols if x.name == c)
        opt = "" if col.notnull else "?"
        nm = f'"{n}", ' if n else ""
        lines.append((None, fk_field(s, c, d), MODEL[d] + opt,
                      f'@relation({nm}fields: [{camel(c)}], references: [{camel(model[d].pk[0])}], '
                      f'onDelete: Restrict, onUpdate: NoAction, map: "{s}_{c}_fkey")'))
    for f, typ, n in back.get(t.name, []):
        lines.append((None, f, typ, f'@relation("{n}")' if n else ""))
    w1 = max(len(x[1]) for x in lines)
    w2 = max(len(x[2]) for x in lines)
    body = []
    for doc, f, typ, a in lines:
        if doc:
            body.append(f"  {doc}")
        body.append(f"  {f.ljust(w1)} {typ.ljust(w2)} {a}".rstrip())
    blocks = []
    if len(t.pk) > 1:
        blocks.append(f"  @@id([{', '.join(camel(x) for x in t.pk)}])")
    for tt, cols, where, note in M.UNIQUES:
        if tt != t.name:
            continue
        if where:
            SQL_ONLY.append((tt, "부분 고유 인덱스", f"{tt}_{'_'.join(cols)}_key ({', '.join(cols)}) WHERE {where}"))
        else:
            blocks.append(f"  @@unique([{', '.join(camel(x) for x in cols)}], map: \"{tt}_{'_'.join(cols)}_key\")")
    for tt, cols, where, note in M.UNIQUES_NND:
        if tt == t.name:
            SQL_ONLY.append((tt, "NULLS NOT DISTINCT 고유", f"{tt}_{'_'.join(cols)}_key ({', '.join(cols)})"))
    for tt, cols in M.INDEXES:
        if tt == t.name:
            blocks.append(f"  @@index([{', '.join(camel(x) for x in cols)}], map: \"{tt}_{'_'.join(cols)}_idx\")")
    blocks.append(f'  @@map("{t.name}")')
    for tt, s_, e in M.CHECKS:
        if tt == t.name:
            SQL_ONLY.append((tt, "CHECK", f"{tt}_{s_}: {e}"))
    for tt, s_, e, note in M.EXCLUDES:
        if tt == t.name:
            SQL_ONLY.append((tt, "EXCLUDE", f"{tt}_{s_} — {note} (btree_gist)"))
    for c in t.cols:
        if c.ref and c.ref[0] in M.EXTERNAL:
            SQL_ONLY.append((t.name, "1팀 외래키", f"{t.name}_{c.name}_fkey → {c.ref[0]}.{c.ref[1]}"))
        if c.identity:
            pass
    out.append(f"/// {t.lt.name}\nmodel {MODEL[t.name]} {{\n" + "\n".join(body) + "\n\n" + "\n".join(blocks) + "\n}")

enums = {}
for (tt, c), (name, vals, ko) in M.ENUMS.items():
    enums.setdefault(name, (vals, ko))
enum_out = [f"/// {ko}\nenum {enum_name(name)} {{\n" + "\n".join(f"  {v}" for v in vals) + f"\n\n  @@map(\"{name}\")\n}}"
            for name, (vals, ko) in enums.items()]

kinds = {}
for _, k, _ in SQL_ONLY:
    kinds[k] = kinds.get(k, 0) + 1
head = ["// ═══════════════════════════════════════════════════════════════════════════",
        "// 3팀 1차 물리 모델 — docs/raw/2026-10-06-3팀-schema.sql 과 같은 테이블을 Prisma 로 옮긴 것.",
        "// 원본은 docs/erd-physical/ 생성기다. 이 아래는 손으로 고치지 말고 생성기로 다시 만든다.",
        "//",
        "// 1팀 테이블(stores · bp_codes · admin_accounts)은 모델로 두지 않는다. 그 외래키(store_id, bp_code_id,",
        "// admin_account_id, *_by)는 정수 컬럼만 있고, 제약은 SQL 쪽에만 있다.",
        "// 마이그레이션은 아직 없다 — 1팀 테이블이 DB 에 생긴 뒤에 만든다.",
        "//",
        "// Prisma 가 표현하지 못해 SQL 에만 있는 것: " + ", ".join(f"{k} {n}" for k, n in kinds.items()) + ".",
        "// 기본키는 SQL 에서 GENERATED ALWAYS AS IDENTITY 다(여기서는 autoincrement 로 보인다).",
        "// 그 제약들의 원문은 docs/raw/2026-10-06-3팀-schema.sql 이다.",
        "// ═══════════════════════════════════════════════════════════════════════════", ""]
cur = open(SCHEMA, encoding="utf-8").read()
DIV = head[0]
i = cur.find(MARK)
if i >= 0:
    # 3팀 구역만 다시 쓴다: 표시 줄 앞 구분선부터, 머리말을 닫는 구분선 다음에 오는 구분선(다른 구역 — 1팀) 전까지.
    # 끝까지 다시 쓰면 뒤에 붙은 1팀 구역(2256b83)이 지워진다.
    keep = cur[:cur.rfind("\n", 0, cur.rfind("\n", 0, i)) + 1].rstrip("\n") + "\n\n"
    close = cur.find(DIV, i)
    nxt = cur.find("\n" + DIV, close + len(DIV)) if close >= 0 else -1
    tail = cur[nxt + 1:] if nxt >= 0 else ""
else:
    keep, tail = cur.rstrip("\n") + "\n\n", ""
with open(SCHEMA, "w", encoding="utf-8") as fh:
    fh.write(keep + "\n".join(head) + "\n\n".join(enum_out) + "\n\n" + "\n\n".join(out) + "\n"
             + ("\n" + tail if tail else ""))
print(f"모델 {len(model)} · enum {len(enums)} · 3팀 내부 관계 {len(rels)} · SQL 전용 {len(SQL_ONLY)} ({kinds})")
