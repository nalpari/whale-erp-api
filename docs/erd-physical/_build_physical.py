#!/usr/bin/env python3
"""WHALE ERP 3팀 1차 물리 모델과 물리 ERD 화면 생성기.

논리 모델의 원본은 front `docs/erd/README.md` 카탈로그다(front 소유, 여기서 고치지 않는다). 이 스크립트는
그 표를 읽어 PostgreSQL 물리 모델로 옮기고 다음을 만든다.

  api   docs/raw/2026-10-06-3팀-schema.sql       CREATE TABLE · 제약 · 인덱스 · 주석 (원본)
  api   docs/raw/2026-10-06-3팀-물리-ERD.md       테이블 정의서 · 논리 ERD 와 달라진 점 · 자체 검사 결과
  front docs/erd/physical/*.html · schema.sql    영역별 논리 · 물리 · 논리+물리 보기 (사본)

물리 결정은 `_model.py` 에 모은다. 그리기·화면은 1팀 물리 ERD 생성기(front docs/erd/team1/_build_physical.py)와
같은 코드다. 1팀 테이블(stores · bp_codes · admin_accounts)은 만들지 않고 외래키로만 참조한다 —
이 스키마는 1팀 schema.sql 을 먼저 적용한 DB 에 얹는다.

    python3 docs/erd-physical/_build_physical.py     (api 저장소 루트에서, front 를 옆에 두고)
"""
import contextlib
import io
import os
import re
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
API = os.path.abspath(os.path.join(HERE, "..", ".."))
FRONT_ERD = os.path.abspath(os.path.join(API, "..", "whale-erp-front", "docs", "erd"))
OUT_HTML = os.path.join(FRONT_ERD, "physical")
RAW_SQL = os.path.join(API, "docs", "raw", "2026-10-06-3팀-schema.sql")
# 3팀 DDL 마이그레이션. 1팀 마이그레이션(20261006…) 뒤에 온다. 내용은 RAW_SQL 과 같다.
MIGRATION_SQL = os.path.join(API, "prisma", "migrations", "20261007000000_team3_initial", "migration.sql")
RAW_MD = os.path.join(API, "docs", "raw", "2026-10-06-3팀-물리-ERD.md")

sys.path.insert(0, HERE)
sys.path.insert(0, FRONT_ERD)
from _model import *  # noqa: E402,F401,F403
import _model as M  # noqa: E402
with contextlib.redirect_stdout(io.StringIO()):
    import _build as L  # noqa: E402  3팀 논리 ERD — 그리기·검사 함수와 배치를 같이 쓴다

SECTION_SLUG = {"계정과 접속": "account", "채용과 초대": "hiring", "근로계약": "contract",
                "근무스케줄과 출퇴근": "attendance", "TO-DO": "todo", "급여명세서": "payroll",
                "운영 알림과 직원 알림": "notify", "고객지원과 커뮤니티": "support"}


# ─── 카탈로그 읽기 ──────────────────────────────────────────────────────────
class LCol:
    def __init__(self, key, attr, ltype, col, note, logical=None, how=""):
        self.key, self.attr, self.ltype, self.col, self.note = key, attr, ltype, col, note
        self.logical = col if logical is None else logical  # 논리 카탈로그의 컬럼 표기
        self.how = how  # 그대로 · 이름 변경 · 나눔 · 추가 · 타입 변경


class LTable:
    def __init__(self, name, table, kind, section):
        self.name, self.table, self.kind, self.section = name, table, kind, section
        self.cols = []


def read_catalog():
    """같은 테이블이 여러 영역에 다시 나오면 처음(전체) 정의만 쓴다. 1팀 참조 블록은 건너뛴다."""
    tables, cur, section = {}, None, None
    with open(os.path.join(FRONT_ERD, "README.md"), encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n").rstrip("\r")
            m = re.match(r"^## (.+)$", line)
            if m:
                section, cur = SECTION_SLUG.get(m.group(1).strip()), None
                continue
            m = re.match(r"^### (.+?) `([a-z_]+)` · (.+)$", line)
            if m:
                name, table, kind = m.group(1), m.group(2), m.group(3).strip()
                cur = None
                if "1팀" in kind or table in tables or section is None:
                    continue
                cur = LTable(name, table, kind, section)
                tables[table] = cur
                continue
            if cur is None or not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 5 or cells[0] == "키" or cells[1].startswith("-"):
                continue
            col = cells[3].strip("`")
            if not re.match(r"^[a-z_0-9·]+$", col):
                raise SystemExit(f"{table}: 읽지 못한 컬럼 표기 {cells[3]!r} — 조용히 건너뛰지 않는다")
            cur.cols.append(LCol(cells[0], cells[1], cells[2], col, " | ".join(cells[4:]).strip()))
    return tables


def transform(cat):
    """논리 → 물리: 나눔 · 이름 변경 · 뺌 · 추가 · 타입 변경. 바뀐 것은 how 와 비고에 남긴다."""
    dropped = []
    for t, lt in cat.items():
        out = []
        for c in lt.cols:
            k = (t, c.col)
            if k in M.DROP:
                dropped.append((t, c.col, M.DROP[k]))
                continue
            if k in M.SPLIT:
                for name, attr in M.SPLIT[k]:
                    nn = M.RENAME.get((t, name), name)
                    out.append(LCol(c.key, attr, c.ltype, nn, c.note, logical=c.col, how="나눔"))
                continue
            nn = M.RENAME.get(k, c.col)
            out.append(LCol(c.key, c.attr, c.ltype, nn, c.note, logical=c.col, how="이름 변경" if nn != c.col else "그대로"))
        for after, key, attr, ltype, col, note in M.ADD.get(t, []):
            nc = LCol(key, attr, ltype, col, note, logical="", how="추가")
            if after == "^":
                out.insert(0, nc)
            elif after is None:
                out.append(nc)
            else:
                i = [x.col for x in out].index(after)
                out.insert(i + 1, nc)
        for c in out:
            if (t, c.col) in M.LTYPE:
                nt, why = M.LTYPE[(t, c.col)]
                if nt != c.ltype:
                    c.ltype = nt
                    c.how = (c.how + " · " if c.how not in ("그대로", "") else "") + "타입 변경"
                    c.why_type = why
            if (t, c.col) in M.DEMOTE_PK:
                c.key = c.key.replace("PK·", "").replace("PK", "")
        lt.cols = out
    return dropped


# ─── 물리 모델 ──────────────────────────────────────────────────────────────
LTYPE_PHYS = {"id": "integer", "text": "text", "code": "text", "hash": "text", "bool": "boolean",
              "datetime": "timestamptz(6)", "date": "date", "int": "integer", "decimal": "numeric",
              "money": "integer", "json": "jsonb", "time": "time", "enc": "bytea"}


class PCol:
    def __init__(self, table, lc):
        self.lc = lc
        self.name = lc.col
        self.pk = "PK" in lc.key
        own_pk = self.pk and M.FK_TARGET.get(self.name) == table
        self.fk = self.name in M.FK_TARGET and not own_pk
        self.ref = (M.FK_TARGET[self.name], None) if self.fk else None
        o = M.PHYS.get((table, self.name), {})
        self.enum = M.ENUMS.get((table, self.name))
        self.array = (table, self.name) in M.ENUM_ARRAY
        t = lc.ltype
        if t == "enum" and not self.enum:
            raise SystemExit(f"{table}.{self.name}: enum 값이 _model.ENUMS 에 없다")
        if "type" in o:
            self.type = o["type"]
        elif self.enum:
            self.type = self.enum[0] + ("[]" if self.array else "")
        else:
            self.type = LTYPE_PHYS[t]
        self.identity = self.pk and not self.fk and t == "id" and table not in M.KEEP_PK
        req = M.REQUIRED.get(table, [])
        if table in M.KEYS_ONLY_NOT_NULL:
            # 키만 NOT NULL — 기본키와 REQUIRED 에 든 외래키. boolean · created_at 도 NULL 을 받는다(기본값은 남는다).
            self.notnull = self.pk or (self.fk and self.name in req)
        else:
            self.notnull = (self.pk or t == "bool" or self.name in ("created_at", "updated_at") or self.name in req)
        if "default" in o:
            self.default = o["default"]
        elif t == "bool":
            self.default = "false"
        elif self.name in ("created_at", "updated_at"):
            self.default = "CURRENT_TIMESTAMP"
        else:
            self.default = None


class PTable:
    def __init__(self, lt):
        self.lt = lt
        self.name = lt.table
        self.cols = [PCol(lt.table, c) for c in lt.cols]
        self.pk = [c.name for c in self.cols if c.pk]


def build_model(cat):
    model = {t: PTable(lt) for t, lt in cat.items()}
    for t in model.values():
        for c in t.cols:
            if c.ref:
                rt = c.ref[0]
                rc = M.EXTERNAL.get(rt) or (model[rt].pk[0] if rt in model else None)
                c.ref = (rt, rc)
    return model


# ─── SQL ───────────────────────────────────────────────────────────────────
def q(s):
    return f'"{s}"'


def sql_text(s):
    return "'" + s.replace("'", "''") + "'"


def col_comment(c):
    txt = c.lc.attr + (f" — {c.lc.note}" if c.lc.note else "")
    if c.lc.how == "추가":
        txt += " (물리에서 추가)"
    elif c.lc.logical and c.lc.logical != c.name:
        txt += f" (논리 {c.lc.logical})"
    return txt


def build_sql(model):
    o = ["-- WHALE ERP 3팀 1차 물리 스키마 (PostgreSQL 15+)",
         "-- docs/erd-physical/_build_physical.py 가 front docs/erd/README.md 카탈로그에서 만든다. 손으로 고치지 말 것.",
         "-- 1팀 schema.sql(stores · bp_codes · admin_accounts)을 먼저 적용한 DB 에 얹는다. 그 테이블은 만들지 않는다.",
         "-- whale-erp-api 로 옮길 때는 마이그레이션 SQL 로 나눠 넣는다. CHECK 제약 · 부분 고유 인덱스 · EXCLUDE 는",
         "-- Prisma 스키마 언어로 표현되지 않으므로 마이그레이션 SQL 에만 남는다.", "",
         "CREATE EXTENSION IF NOT EXISTS btree_gist;  -- work_schedules 겹침 금지", ""]
    seen = {}
    for (t, c), (name, vals, ko) in M.ENUMS.items():
        seen.setdefault(name, (vals, ko))
    o.append("-- ── enum ──")
    for name, (vals, ko) in seen.items():
        o.append(f"CREATE TYPE {q(name)} AS ENUM ({', '.join(sql_text(v) for v in vals)});  -- {ko}")
    o.append("")
    for t in model.values():
        o.append(f"-- {t.lt.name}")
        o.append(f"CREATE TABLE {q(t.name)} (")
        lines = []
        for c in t.cols:
            typ = (q(c.enum[0]) + ("[]" if c.array else "")) if c.enum else c.type.upper()
            s = f"    {q(c.name)} {typ}"
            if c.identity:
                s += " GENERATED ALWAYS AS IDENTITY"
            if c.notnull:
                s += " NOT NULL"
            if c.default is not None:
                s += f" DEFAULT {c.default}"
            lines.append(s)
        lines.append("")
        lines.append(f"    CONSTRAINT {q(t.name + '_pkey')} PRIMARY KEY ({', '.join(q(p) for p in t.pk)})")
        o.append(",\n".join(lines).replace(",\n,\n", ",\n\n").replace("\n,\n", "\n\n"))
        o.append(");")
        o.append("")
    o.append("-- ── CHECK 제약 ──")
    for t, suffix, expr in M.CHECKS:
        o.append(f"ALTER TABLE {q(t)} ADD CONSTRAINT {q(t + '_' + suffix)} CHECK ({expr});")
    o.append("")
    o.append("-- ── 겹침 금지 ──")
    for t, suffix, expr, note in M.EXCLUDES:
        o.append(f"ALTER TABLE {q(t)} ADD CONSTRAINT {q(t + '_' + suffix)} EXCLUDE {expr};  -- {note}")
    o.append("")
    o.append("-- ── 고유 제약 ──")
    for t, cols, where, note in M.UNIQUES:
        s = f"CREATE UNIQUE INDEX {q(M.key_name(t, cols))} ON {q(t)} ({', '.join(q(c) for c in cols)})"
        o.append(s + (f" WHERE {where}" if where else "") + f";  -- {note}")
    for t, cols, where, note in M.UNIQUES_NND:
        o.append(f"CREATE UNIQUE INDEX {q(M.key_name(t, cols))} ON {q(t)} ({', '.join(q(c) for c in cols)}) "
                 f"NULLS NOT DISTINCT;  -- {note}")
    o.append("")
    o.append("-- ── 외래키 (모두 ON DELETE RESTRICT — 삭제는 is_deleted 로 하는 논리 삭제다) ──")
    for t in model.values():
        for c in t.cols:
            if c.ref:
                rt, rc = c.ref
                o.append(f"ALTER TABLE {q(t.name)} ADD CONSTRAINT {q(t.name + '_' + c.name + '_fkey')} "
                         f"FOREIGN KEY ({q(c.name)}) REFERENCES {q(rt)} ({q(rc)}) ON DELETE RESTRICT ON UPDATE NO ACTION;")
    o.append("")
    o.append("-- ── 조회 인덱스 ──")
    for t, cols in M.INDEXES:
        o.append(f"CREATE INDEX {q(t + '_' + '_'.join(cols) + '_idx')} ON {q(t)} ({', '.join(q(c) for c in cols)});")
    o.append("")
    o.append("-- ── 주석 ──")
    for t in model.values():
        o.append(f"COMMENT ON TABLE {q(t.name)} IS {sql_text(t.lt.name)};")
        for c in t.cols:
            o.append(f"COMMENT ON COLUMN {q(t.name)}.{q(c.name)} IS {sql_text(col_comment(c))};")
    o.append("")
    return "\n".join(o)


# ─── 자체 검사 ─────────────────────────────────────────────────────────────
ABBREV = {"no", "num", "nbr", "cnt", "qty", "amt", "info", "emp", "ctr", "att", "addr", "tel", "dt", "tm",
          "ymd", "seq", "cd", "nm", "desc", "img", "msg", "pwd", "pw", "ci"}
ALLOWED_ABBREV = {"id", "url", "bp", "hq", "faq", "todo", "rrn", "biz", "ceo", "admin"}


def singular(t):
    if t.endswith("ies"):
        return t[:-3] + "y"
    if t.endswith(("ches", "shes", "sses", "xes")):
        return t[:-2]
    return t[:-1] if t.endswith("s") else t


def self_check(cat, model, dropped):
    """세 가지: 외래키 대상 · 네이밍 위반 · 논리 엔티티와 컬럼 누락. (문제 목록, 요약) 을 돌려준다."""
    fk_err, name_err, miss = [], [], []
    for t in model.values():
        for c in t.cols:
            if c.ref and c.ref[0] not in model and c.ref[0] not in M.EXTERNAL:
                fk_err.append(f"{t.name}.{c.name} → {c.ref[0]} 없음")
            if c.ref and c.ref[1] is None:
                fk_err.append(f"{t.name}.{c.name} → {c.ref[0]} 기본키를 모름")
            if c.lc.ltype == "id" and not c.pk and not c.fk and not c.name.endswith("_id"):
                fk_err.append(f"{t.name}.{c.name}: id 타입인데 외래키도 _id 도 아님")
    for t in model.values():
        n = t.name
        # 같은 칸이 두 번이면 CREATE TABLE 이 실패한다. 논리 카탈로그에 칸이 생겼는데 _model.ADD 에도 남아 있으면 이렇게 된다.
        seen = set()
        for c in t.cols:
            if c.name in seen:
                name_err.append(f"{n}.{c.name}: 칸이 두 번 — 카탈로그와 _model.ADD 가 겹친다")
            seen.add(c.name)
        if not re.match(r"^[a-z][a-z0-9_]*s$", n):
            name_err.append(f"{n}: 테이블은 snake_case 복수형")
        if n not in M.KEEP_PK and t.pk != [singular(n) + "_id"]:
            name_err.append(f"{n}: 기본키는 {singular(n)}_id 여야 한다 (지금 {t.pk})")
        if "is_deleted" in [c.name for c in t.cols] and n.endswith(M.HISTORY_LIKE):
            name_err.append(f"{n}: 이력·로그 테이블에 is_deleted")
        for c in t.cols:
            cn = c.name
            if not re.match(r"^[a-z][a-z0-9_]*$", cn):
                name_err.append(f"{n}.{cn}: snake_case 아님")
            toks = set(cn.split("_"))
            bad = (toks & ABBREV) - ALLOWED_ABBREV
            if bad:
                name_err.append(f"{n}.{cn}: 약어 {sorted(bad)}")
            if c.type == "boolean" and not cn.startswith(("is_", "has_")):
                name_err.append(f"{n}.{cn}: 참·거짓은 is_·has_")
            if c.type.startswith("timestamptz") and not cn.endswith("_at"):
                name_err.append(f"{n}.{cn}: 시각은 _at")
            if c.type == "date" and not cn.endswith("_date"):
                name_err.append(f"{n}.{cn}: 날짜는 _date")
            if c.lc.ltype == "money" and not cn.endswith("_amount"):
                name_err.append(f"{n}.{cn}: 금액은 _amount")
            if c.fk and c.ref[0] == "admin_accounts" and not (cn.endswith("_by") or cn == "admin_account_id"):
                name_err.append(f"{n}.{cn}: 관리자 외래키는 {{역할}}_by")
            if c.fk and c.ref[0] != "admin_accounts" and not cn.endswith(singular(c.ref[0]) + "_id"):
                name_err.append(f"{n}.{cn}: 외래키는 …{singular(c.ref[0])}_id")
            if c.lc.ltype == "code" and not cn.endswith("_code"):
                name_err.append(f"{n}.{cn}: 공통코드 값 컬럼은 _code")
            if c.enum and not all(re.match(r"^[A-Z][A-Z0-9_]*$", v) for v in c.enum[1]):
                name_err.append(f"{n}.{cn}: enum 값은 UPPER_SNAKE")
    # 논리 엔티티와 컬럼이 빠짐없이 옮겨졌는가 — 논리 ERD 그림과 카탈로그 원문 둘 다와 맞춘다
    logical_tables = {e.table for d in L.DIAGRAMS for e in d.entities.values() if e.kind != "ref"}
    for t in sorted(logical_tables - set(model)):
        miss.append(f"논리 엔티티 {t} 가 물리에 없다")
    for t in sorted(set(model) - logical_tables):
        miss.append(f"물리 테이블 {t} 가 논리 ERD 그림에 없다")
    raw = read_catalog()
    dropped_keys = {(t, c) for t, c, _ in dropped}
    for t, lt in raw.items():
        carried = {c.lc.logical for c in model[t].cols}
        for c in lt.cols:
            if c.col not in carried and (t, c.col) not in dropped_keys:
                miss.append(f"{t}.{c.col}: 논리 컬럼이 물리에 없다")
    return fk_err, name_err, miss
# ─── 그림 ──────────────────────────────────────────────────────────────────
GAP_X = 120
GAP_Y = 64
VIEW_W = {"physical": 340, "both": 580}  # 논리+물리 보기는 속성명·컬럼명·타입이 한 줄에 들어간다
VIEW_LABEL = {"logical": "논리", "physical": "물리", "both": "논리+물리"}


def col_x(view, i):
    return 40 + i * (VIEW_W[view] + GAP_X)


# 영역별 배치는 논리 ERD 의 열·세로 순서를 그대로 쓴다. main 에서 채운다.
# full 은 그 영역이 집인 테이블(모든 컬럼), 나머지는 PK·이름만.
LAYOUT = {}
# 박스별 최소 세로 위치 (영역, 엔티티 id) → y. 물리 박스가 길어져 관계선이 지나갈 틈이 없을 때만 쓴다.
Y_MIN = {
    ("hiring", "account"): 360,  # 계정 → 연결 보류 선이 지나갈 높이(456)가 계정 박스 안에 들게
}
# 박스 열 옮김 (영역, 엔티티 id) → 열. 물리 박스가 길어져 같은 열에 둘 수 없을 때만.
COL_MOVE = {
    ("hiring", "tax"): 0,  # 신고 정보를 계정 아래로 — 가운데 열을 계정 → 연결 보류 선에 비워 준다
}
REL_FIX = {
    ("hiring", 5): {"sa": "right", "sb": "left", "at_a": 456, "at_b": 456},  # 계정 → 연결 보류: 넓힌 가운데 열 틈으로 곧게
    ("payroll", 1): {"at_a": 288, "at_b": 288},                              # 근로계약 → 급여명세서: 곧게
    ("hiring", 3): {"sa": "left", "sb": "right", "at_a": 360, "at_b": 600},  # 직원 레코드 → 신고 정보: 옮긴 박스 쪽으로 열 사이 틈을 따라
}
COMPACT_KEEP = {"name", "title", "email", "status", "kind"}


def phys_type(c):
    return c.type + ("" if c.notnull else "?")


def ref_rows(lent):
    """3팀 참조 엔티티는 논리 ERD 박스를 그대로 쓴다. (접두, 속성명, 컬럼, 타입)"""
    out = []
    for f in lent.fields:
        name = f.column
        typ = {"id": "integer", "text": "text", "enum": "enum"}.get(f.type, f.type)
        out.append((f.prefix, f.name, name, typ))
    return out


def rows_for(lent, model, full):
    if lent.kind == "ref" or lent.table not in model:
        return ref_rows(lent)
    t = model[lent.table]
    cols = t.cols if full else [c for c in t.cols if c.pk or c.name in COMPACT_KEEP]
    return [(("#" if c.pk else "") + ("→" if c.ref else ""), c.lc.attr, c.name, phys_type(c)) for c in cols]


def view_entity(lent, view, col, model, full):
    rows = rows_for(lent, model, full)
    if view == "physical":
        specs = [f"{p}|{c}|{t}|{c}|" for p, a, c, t in rows]
    else:  # 논리+물리: 이름 칸에 속성명, 컬럼명은 combo_entity_svg 가 따로 그린다
        specs = [f"{p}|{a}|{t}|{c}|" for p, a, c, t in rows]
    e = L.Entity(lent.id, lent.name, lent.table, lent.kind, specs, 0, 0)
    e.x, e.w = col_x(view, col), VIEW_W[view]
    e.combo = view == "both"
    return e


def view_diagrams(model, view):
    out = []
    for ld in L.DIAGRAMS:
        lay = LAYOUT[ld.slug]
        ents = [view_entity(ld.entities[eid], view, lay["cols"][eid], model, eid in lay["full"]) for eid in ld.order]
        by_col = {}
        for e, eid in zip(ents, ld.order):
            by_col.setdefault(e.x, []).append((ld.entities[eid].y, e))
        for lst in by_col.values():
            # 논리 ERD 의 세로 위치를 최소값으로 지킨다. 박스가 길어진 만큼만 아래로 민다.
            y = 40
            for ly, e in sorted(lst, key=lambda p: p[0]):
                e.y = max(L.r4(ly), y, Y_MIN.get((ld.slug, e.id), 0))
                y = L.r4(e.y + e.h + GAP_Y)
        rels = []
        for i, r in enumerate(ld.rels):
            fix = REL_FIX.get((ld.slug, i), {})
            mid = fix.get("mid")
            if mid is not None:
                mid = col_x(view, mid[0]) + VIEW_W[view] + mid[1]
            rels.append(L.Rel(r.a, fix.get("sa", r.sa), r.b, fix.get("sb", r.sb), r.ca, r.cb, r.label,
                              at_a=fix.get("at_a"), at_b=fix.get("at_b"), mid=mid,
                              label_side=fix.get("label_side", r.label_side)))
        out.append(L.Diagram(ld.slug, ld.nav, ld.title, ld.subtitle, ents, rels, ld.cards, ld.catalog_intro))
    return out


ATTR_W = 0  # 논리+물리 보기의 속성명 칸 폭. main 에서 정한다


def combo_entity_svg(e):
    """논리+물리 보기 박스: 접두 · 속성명 · 컬럼명 · 타입. 논리 박스 그리기에 컬럼명만 더한다."""
    svg = L._orig_entity_svg(e)
    add = []
    for i, f in enumerate(e.fields):
        by = e.y + L.HEAD_H + 24 + L.ROW_H * i
        add.append(L.t(e.x + 16 + 24 + ATTR_W, by, f.column, 11, L.INK if "#" in f.prefix else L.MUTED, L.MONO))
    return svg[:-len("</g>")] + "\n".join(add) + "\n</g>"


def combo_check(d):
    errs = []
    for e in d.entities.values():
        for f in e.fields:
            need = 16 + 24 + ATTR_W + L.text_w(f.column, 11, 0.62) + 12 + L.text_w(f.type, 9, 0.62) + 16
            if need > e.w:
                errs.append(f"{d.slug}: {e.id}.{f.column} 가 박스 폭을 넘음 ({need:.0f}>{e.w})")
    return errs


def view_svg(d, view):
    svg, errs, _ = L.build_svg(d)
    if view == "both":
        errs = [x for x in errs if "박스 폭을 넘음" not in x] + combo_check(d)
    # 한 페이지에 SVG 가 셋이라 id 가 겹치지 않게 보기 이름을 붙인다
    svg = svg.replace(f"erd-{d.slug}-", f"erd-{d.slug}-{view}-").replace('id="ent-', f'id="{view}-ent-')
    if view != "logical":
        svg = svg.replace(" 논리 ERD.", " 물리 ERD." if view == "physical" else " 논리·물리 ERD.")
    return svg, [f"[{VIEW_LABEL[view]}] {x}" for x in errs]


# ─── HTML ──────────────────────────────────────────────────────────────────
EXTRA_CSS = """
.nav-row{display:flex;align-items:center;gap:16px;margin:24px 0;flex-wrap:wrap}
.nav-row nav{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.view-btns{display:inline-flex;border:1px solid var(--rule-solid);border-radius:6px;overflow:hidden;background:var(--paper)}
.view-btns button{font-family:var(--sans);font-size:12.5px;font-weight:500;padding:5px 14px;border:0;border-right:1px solid var(--rule-solid);background:var(--paper);color:var(--muted);cursor:pointer}
.view-btns button:last-child{border-right:0}
.view-btns button:hover{color:var(--ink)}
.view-btns button[aria-pressed="true"]{color:var(--accent);background:var(--accent-tint)}
.view-btns button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.nav-row .tools{display:flex;gap:12px;align-items:center;margin-left:auto}
.nav-row .tools .key-btns{margin-left:0}
.v{display:none}
body[data-view="logical"] .v-logical,body[data-view="physical"] .v-physical,body[data-view="both"] .v-both{display:block}
body[data-view="logical"] .phys-only{display:none}
.view-note{font-size:13px;color:var(--muted);margin:0 0 12px}
table.spec{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;background:var(--paper)}
table.spec th,table.spec td{border-bottom:1px solid var(--rule);padding:6px 10px;text-align:left;vertical-align:top}
table.spec th{font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:var(--muted);font-weight:500;background:var(--paper-2)}
table.spec td.c{font-family:var(--mono);font-size:12px;white-space:nowrap}
table.spec td.n{color:var(--muted)}
.spec-wrap{overflow-x:auto}
.tbl{background:var(--paper);border:1px solid var(--rule-solid);border-radius:6px;padding:16px 20px;margin-top:16px}
.tbl h3{font-size:15px;font-weight:600;margin-bottom:2px}
.tbl h3 code{font-family:var(--mono);font-size:13px;color:var(--accent);margin-left:8px}
.tbl p.k{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:8px;line-height:1.7}
"""

VIEW_JS = """
<script>
(function(){
var views=['logical','physical','both'],body=document.body;
function pick(){var h=location.hash.slice(1);if(views.indexOf(h)>=0)return h;
try{var s=localStorage.getItem('erd-team3-physical-view');if(views.indexOf(s)>=0)return s}catch(e){}return 'physical'}
function apply(v){body.setAttribute('data-view',v);
document.querySelectorAll('.view-btns button').forEach(function(b){b.setAttribute('aria-pressed',b.dataset.view===v?'true':'false')});
document.querySelectorAll('nav[aria-label="ERD 영역"] a, .index-list a').forEach(function(a){a.href=a.getAttribute('href').split('#')[0]+(v==='physical'?'':'#'+v)});
try{localStorage.setItem('erd-team3-physical-view',v)}catch(e){}}
document.querySelectorAll('.view-btns button').forEach(function(b){b.addEventListener('click',function(){
var v=b.dataset.view;apply(v);history.replaceState(null,'',v==='physical'?location.pathname:'#'+v)})});
window.addEventListener('hashchange',function(){apply(pick())});
apply(pick());
})();
</script>
"""

VIEW_NOTE = {
    "logical": "",
    "physical": "PostgreSQL 테이블·컬럼·타입이다. 타입 끝 ? 는 NULL 허용이다. 이름이 논리 ERD 와 다른 컬럼은 테이블 정의의 비고에 논리 이름을 적었다.",
    "both": "논리 속성명 옆에 물리 컬럼명과 타입을 함께 보인다. 타입 끝 ? 는 NULL 허용이다.",
}


# 그림 끌어 옮기기: 마우스로 그림을 잡고 끌면 가로는 그림 영역이, 세로는 페이지가 스크롤된다.
# 3팀 물리 ERD 모든 장에 붙인다.
DRAG_PAN_SLUGS = {"index", "account", "hiring", "contract", "attendance", "todo", "payroll", "notify", "support"}
DRAG_PAN_CSS = """
.diagram.pan{cursor:grab}
.diagram.pan.dragging{cursor:grabbing;user-select:none}
"""
DRAG_PAN_JS = """
<script>
(function(){
var d=document.querySelector('.diagram');if(!d)return;
d.classList.add('pan');
var on=false,moved=false,sx=0,sy=0,sl=0,wy=0;
d.addEventListener('pointerdown',function(e){
if(e.button!==0||e.pointerType==='touch')return;
on=true;moved=false;sx=e.clientX;sy=e.clientY;sl=d.scrollLeft;wy=window.scrollY;
});
window.addEventListener('pointermove',function(e){
if(!on)return;
var dx=e.clientX-sx,dy=e.clientY-sy;
if(!moved&&Math.abs(dx)+Math.abs(dy)<4)return;
if(!moved){moved=true;d.classList.add('dragging');try{d.setPointerCapture(e.pointerId)}catch(_){}}
d.scrollLeft=sl-dx;window.scrollTo(window.scrollX,wy-dy);e.preventDefault();
});
function end(){if(!on)return;on=false;d.classList.remove('dragging')}
window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
d.addEventListener('click',function(e){if(moved){e.preventDefault();e.stopPropagation();moved=false}},true);
d.addEventListener('dragstart',function(e){e.preventDefault()});
})();
</script>
"""


def esc(s):
    return L.esc(s)


def home_tables(slug, model):
    if slug == "index":
        return []
    return [t for t in model.values() if t.lt.section == slug]


def spec_html(t):
    rows = []
    for c in t.cols:
        key = " · ".join(x for x in (("PK" if c.pk else ""), ("FK" if c.ref else "")) if x)
        ref = f"→ {c.ref[0]}.{c.ref[1]}" if c.ref else ""
        dflt = "IDENTITY" if c.identity else (c.default or "")
        note = c.lc.note
        if c.ref:  # 참조 칸에 이미 나오는 "xxx FK" 문구는 뺀다
            note = re.sub(r"^[a-z_]+(\.[a-z_]+)? FK(, ?|$)", "", note).strip()
        if c.enum:
            note = (note + " · " if note else "") + " · ".join(c.enum[1])
        rows.append(f"<tr><td class='c'>{esc(key)}</td><td class='c'>{esc(c.name)}</td><td class='c'>{esc(c.type)}</td>"
                    f"<td class='c'>{'NOT NULL' if c.notnull else ''}</td><td class='c'>{esc(dflt)}</td>"
                    f"<td>{esc(c.lc.attr)}</td><td class='n'>{esc(' '.join(x for x in (ref, note) if x))}</td></tr>")
    extras = []
    for tt, cols, where, note in UNIQUES + UNIQUES_NND:
        if tt == t.name:
            extras.append(f"UNIQUE ({', '.join(cols)})" + (f" WHERE {where}" if where else "") + f" — {note}")
    for tt, suffix, expr in CHECKS:
        if tt == t.name:
            extras.append(f"CHECK {t.name}_{suffix}: {expr}")
    for tt, cols in INDEXES:
        if tt == t.name:
            extras.append(f"INDEX {t.name}_{'_'.join(cols)}_idx ({', '.join(cols)})")
    k = "".join(f"{esc(x)}<br>" for x in extras)
    return (f"<div class='tbl' id='t-{t.name}'><h3>{esc(t.lt.name)}<code>{esc(t.name)}</code></h3>"
            "<div class='spec-wrap'><table class='spec'><thead><tr><th>KEY</th><th>COLUMN</th><th>TYPE</th><th>NULL</th>"
            f"<th>DEFAULT</th><th>속성</th><th>참조 · 비고</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>"
            f"{'<p class=k>' + k + '</p>' if k else ''}</div>")


def page(d, svgs, model):
    marker = "<!--SVGS-->"
    html = L.page(d, marker)
    blocks = []
    for view, svg in svgs.items():
        note = f'<p class="view-note">{esc(VIEW_NOTE[view])}</p>' if VIEW_NOTE[view] else ""
        blocks.append(f'<div class="v v-{view}">{note}{svg}</div>')
    html = html.replace(marker, "\n".join(blocks))
    html = html.replace("WHALE ERP · LOGICAL ERD", "WHALE ERP · PHYSICAL ERD")
    # 논리 ERD 의 그림 제목이 <title>·h1·그림 제목에 그대로 넘어온다 — 물리 ERD 이름으로 바꾼다
    html = html.replace("WHALE ERP 1차 논리 ERD", "WHALE ERP 3팀 1차 물리 ERD")
    if d.slug != "index":
        html = html.replace(f"<title>{esc(d.title)}</title>", f"<title>{esc(d.title)} · 3팀 1차 물리 ERD</title>", 1)
    html = html.replace("</style>", EXTRA_CSS + "</style>", 1)
    html = html.replace("<body>", '<body data-view="physical">', 1)
    btns = "".join(f'<button type="button" aria-pressed="{"true" if v == "physical" else "false"}" data-view="{v}">'
                   f"{VIEW_LABEL[v]}</button>" for v in ("logical", "physical", "both"))
    # 3팀 논리 페이지에는 1팀의 .nav-row · PK·FK 버튼(.key-btns)이 없다. 영역 탭(nav)과 보기 버튼을
    # 한 줄(.nav-row)로 묶어 넣는다. 끼울 자리를 못 찾으면 버튼 없는 페이지가 조용히 나가므로 멈춘다.
    tools = f'<div class="tools"><div class="view-btns" role="group" aria-label="보기">{btns}</div></div>'
    m = re.search(r'(<nav aria-label="ERD 영역">.*?</nav>)\n<div class="diagram">', html, re.S)
    if not m:
        raise SystemExit(f"{d.slug}: 보기 버튼을 넣을 영역 탭을 찾지 못했다")
    html = html[:m.start()] + f'<div class="nav-row">{m.group(1)}{tools}</div>\n<div class="diagram">' + html[m.end():]
    tables = home_tables(d.slug, model)
    extra = ""
    if tables:
        extra = '<div class="phys-only"><h2>테이블 정의</h2>' + "".join(spec_html(t) for t in tables) + "</div>"
    if d.slug == "index":
        extra = ('<div class="phys-only"><h2>스키마</h2><p class="subtitle">CREATE TABLE·제약·인덱스·주석은 '
                 '<a href="schema.sql">schema.sql</a> 에 있다. 영역 장의 물리·논리+물리 보기 아래에 테이블 정의가 있다.</p></div>')
    html = html.replace('<div class="footer">', extra + '\n<div class="footer">', 1)
    html = html.replace("</body>", VIEW_JS + "</body>", 1)
    if d.slug in DRAG_PAN_SLUGS:
        html = html.replace("</style>", DRAG_PAN_CSS + "</style>", 1)
        html = html.replace("</body>", DRAG_PAN_JS + "</body>", 1)
    return html




# ─── 정의서 (원자료 md) ─────────────────────────────────────────────────────
AREA_NAME = {d.slug: d.nav for d in L.DIAGRAMS}


def md_cell(s):
    return (s or "").replace("|", "\\|")


def why_rename(t, a, b):
    for label, f in M.RENAME_WHY:
        if f(t, a, b):
            return label
    return "대응표의 영문 식별자"


def build_md(model, dropped, checks):
    fk_err, name_err, miss = checks
    n_col = sum(len(t.cols) for t in model.values())
    enum_names = {v[0] for v in M.ENUMS.values()}
    o = ["# WHALE ERP 3팀 1차 물리 ERD — 테이블 정의서", "",
         "- 작성: claude-code/opus-5.5 · 2026-10-06 (api 세션, 기획 세션 요청 · 재영 지시)",
         "- 상태: 재영 확인 전. 화면 확인 뒤 Prisma 변환을 따로 지시받는다.",
         "- 원본: front `docs/erd/README.md`(3팀 논리 ERD 카탈로그) → api `docs/erd-physical/_build_physical.py` 로 생성. 손으로 고치지 않는다.",
         "- DDL: `docs/raw/2026-10-06-3팀-schema.sql` · 화면: front `docs/erd/physical/`(미니 `/erd/physical/`)", "",
         "## 요약", "",
         f"- 3팀 물리 테이블 **{len(model)}개** · 컬럼 {n_col}개 · enum 타입 {len(enum_names)}개",
         f"- CHECK {len(M.CHECKS)}개 · 겹침 금지 {len(M.EXCLUDES)}개 · 고유 {len(M.UNIQUES) + len(M.UNIQUES_NND)}개 · 조회 인덱스 {len(M.INDEXES)}개",
         "- 1팀 테이블 `stores` · `bp_codes` · `admin_accounts` 는 만들지 않고 정수 기본키를 외래키로 참조한다. 1팀 schema.sql 을 먼저 적용한 DB 에 얹는다.", "",
         "## 물리 규칙", "",
         "- 기본키 `{참조 단수}_id integer GENERATED ALWAYS AS IDENTITY`. 1:1·복합 PK 테이블(" + ", ".join(f"`{x}`" for x in sorted(M.KEEP_PK)) + ")은 외래키를 묶은 PK.",
         "- 외래키 `{참조 단수}_id integer`, 관리자를 가리키면 `{역할}_by`. 모두 `ON DELETE RESTRICT` — 삭제는 `is_deleted` 논리 삭제다.",
         "- 시각 `timestamptz(6)` · 날짜 `date` · 금액 `integer`(원 단위, BigInt 를 쓰지 않는다) · JSON `jsonb` · 암호화 값 `bytea`.",
         "- 논리 타입 enum 은 PostgreSQL enum, 운영 중 바뀌는 목록은 공통코드 `*_code text`(외래키 없음).",
         "- `is_deleted` 는 삭제가 가능한 테이블에만 둔다. `*_histories` · `*_logs` 에는 두지 않는다.",
         "- 고유 제약은 필요한 곳에서 부분 인덱스. CHECK · 부분 인덱스 · EXCLUDE 는 Prisma 가 표현하지 못해 마이그레이션 SQL 에만 남는다.", "",
         "## 논리 ERD 와 달라진 점", "",
         "논리 카탈로그는 front 소유라 고치지 않았다. 아래는 물리에서만 바꾼 것이다.", ""]
    rows = {"이름 변경": [], "나눔": [], "추가": [], "타입 변경": []}
    for t in model.values():
        for c in t.cols:
            lc = c.lc
            if lc.how == "추가":
                rows["추가"].append(f"| `{t.name}` | `{c.name}` | {md_cell(lc.attr)}" + (f" — {md_cell(lc.note)}" if lc.note else "") + " |")
            elif lc.how.startswith("나눔"):
                rows["나눔"].append(f"| `{t.name}` | `{lc.logical}` → `{c.name}` | 한 줄에 두 컬럼 |")
            elif lc.how.startswith("이름 변경"):
                rows["이름 변경"].append(f"| `{t.name}` | `{lc.logical}` → `{c.name}` | {why_rename(t.name, lc.logical, c.name)} |")
            if "타입 변경" in lc.how:
                rows["타입 변경"].append(f"| `{t.name}` | `{c.name}` → {lc.ltype} | {md_cell(getattr(lc, 'why_type', ''))} |")
    for k, head in [("이름 변경", "| 테이블 | 논리 → 물리 | 이유 |"), ("나눔", "| 테이블 | 논리 → 물리 | 이유 |"),
                    ("추가", "| 테이블 | 컬럼 | 이유 |"), ("타입 변경", "| 테이블 | 컬럼 → 논리 타입 | 이유 |")]:
        o += [f"### {k} ({len(rows[k])})", "", head, "|---|---|---|"] + rows[k] + [""]
    o += [f"### 뺌 ({len(dropped)})", "", "| 테이블 | 논리 컬럼 | 이유 |", "|---|---|---|"]
    o += [f"| `{t}` | `{c}` | {md_cell(w)} |" for t, c, w in dropped] + [""]
    o += ["### 기본키를 바꾼 테이블", "", "| 테이블 | 바뀐 점 |", "|---|---|",
          "| `post_audiences` | 논리 PK (`post_id`, `audience_type`) → 대리키 `post_audience_id`. 부가서비스 상품을 여럿 고르면 논리 PK 가 겹친다 |", ""]
    o += ["### 논리 ERD 의 옛 설명", "",
          "물리 설계 중 찾은 옛 설명 네 곳은 2026-10-06 front 논리 ERD 에서 고쳤다 — 재설정 핀 15분(ME-1), "
          "`todos.urgent` 강조 표시, `notification_deliveries` 보류 문구(NOTI-1), `payslip_items.code` 목록 관리 주체. "
          "논리 카탈로그는 `notification_deliveries.scheduled_at` 을 「쓰지 않음」으로 남겨 두었고, 물리에는 만들지 않는다. "
          "항목 목록 테이블은 이번 범위 밖이라 `item_code` 는 외래키 없이 둔다.", ""]
    o += ["## 자체 검사", ""]
    for label, errs in (("외래키 대상이 있는가", fk_err), ("네이밍 규칙 위반이 없는가", name_err),
                        ("논리 엔티티·컬럼이 빠지지 않았는가", miss)):
        o.append(f"- {label}: " + ("**통과**" if not errs else f"**{len(errs)}건**"))
        o += [f"  - {e}" for e in errs]
    o.append("")
    o += ["## 테이블 정의", ""]
    for slug in [d.slug for d in L.DIAGRAMS if d.slug != "index"]:
        ts = [t for t in model.values() if t.lt.section == slug]
        if not ts:
            continue
        o += [f"### {AREA_NAME[slug]}", ""]
        for t in ts:
            o += [f"#### {t.lt.name} `{t.name}`", "",
                  "| 컬럼 | 타입 | NULL | 기본값 | 키 · 참조 | 속성 | 비고 |", "|---|---|---|---|---|---|---|"]
            for c in t.cols:
                key = " · ".join(x for x in ("PK" if c.pk else "", f"FK → {c.ref[0]}.{c.ref[1]}" if c.ref else "") if x)
                note = c.lc.note
                if c.enum:
                    note = (note + " · " if note else "") + " · ".join(c.enum[1])
                if c.lc.how == "추가":
                    note += " (물리에서 추가)"
                elif c.lc.logical != c.name:
                    note += f" (논리 `{c.lc.logical}`)"
                o.append(f"| `{c.name}` | {c.type} | {'' if c.notnull else 'NULL'} | "
                         f"{'IDENTITY' if c.identity else md_cell(c.default)} | {key} | {md_cell(c.lc.attr)} | {md_cell(note.strip())} |")
            extra = [f"UNIQUE ({', '.join(cs)})" + (f" WHERE {w}" if w and w != 'true' else "") + f" — {nt}"
                     for tt, cs, w, nt in M.UNIQUES + M.UNIQUES_NND if tt == t.name]
            extra += [f"CHECK `{t.name}_{s}`: `{e}`" for tt, s, e in M.CHECKS if tt == t.name]
            extra += [f"EXCLUDE `{t.name}_{s}` — {nt}" for tt, s, e, nt in M.EXCLUDES if tt == t.name]
            extra += [f"INDEX ({', '.join(cs)})" for tt, cs in M.INDEXES if tt == t.name]
            if extra:
                o += [""] + [f"- {x}" for x in extra]
            o.append("")
    return "\n".join(o)


def fill_layout(cat):
    for d in L.DIAGRAMS:
        xs = sorted({e.x for e in d.entities.values()})
        LAYOUT[d.slug] = {"cols": {eid: COL_MOVE.get((d.slug, eid), xs.index(e.x)) for eid, e in d.entities.items()},
                          "full": {eid for eid, e in d.entities.items()
                                   if e.kind != "ref" and e.table in cat and cat[e.table].section == d.slug}}


def write_migration(sql):
    """3팀 DDL 마이그레이션을 RAW_SQL 과 같은 내용으로 쓴다.

    어느 DB 에든 적용하기 전까지만 덮어쓴다. 적용한 마이그레이션을 고치면 그 DB 와 파일이 어긋나고
    Prisma 가 체크섬 불일치로 멈춘다. 그래서 적용한 뒤에는 _model.MIGRATION_APPLIED 를 True 로 바꾸고,
    그때부터는 내용이 달라지면 여기서 멈춘다 — 바꿀 것은 새 마이그레이션으로 낸다.
    """
    head = ("-- 3팀 1차 물리 스키마 DDL 마이그레이션. docs/erd-physical/_build_physical.py 가\n"
            "-- docs/raw/2026-10-06-3팀-schema.sql 과 같은 내용으로 쓴다. 손으로 고치지 말 것.\n"
            "-- 1팀 마이그레이션(20261006000000_team1_initial) 뒤에 적용한다 — 1팀 테이블을 외래키로 가리킨다.\n"
            "-- 한 번 적용한 뒤에는 고치지 않는다. 바꿀 것은 새 마이그레이션으로 낸다.\n\n")
    body = head + sql
    if os.path.exists(MIGRATION_SQL) and getattr(M, "MIGRATION_APPLIED", False):
        # 적용한 파일은 그대로 둔다. schema.sql · 정의서 · 화면은 계속 새 모델로 쓰고, 차이는 손으로 쓴 새 마이그레이션이
        # 메운다 — 「마이그레이션을 차례로 적용한 DB = 새 schema.sql」인지 PGlite 로 대조해 확인한다(okf team3-physical-schema).
        if open(MIGRATION_SQL, encoding="utf-8").read() != body:
            print("알림: 3팀 DDL 마이그레이션은 적용됨 — 파일은 그대로 두고, 바뀐 만큼 새 마이그레이션이 필요하다")
        return
    os.makedirs(os.path.dirname(MIGRATION_SQL), exist_ok=True)
    with open(MIGRATION_SQL, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)


def main():
    global ATTR_W
    cat = read_catalog()
    dropped = transform(cat)
    model = build_model(cat)
    checks = self_check(cat, model, dropped)
    sql = build_sql(model)
    # PostgreSQL 이름은 63바이트까지다. 넘으면 오류 없이 잘려 들어가서(PGlite 로 확인), 마이그레이션 SQL 의 이름과
    # DB 의 이름이 달라진다. Prisma 는 validate 에서 막지만 SQL 쪽은 아무도 막지 않는다.
    checks[1].extend(f"{x}: 이름이 {len(x.encode())}바이트 — PostgreSQL 은 63바이트에서 자른다"
                     for x in sorted(set(re.findall(r'"([a-z0-9_]+)"', sql))) if len(x.encode()) > 63)
    os.makedirs(OUT_HTML, exist_ok=True)
    for path in (RAW_SQL, os.path.join(OUT_HTML, "schema.sql")):
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(sql if path == RAW_SQL else sql.replace(
                "-- WHALE ERP 3팀 1차 물리 스키마 (PostgreSQL 15+)",
                "-- WHALE ERP 3팀 1차 물리 스키마 (PostgreSQL 15+) — 사본. 원본은 whale-erp-api docs/raw/2026-10-06-3팀-schema.sql", 1))
    write_migration(sql)
    with open(RAW_MD, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(build_md(model, dropped, checks))

    fill_layout(cat)
    views = {"logical": L.DIAGRAMS, "physical": view_diagrams(model, "physical"), "both": view_diagrams(model, "both")}
    ATTR_W = L.r4(max(L.text_w(f.name, 12) for d in views["both"] for e in d.entities.values() for f in e.fields))
    L._orig_entity_svg = L.entity_svg
    L.entity_svg = lambda e: combo_entity_svg(e) if getattr(e, "combo", False) else L._orig_entity_svg(e)
    errs = []
    try:
        for i, d in enumerate(L.DIAGRAMS):
            svgs = {}
            for view, ds in views.items():
                svg, e = view_svg(ds[i], view)
                svgs[view] = svg
                errs += e
            with open(os.path.join(OUT_HTML, f"{d.slug}.html"), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(page(d, svgs, model))
    finally:
        L.entity_svg = L._orig_entity_svg
    fk_err, name_err, miss = checks
    n_col = sum(len(t.cols) for t in model.values())
    print(f"물리 테이블 {len(model)}개 · 컬럼 {n_col}개 · ERD {len(L.DIAGRAMS)}장(논리·물리·논리+물리)")
    print(f"자체 검사 — 외래키 {len(fk_err)}건 · 네이밍 {len(name_err)}건 · 누락 {len(miss)}건")
    for e in fk_err + name_err + miss:
        print("  -", e)
    if errs:
        print(f"그림 검사 실패 {len(errs)}건")
        for e in errs:
            print("  -", e)
    return 1 if (errs or fk_err or name_err or miss) else 0


if __name__ == "__main__":
    sys.exit(main())
