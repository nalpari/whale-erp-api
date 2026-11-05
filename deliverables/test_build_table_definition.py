"""파서 자체 검사 — .venv/bin/python test_build_table_definition.py"""
import os
import tempfile

from openpyxl import load_workbook

import build_table_definition as B

SCHEMA = '''
/// 남 · 여
enum Gender {
  /// 남자
  MALE
  FEMALE

  @@map("gender")
}

/// 계정
model Account {
  /// 계정 ID
  accountId Int      @id @default(autoincrement()) @map("account_id")
  email     String
  gender    Gender?
  /// 금액
  amount    Decimal? @db.Decimal(10, 2)
  tags      Int[]    @default([]) @map("tag_ids")
  meta      Json     @default("{}")
  name      String   @default("x")
  on        Boolean  @default(true)
  sex       Gender   @default(MALE)
  pins      Pin[]

  @@unique([email], map: "accounts_email_key")
  @@map("accounts")
}

model Pin {
  accountId Int      @map("account_id")
  code      String
  at        DateTime @default(dbgenerated("now()")) @db.Timestamptz(6)
  account   Account  @relation("PinAccount", fields: [accountId], references: [accountId], map: "pins_account_id_fkey")

  @@id([accountId, code])
  @@index([code, at], map: "pins_code_at_idx")
  @@map("pins")
}
'''

with tempfile.NamedTemporaryFile("w", suffix=".prisma", delete=False, encoding="utf-8") as f:
    f.write(SCHEMA)
models, enums, enum_list = B.parse(f.name)
os.unlink(f.name)
by = {m["name"]: m for m in models}
acc, pin = by["Account"], by["Pin"]
assert enums == {"Gender": "gender"}
assert [(e["doc"], e["values"]) for e in enum_list] == [("남 · 여", [("MALE", "남자"), ("FEMALE", "")])]
assert (acc["table"], acc["doc"]) == ("accounts", "계정")
rows = {r[0]: r for r in B.rows_of(acc, by, enums)}
assert list(rows) == ["account_id", "email", "gender", "amount", "tag_ids", "meta", "name", "on", "sex"]  # 관계 필드 pins 는 컬럼이 아니다
assert rows["account_id"][1:7] == ["integer", "N", "IDENTITY", "PK", "", "계정 ID"]
assert rows["email"][4:6] == ["UNIQUE", "accounts_email_key"] and rows["email"][6] == ""  # 주석 없으면 비운다
assert rows["gender"][1:3] == ["gender", "Y"]
assert rows["amount"][1] == "numeric(10,2)" and rows["tag_ids"][1:4] == ["integer[]", "N", "'{}'"]
assert [rows[c][3] for c in ("meta", "name", "on", "sex")] == ["'{}'::jsonb", "'x'", "true", "'MALE'"]
rows = {r[0]: r for r in B.rows_of(pin, by, enums)}
assert rows["account_id"][4] == "PK, FK(accounts.account_id)"
assert rows["code"][4:6] == ["PK", "pins_code_at_idx (code, at)"]
assert rows["at"][1] == "timestamptz(6)" and rows["at"][3] == "CURRENT_TIMESTAMP"  # dbgenerated("now()") 도 CURRENT_TIMESTAMP

# 실제 schema.prisma: /// 블록(테이블 · 컬럼 · enum · enum 값)이 하나도 빠지지 않고 어느 셀엔가 통째로 있다
path, _, _ = B.write("1.0")
wb = load_workbook(path)
cells = "\0".join(" ".join(str(c.value).split()) for w in wb.worksheets for r in w.iter_rows() for c in r if c.value)
blocks, cur = [], []
for line in open(B.SCHEMA, encoding="utf-8"):
    s = line.strip()
    if s.startswith("///"):
        cur.append(s[3:].strip())
    elif cur:
        blocks.append(" ".join(" ".join(cur).split()))
        cur = []
missing = [b for b in blocks if b and b not in cells]
assert not missing, f"엑셀에 없는 /// {len(missing)}건: {missing[:5]}"
assert "가입 · 휴대전화번호 변경" in cells  # 2026-11-05 대조에서 빠졌던 enum 설명
print(f"ok — /// {len(blocks)}블록 모두 있음")
