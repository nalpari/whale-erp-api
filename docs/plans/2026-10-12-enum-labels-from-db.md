# enum 한글을 DB 타입 설명으로 옮긴다 (1팀·3팀 공통)

- 결정: B안 — enum 한글의 출처를 `COMMENT ON TYPE` 으로 한다. 1팀과 합의됨 (재영, 2026-10-12)
- 범위: whale-erp-api. front·staff 는 할 일이 없다(`GET /enums` 응답 모양이 그대로다)

## 지금

- DB enum 54개 = 3팀 46 + 1팀 8. 타입 설명(`COMMENT ON TYPE`)이 붙은 것은 0개다.
- `GET /enums` 의 DB 쪽 한글은 `src/enums/db-enums.generated.ts` 이고, `docs/erd-physical/_build_enum_labels.py` 가 3팀 `_model.py` 의 `ENUMS` 에서 만든다. 그래서 1팀 8개는 빠져 있다.
- 1팀 한글은 1팀 마이그레이션 `CREATE TYPE` 줄 끝 주석에만 있다(`-- 사용 · 사용중지`). SQL 주석이라 DB 에는 남지 않는다.

## 규칙 (새로 정한다)

1. enum 타입을 만드는 마이그레이션은 같은 파일에 `COMMENT ON TYPE "타입" IS '한글 · 한글';` 을 쓴다. 한글은 값 순서대로, ` · ` 로 나눈다.
2. `ALTER TYPE … ADD VALUE` 로 값을 더하는 마이그레이션은 `COMMENT ON TYPE` 을 새 값까지 넣어 다시 쓴다.
3. 한글은 용어집(`whale-erp-v2/CLAUDE.md`)의 표준 표기를 쓴다.

## 단계

1. **기존 54개에 설명 붙이기** — 새 마이그레이션 `<KST14자리>_enum_type_comments`. 3팀 46개는 `_model.ENUMS` 한글, 1팀 8개는 1팀 마이그레이션 주석 한글을 쓴다. 끝에 `DO` 블록을 두어 설명 없는 enum 이 0개인지 확인한다.
   - 검증: PGlite 에 전체 마이그레이션을 적용해 54개 모두 설명이 있고 값 수와 한글 수가 같다.
2. **생성기 교체 (테스트 먼저)** — `scripts/build-enum-labels.mjs`, `pnpm enums:generate`. 전체 마이그레이션을 빈 PGlite 에 적용하고 `pg_enum`(값·순서)과 타입 설명(한글)을 읽어 `db-enums.generated.ts` 를 쓴다. 키는 지금처럼 타입 이름의 PascalCase 다. 설명이 없거나 값 수와 한글 수가 다르면 멈춘다. 공용 DB 에 접속하지 않는다.
   - 검증: 새 생성기 출력이 지금 파일 46개와 같고, 1팀 8개만 더해진다(diff 로 확인).
3. **잊음을 막는 테스트** — `db-enums.generated.ts` 의 이름 · 값 · 순서가 `schema.prisma` 의 enum(`@@map` 기준)과 같지 않으면 (Prisma 7 클라이언트에는 `dmmf` 가 없어 스키마 파일을 읽는다) `pnpm test` 가 실패한다. enum 을 더하고 생성기를 안 돌렸을 때 잡힌다.
   - 검증: 생성 파일에서 한 enum 을 지우면 실패하고, 되돌리면 통과한다.
4. **3팀 물리 생성기** — `_build_physical.py` 가 `schema.sql` 에 `COMMENT ON TYPE` 도 쓰게 한다. 3팀은 계속 `_model.py` 만 고치고, 새 마이그레이션에 그 줄을 옮긴다.
   - 검증: 마이그레이션 합 = schema.sql (PGlite 대조, 기존 방식).
5. **정리** — `_build_enum_labels.py` 를 지운다. CLAUDE.md 「Migration rules」에 6번(위 규칙)을 더하고, okf(물리 스키마 두 문서 · naming 해설)와 log 를 고친다.
6. **적용·알림** — main 에 커밋·푸시 → 공용 DB `db:deploy` → `_prisma_migrations` 와 저장소 대조. 기획 세션에 규칙을 알려 네이밍 원자료와 1팀에 전하게 한다.

## 정해 둔 것

- 한글 출처는 저장소의 마이그레이션이다. 생성기는 공용 DB 가 아니라 PGlite 에서 읽는다 — 저장소에 없는 마이그레이션이 공용 DB 에 있는 경우가 있어서다.
- 앱은 뜰 때 DB 를 읽지 않는다. 지금처럼 커밋된 TS 파일을 쓴다(배포물에 Python·DB 접근이 필요 없다).
- 공통코드(`code_items`)는 대상이 아니다. 운영 중에 바뀌는 데이터다.

## 확인할 것

- 1팀 8개 한글이 용어집과 다른 곳이 있으면 1단계 전에 기획 세션에 묻는다.
- `_model.py` 의 3팀 한글 중 「제안」인 값(대응표에 없는 것)은 이번에 그대로 옮긴다. 확정은 기획 세션 몫이다.
