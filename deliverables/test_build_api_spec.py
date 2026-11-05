"""API 명세 자체 검사 — .venv/bin/python test_build_api_spec.py

1) 작은 컨트롤러 · DTO 로 렉서를 확인하고, 2) 저장소의 실제 라우트 수(데코레이터를 줄 단위로 센 수)와
엑셀 API 목록의 줄 수가 같은지 본다.
"""
import os
import re
import tempfile

from openpyxl import load_workbook

import build_api_spec as B

CONTROLLER = '''
import { Controller, Get, Post } from '@nestjs/common';

const idOf = (raw: string): number => {
  if (!raw) throw new Error('}');
  return Number(raw);
};

/** 설명 { 괄호 } */
@ApiForbiddenResponse({
  description: '권한 없음',
})
@UserTypes('admin')
@Controller('things')
export class ThingsController {
  constructor(private readonly svc: ThingService) {}

  @Get()
  @MenuPermission('read', { platformOnly: true })
  list(@Query() query: ListThingsQueryDto): Promise<{ items: string[] }> {
    const s = `${query.a}}`;
    return this.svc.list(s);
  }

  // @Get('commented-out')
  @Post(':id/close')
  @Public()
  @HttpCode(204)
  async close(@Param('id') raw: string): Promise<void> {
    await this.svc.close(idOf(raw));
  }
}

@Injectable()
export class NotAController {
  @Get()
  x() {}
}
'''

DTO = '''
export class BaseDto {
  /** 이름 */
  @IsString()
  @Transform(trim)
  @Length(1, 30, {
    message: '1~30자',
  })
  name: string;
}

export class ListThingsQueryDto extends PartialType(BaseDto) {
  @IsOptional()
  @ApiProperty()
  @Min(1)
  page?: number;
}
'''

with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, "things"))
    open(os.path.join(d, "things", "things.controller.ts"), "w", encoding="utf-8").write(CONTROLLER)
    open(os.path.join(d, "things", "things.dto.ts"), "w", encoding="utf-8").write(DTO)
    routes = B.scan_routes(d)
    dtos = B.scan_dtos(d)
assert [r["op"] for r in routes] == ["ThingsController_list", "ThingsController_close"]
list_, close = routes
assert list_["auth"] == ["@UserTypes('admin')", "@MenuPermission('read', { platformOnly: true })"]
assert (list_["module"], list_["verb"], list_["public"], list_["void"], list_["query_dto"]) == \
    ("things", "GET", False, False, "ListThingsQueryDto")
assert close["public"] and close["void"] and B.auth_text(close) == "@UserTypes('admin')\n@Public()"
assert B.auth_text(list_).startswith("JwtAuthGuard(전역)\n")
assert B.source_rules(dtos, "ListThingsQueryDto", "page") == ["@IsOptional()", "@Min(1)"]
assert B.source_rules(dtos, "ListThingsQueryDto", "name") == ["@IsString()", "@Length(1, 30, { message: '1~30자', })"]

# 응답 형태: 스키마가 없고 void 가 아니면 판정 불가, void 면 본문 없음
doc = {"components": {"schemas": {}}, "paths": {
    "/things": {"get": {"operationId": "ThingsController_list", "responses": {"200": {"description": ""}}}},
    "/things/{id}/close": {"post": {"operationId": "ThingsController_close",
                                    "responses": {"204": {"description": ""}, "404": {"description": "없음"}}}}}}
blocks, modules = B.build(doc, routes, dtos)
assert [b[5] for b in blocks] == [True, False] and list(modules) == ["things"]
assert blocks[0][4] == [["응답 200", B.UNKNOWN, "", "", "", ""]]
assert blocks[1][4] == [["응답 204", "본문 없음", "", "", "", ""], ["오류 404", "", "", "", "", "없음"]]

# 실제 저장소: 데코레이터를 줄 단위로 센 라우트 수 = 엑셀 API 목록 줄 수
verb = re.compile(r"^\s*@(" + "|".join(B.VERBS) + r")\(")
counted = sum(1 for p in B.ts_files(B.SRC, ".controller.ts")
              for line in open(p, encoding="utf-8") if verb.match(line))
path, apis, _, _ = B.write("1.0")
ws = load_workbook(path)["API 목록"]
head = next(r for r in range(1, ws.max_row + 1) if ws.cell(r, 1).value == "영역")
rows = sum(1 for r in range(head + 1, ws.max_row + 1) if ws.cell(r, 2).value)
assert counted == apis == rows, (counted, apis, rows)

# openapi 의 설명(summary · description, info 제외)이 하나도 잘리거나 빠지지 않고 어느 셀엔가 통째로 있다
doc = B.json.load(open(B.OPENAPI, encoding="utf-8"))


def descriptions(x, key=None):
    if isinstance(x, dict):
        for k, v in x.items():
            if k in ("summary", "description") and isinstance(v, str) and key != "properties":
                yield v
            yield from descriptions(v, k)
    elif isinstance(x, list):
        for v in x:
            yield from descriptions(v)


wanted = {" ".join(d.split()) for d in descriptions({k: v for k, v in doc.items() if k != "info"}) if d.strip()}
wb = load_workbook(path)
cells = "\0".join(" ".join(str(c.value).split()) for w in wb.worksheets for r in w.iter_rows() for c in r if c.value)
missing = sorted(d for d in wanted if d not in cells)
assert not missing, f"엑셀에 없는 설명 {len(missing)}건: {missing[:5]}"
for d in ("계정 잠금이 풀리는 시각", "상세코드. 저장 · 전송 값", "급여명세서 검토 사유 — 출퇴근 누락"):  # 2026-11-05 대조에서 빠졌던 것
    assert d in cells, d
print(f"ok — 라우트 {counted} = 문서 {rows} · 설명 {len(wanted)}건 모두 있음")
