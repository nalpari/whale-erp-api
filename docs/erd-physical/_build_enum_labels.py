#!/usr/bin/env python3
"""DB enum 한글 → src/enums/db-enums.generated.ts (GET /enums 의 DB 쪽 출처).

OpenAPI 문서에는 한글이 실리지 않는다. 물리 ERD 원본(_model.py ENUMS)의 한글로 만든다. 키는 enumName 과
같은 PascalCase 다 — DB enum 타입 이름(snake_case)을 PascalCase 로 바꾼 것이고, Prisma 쪽 이름(…Value 같은
예외)은 쓰지 않는다. DB 에 없는 API 전용 enum 은 src/enums/api-enums.ts 에 손으로 둔다.

    python3 docs/erd-physical/_build_enum_labels.py      (_model.py 의 ENUMS 를 고친 뒤)
"""
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
API = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
from _model import ENUMS  # noqa: E402

OUT_TS = os.path.join(API, "src", "enums", "db-enums.generated.ts")


def pascal(s):
    return "".join(x[:1].upper() + x[1:] for x in s.split("_"))


labels = {}
for (table, col), (name, vals, ko) in ENUMS.items():
    parts = [x.strip() for x in ko.split("·")]
    if len(parts) != len(vals):
        raise SystemExit(f"{name}: 값 {len(vals)}개에 한글 {len(parts)}개 — _model.py 를 고친다")
    key = pascal(name)
    d = dict(zip(vals, parts))
    if key in labels and labels[key] != d:
        raise SystemExit(f"{key}: 같은 enum 의 한글이 테이블마다 다르다")
    labels[key] = d

# GET /enums 의 DB 쪽 출처. 배포물에 같이 들어가도록 src 아래 TS 로 둔다(빌드 때 Python 이 필요 없게 커밋한다).
ts = ["// docs/erd-physical/_build_enum_labels.py 가 _model.py 에서 만든다. 손으로 고치지 말 것.",
      "import type { EnumSource } from './enums.service';", "",
      "export const DB_ENUMS: EnumSource = {"]
for key in sorted(labels):
    ts.append(f"  {key}: [")
    # 저장소 Prettier 는 작은따옴표다(lint 오류). 값·한글에 작은따옴표가 들어오면 멈춘다.
    for v, k in labels[key].items():
        if "'" in v or "'" in k:
            raise SystemExit(f"{key}.{v}: 작은따옴표가 든 값·한글")
        ts.append(f"    ['{v}', '{k}'],")
    ts.append("  ],")
ts.append("};")
with open(OUT_TS, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(ts) + "\n")
print(f"src/enums/db-enums.generated.ts — enum {len(labels)} · 값 {sum(len(v) for v in labels.values())}")
