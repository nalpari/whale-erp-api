"""파서 자체 검사 — .venv/bin/python test_build_table_definition.py"""
import os
import tempfile

import build_table_definition as B

SCHEMA = '''
// 3팀 1차 물리 모델 — 시험
/// 남 · 여
enum Gender {
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
  pins      Pin[]

  @@unique([email], map: "accounts_email_key")
  @@map("accounts")
}

// 1팀 1차 물리 모델 — 시험
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
models, enums = B.parse(f.name)
os.unlink(f.name)
by = {m["name"]: m for m in models}
acc, pin = by["Account"], by["Pin"]
assert enums == {"Gender": "gender"}
assert (acc["table"], acc["doc"], acc["team"], pin["team"]) == ("accounts", "계정", "3팀", "1팀")
rows = {r[0]: r for r in B.rows_of(acc, by, enums)}
assert list(rows) == ["account_id", "email", "gender", "amount", "tag_ids"]  # 관계 필드 pins 는 컬럼이 아니다
assert rows["account_id"][1:7] == ["integer", "N", "IDENTITY", "PK", "", "계정 ID"]
assert rows["email"][4:6] == ["UNIQUE", "accounts_email_key"] and rows["email"][6] == ""  # 주석 없으면 비운다
assert rows["gender"][1:3] == ["gender", "Y"]
assert rows["amount"][1] == "numeric(10,2)" and rows["tag_ids"][1:4] == ["integer[]", "N", "[]"]
rows = {r[0]: r for r in B.rows_of(pin, by, enums)}
assert rows["account_id"][4] == "PK, FK(accounts.account_id)"
assert rows["code"][4:6] == ["PK", "pins_code_at_idx (code, at)"]
assert rows["at"][1] == "timestamptz(6)" and rows["at"][3] == "now()"
print("ok")
