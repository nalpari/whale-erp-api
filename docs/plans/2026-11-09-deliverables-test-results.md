# 내부 납품 산출물: 테스트 결과서(엑셀)

근거: 2026-11-09 기획 세션 지시. 산출물 5번. 템플릿과 공통 코드는 `2026-11-05-deliverables-policy-userflow.md` 와 같이 쓴다.

## 정해진 것

- 문서 번호 `WHALE-TEST`, 문서 이름 테스트 결과서, 작성자 인터플러그, 버전 1.0. `revisions.json` 에 넣는다.
- 생성기 `deliverables/build_test_results.py`. `common.py` 의 `open_xlsx` · `table_sheet` · `save_xlsx` 를 쓴다. 자체 검사는 `deliverables/test_build_test_results.py` 다.
- 숫자를 손으로 적지 않는다. 입력은 실제 실행 결과를 저장한 `deliverables/sources/test_results.json` 하나다.
- 제품 코드와 시험 코드는 고치지 않는다.

## 실행 항목

| 저장소 | 단위 | e2e | 타입 | 린트 |
|---|---|---|---|---|
| API | `jest` | `jest --config test/jest-e2e.json --runInBand --forceExit` | `tsc --noEmit -p tsconfig.json` | `eslint "{src,apps,libs,test,scripts}/**/*.ts"` |
| 관리자 웹 | `node --test "src/**/*.test.ts"` | 없음 | `tsc --noEmit` | `eslint .` |
| 직원 근무 앱 | `node --test "src/**/*.test.ts"` | 없음 | `tsc --noEmit` | `eslint .` |

- 린트는 `--fix` 없이 돈다. 파일 단위로 센다. 전체는 검사한 파일 수, 실패는 오류가 있는 파일 수이며 경고 건수는 비고에 적는다.
- 관리자 웹 · 직원 근무 앱은 타입 검사 전에 `next typegen` 으로 Next 전역 타입(`.next/types`, 추적하지 않음)을 만든다.
- 타입 검사는 저장소마다 한 건으로 센다. 오류가 있으면 오류마다 실패 목록에 올린다.
- e2e 시험이 없는 저장소는 `test:e2e` 스크립트가 없는 것으로 판단하고 「없음」으로 적는다.

## 다시 뜨는 법

전제: 세 저장소가 main 커밋에 있고 추적 파일 변경이 없다(API 의 `deliverables/` · `docs/plans/` 는 예외). 각 저장소에서 `pnpm install --frozen-lockfile` 을 마쳤다.

일회용 DB 는 저장소 밖 임시 폴더에 띄운다. 공용 DB 주소를 쓰지 않는다.

```bash
mkdir -p "$TMPDIR/whale-test-pg" && cd "$TMPDIR/whale-test-pg"
npm init -y >/dev/null && npm i embedded-postgres pg
(umask 077; node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))" > dbpass)
cat > live.mjs <<'EOF'
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'fs';
const pg = new EmbeddedPostgres({ databaseDir: './live-data', user: 'postgres', password: fs.readFileSync('./dbpass', 'utf8').trim(), port: 55436, persistent: false });
await pg.initialise(); await pg.start();
await pg.createDatabase('live');
console.log('ready');
process.on('SIGTERM', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
EOF
node live.mjs &   # ready 가 찍힐 때까지 기다린다
export E2E_DATABASE_URL="postgresql://postgres:$(cat dbpass)@localhost:55436/live"
node -e "const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.E2E_DATABASE_URL});await c.connect();await c.query(\"ALTER DATABASE live SET timezone TO 'UTC'\");await c.end()})()"
```

그다음 `deliverables/` 에서 실행한다.

```bash
.venv/bin/python build_test_results.py --run --front <관리자 웹 저장소> --staff <직원 근무 앱 저장소>
.venv/bin/python build_test_results.py --version 1.0
```

`--run` 은 `prisma generate` 와 `prisma migrate deploy` 를 돌린 뒤 위 표를 모두 실행해 JSON 을 다시 쓴다. `E2E_DATABASE_URL` 이 localhost 가 아니면 멈춘다. 부모 환경을 물려주지 않고 메일 · 저장소 · 국세청 값은 넣지 않으며 알림톡은 `.invalid` 주소만 준다. 끝나면 `kill %1` 로 DB 를 끄고 `dbpass` 를 지운다.

## 결과 파일

- 커밋 해시, 실행일, 환경(Node 버전, 일회용 DB 여부, 시간대), 종류별 집계, 스위트별 집계, 실패 · 제외 목록만 저장한다. 테스트 전체 이름은 저장하지 않는다.
- 걸린 시간과 포트처럼 실행마다 달라지는 값은 저장하지 않는다. 같은 커밋에서 다시 돌려 비교할 수 있게 하려는 것이다.
- 쓰기 전에 절대경로, 실제 이메일, 휴대전화번호, 이번 실행의 비밀값이 들어 있는지 검사해 있으면 멈춘다.

## 시트

1. 요약: 저장소 · 종류 · 전체 · 통과 · 실패 · 건너뜀 · 실행일 · 기준 커밋 · 비고
2. 스위트별: 저장소 · 영역 · 스위트(파일) · 건수 · 통과 · 실패 · 건너뜀 · 비고
3. 실패 · 제외 목록: 구분 · 저장소 · 스위트 · 테스트 이름 · 사유 · 영향 · 처리 계획. 없으면 없다고 적는다.

- `afterAll` 처럼 테스트 밖에서 실패한 스위트는 테스트 수에 넣지 않고 비고와 실패 목록에 올린다.
- 알려진 실패 2건은 납품 문체의 사유를 쓴다. 스위트와 오류 모양이 함께 맞을 때만 쓰고 그 밖의 실패는 「원인 미분석」으로 낸다.
  - bp-code-groups: 시험 요청 본문에 필수 값 누락.
  - bp-profile: 시험 정리 순서로 외래키 위반.
  - 둘 다 제품 동작 영향 없음, 담당 영역에서 시험 수정.
- 건너뜀은 시험 위치의 코드에서 사유를 찾는다. 못 찾으면 「코드에서 사유를 찾지 못함」으로 적는다.
- 수동 · 통합 시험 기록은 근거 없이 넣지 않는다.

## 납품본 점검

표에 넣는 글에서 일감 · PR 번호, 목업 쟁점 번호, 팀 표시, 팀원 실명, 실제 이메일 · 휴대전화번호, 저장소 절대경로를 지운다. `common.INTERNAL` · `safe` · `strip_records` 와 `build_userflow.strip_issue` 를 다시 쓴다. 「운영 정책 …」 인용은 남긴다. 지운 뒤에도 남으면 생성을 멈춘다. `[\w./-]+\.ts` 는 스위트 파일 이름을 위해 점검에서 뺀다.

## 검증

- `test_build_test_results.py`: 작은 입력으로 집계와 정리를 확인하고 실제 JSON 과 문서의 숫자가 같은지, 내부 표지가 없는지 본다.
- `--run` 을 두 번 돌려 JSON 차이를 비교한다.
