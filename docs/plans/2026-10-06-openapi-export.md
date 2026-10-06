# OpenAPI 문서 내보내기 (`pnpm openapi:export`)

- 요청: 기획 세션 전달, 재영 결정 (2026-10-06). 네이밍 원자료 4장 「API 타입·enum 공유」(md5 ca6c609b)
- 범위: api 쪽만. front·staff 의 `pnpm api:types` 는 그쪽 세션이 한다.

## 만들 것

| 파일 | 내용 |
|---|---|
| `src/openapi/document.ts` | Swagger 문서 설정 한 곳. `main.ts` 와 export 가 같이 쓴다 |
| `src/openapi/export.ts` | HTTP 서버를 열지 않고 문서를 `openapi/openapi.json` 으로 쓴다 |
| `package.json` | `openapi:export` = `nest build` → export |
| `src/auth/dto/token.response.dto.ts` | 예시: `type` 에 `@ApiProperty({ enum, enumName: 'UserType' })` — 문서에만 영향 |

## 정한 것과 이유

- **export 는 `nest build` 결과로 돈다.** Swagger 스키마는 CLI 플러그인이 `nest build` 때만 붙인다. ts-node 로 돌리면 DTO 속성이 문서에서 빠진다. 그래서 진입점을 `scripts/`(빌드 제외)가 아니라 `src/` 에 둔다.
- **DB 에 붙지 않는다.** `NestFactory.create` 만 하고 `init`·`listen` 을 하지 않으면 `PrismaService.onModuleInit`(`$connect`)이 돌지 않는다. 확인: `DATABASE_URL` 을 닿지 않는 주소로 바꿔 돌린다.
- **`JWT_SECRET` 은 필요하다.** `AuthModule` 이 만들어질 때 길이를 검사한다. `.env.local` 이 없는 곳(CI)에서는 넘겨 줘야 한다.
- **예시는 견본 `items` 가 아니라 인증 응답.** items 는 네이밍 규칙에서 "고치지 않는 예제"로 정했다.

## 단계

| | 단계 | 검증 |
|---|---|---|
| 1 | okf-ingest (원자료 ca6c609b) | — |
| 2 | 문서 설정 분리 + export | `DATABASE_URL` 을 막고 실행 → openapi.json 생성 |
| 3 | 예시 enumName | `components.schemas.UserType` 이 생기고 응답이 `$ref` 로 가리킴 |
| 4 | 회귀 | tsc 0 · lint · 유닛 82 · e2e 8 |

커밋·푸시는 재영 승인 뒤.

## 2026-10-06 변경 — enum 은 조회 API 로 (재영, 기획 세션 전달, 원자료 md5 f7ff246d)

enum 값·한글은 front·staff 가 생성 파일이 아니라 `GET /enums` 로 받는다. openapi:export·openapi.json·enumName 은 요청·응답 타입용으로 그대로 둔다.

- `src/enums/` — `EnumsService`(두 출처 합치기, order, version = 내용 sha256 앞 16자, 없는 이름 404, 이름 겹침은 기동 때 실패), `EnumsController`(`@Public`), `EnumsModule`
- 출처: `db-enums.generated.ts`(_build_enum_labels.py 가 _model.py 에서 생성, 커밋 — 빌드에 Python 이 필요 없게) + `api-enums.ts`(API 전용, 손으로. 값은 코드 상수에서 가져옴)
- 한글 대응표 JSON 은 만들지 않는다(재영). `_build_enum_labels.py` 는 `db-enums.generated.ts` 만 만들고 `openapi:export` 에서 빠졌다 — `_model.py` 의 ENUMS 를 고치면 따로 돌린다
- 캐시: Express 기본 약한 ETag 로 If-None-Match → 304. Cache-Control 은 두지 않는다
- 검증: 유닛(서비스 6 · 컨트롤러 3), e2e(토큰 없이 200 · 하나 조회 · 404 · ETag 304), 다른 포트로 띄워 curl
