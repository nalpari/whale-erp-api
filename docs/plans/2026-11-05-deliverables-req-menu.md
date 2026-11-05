# 내부 납품 산출물: 1번 요구사항정의서 · 2번 메뉴구조도(엑셀)

근거: 2026-11-05 재영 「진행해」(기획 세션 header 전달). 템플릿 · 공통 코드는 테이블정의서(`2026-11-05-deliverables-table-definition.md`)와 같이 쓴다. 작성자는 인터플러그, 담당 팀 칸은 두지 않는다.

## 요구사항정의서 (WHALE-REQ, `build_requirements.py`)

- 원본은 Manyfast 「Whale Erp」 프로젝트의 스냅숏 `deliverables/sources/manyfast.json` 이다(커밋한다). PRD 는 싣지 않고 요구사항 → 기능 → 명세만 싣는다.
- Manyfast 는 읽기만 했다(read_project). 쓰기 도구는 부르지 않았다.
- 스냅숏 만드는 법
  - 스크립트는 MCP 를 직접 부르지 못한다. 그래서 Claude Code 서브 에이전트가 항목 하나씩 읽게 한다. 호출은 `field` + `itemIds: [ID 하나]` 이고, 응답이 잘리면 같은 pageSize 로 `nextCursor` 를 넘겨 `truncated: false` 까지 이어 읽는다.
  - 그 세션 · 에이전트 기록(jsonl)에서 `sources/manyfast_snapshot.py` 가 응답 원문을 꺼내 합친다. 모델이 본문을 옮겨 적지 않으므로 잘리거나 바뀌지 않는다.
    - 조각(fragment)은 offset 순으로 이어 JSON 으로 풀고, 항목마다 끝까지 읽은 마지막 사슬의 완성본을 쓴다. projectId 가 다른 호출은 건너뛴다.
    - 항목 수(`totalCounts`)는 같은 기록의 `read_project_meta` stats(totalRequirements · totalFeatures · totalSpecs)에서 꺼낸다. 없으면 스냅숏을 만들지 않고, 생성기도 `totalCounts` 가 없으면 멈춘다.
    - 기기 이름(`devices`)은 전체 읽기 응답의 PRD 기기 목록(prd.attribute.devices)에서 꺼낸다.
  - 프로젝트가 1분 남짓마다 바뀌어 전체 읽기(`read_project` 를 cursor 로 한 번에 끝까지)는 매번 중간에 `stale_cursor` 로 끊겼다. 그래서 항목별로 읽었다.
  - **한계:** 스냅숏은 그 세션의 기록에서 나오므로 다른 사람이 같은 파일을 재현할 수는 없다. 다시 만들 때는 같은 방법으로 새로 읽는다.
- 시트: 표지 · 개정 이력 · 요구사항 · 기능 · 명세 · 정책 표
  - 요구사항 설명 안의 정책 표는 Manyfast 원문이 HTML(`<table>`) 4건 · 마크다운(`|` 줄) 2건이다. 그대로 두면 셀에 태그가 보이므로 칸으로 풀어 「정책 표」 시트(요구사항 · 정책 구분 · 적용 대상 · 정책 기준)에 싣는다. 요구사항 칸으로 링크한다. 설명 칸에는 표 자리에 「(정책 표 n줄은 「정책 표」 시트)」를 남긴다(2026-11-05 재영 지적).
    - HTML 표의 `<p>` · `<br>` 는 칸 안 줄바꿈이 되고 `<p>` 밖 글자도 남는다. colspan 은 옆 칸, rowspan 은 아래 줄에 같은 값을 채운다. 두 꼴이 섞이면 본문에 나온 순서대로 싣는다.
  - 셀 값이 `=` 로 시작해도 수식이 아니라 글자로 저장한다(`common.py` 의 저장 단계. 다른 산출물에도 같이 적용된다).
  - 요구사항 칸: 이름 · 설명 · 수락 기준 · 1차/2차 · 상태 · 중요도 · Plane · ID. 수락 기준은 완료된 것에 「[완료]」를 붙인다.
  - 기능 · 명세 칸: 이름 · 상위 · 설명 · 근거 · 성공 기준 · 1차/2차 · 상태 · 중요도 · 사용 기기 · 상세 칸 9개(전제 조건 · 트리거 · 동작 · 결과 · 예외 · 표시 · 권한 · 규칙 · 데이터) · Plane · ID. 상위 칸은 상위 항목 이름이고, 그 줄로 링크한다.
  - 사용 기기는 항목의 devices 를 PRD 기기 이름(웹 · 직원 근무 앱)으로 바꿔 적는다. 역할(roles)은 PRD 에도 항목에도 값이 없어 칸을 두지 않는다.
  - 상세 칸의 applicability 가 `na` 면 「해당 없음」으로 적는다(지금 11칸).
  - 항목은 한글 이름으로 보이고 ID 는 맨 끝 칸에 둔다.
- 값은 Manyfast 에 있는 것만 옮긴다.
  - 상태는 progress, 중요도는 importance 를 한글로 바꿔 적는다.
  - 1차/2차는 Manyfast 에 칸이 없어, 이름에 「[1차]」 · 「[2차]」가 있을 때만 적는다. 지금은 0건이다.
  - Plane 칸은 본문에 적힌 WHALEERP-번호만 모아 적는다. 제목으로 짐작해 잇지 않는다. 「WHALEERP-261 · 321」 「WHALEERP-280·281·282」처럼 접두 없이 이어 쓴 번호도 같은 접두로 읽는다. 뒤에 붙은 날짜(「, 2026-10-28」)는 번호가 아니다.
- 추적용 문서라 API 명세의 내부 표지 제외 규칙은 쓰지 않는다. 예시 이메일 · 휴대전화번호만 example.com · 01012345678 로 바꿔 쓴다.
- 자체 검사(`test_build_requirements.py`)
  - Manyfast 항목 수(totalCounts) · 스냅숏 항목 수 · 시트 줄 수가 같은지 본다.
  - 이어 쓴 Plane 번호(작은 예 · 실제 「지원 현황 조회와 문의사항 등록」의 282~284)가 읽히는지, 「해당 없음」 칸 수가 na 칸 수와 같은지 본다.
  - 스냅숏의 본문 문자열(코드값 칸 제외)이 공백을 정규화한 뒤 어느 셀엔가 통째로 있는지 본다(잘림 없음). 정책 표는 푼 뒤의 글과 칸 값으로 본다.
  - 셀에 HTML 태그가 없는지, 「정책 표」 줄 수가 원문 표의 줄 수와 같은지 본다.
  - 문서 안 이메일 도메인이 example.com 뿐인지 본다.

## 메뉴구조도 (WHALE-MENU, `build_menu_structure.py`)

- 「메뉴구조도 v0.9」 원본 파일은 로컬에 없어 DB 의 `menus` 테이블을 원본으로 쓴다. 1팀 초기 데이터와 3팀 마이그레이션이 채운 테이블이다.
- **읽은 곳: 일회용 로컬 Postgres(embedded-postgres)** 다. `prisma/migrations` 94개를 모두 `prisma migrate deploy` 로 적용한 뒤 SELECT 로만 읽었다. 공용 DB 는 쓰지 않았다.
  - 스냅숏은 `deliverables/sources/menus.json` 이고 커밋한다. 마지막 마이그레이션은 `20261104093700_team1_withdrawn_bp_sub_admins_inactive` 이다.
  - 1팀 메뉴 데이터는 읽기만 했다.
- 시트: 표지 · 개정 이력 · 메뉴 트리(전체) · 서비스별 시트(관리자 웹 - Whale ERP, 관리자 웹 - Whale ERP 플랫폼 관리)
  - 칸: 서비스 · 깊이 · 메뉴 이름(깊이만큼 들여 씀) · URL · 정렬 순서 · 사용 여부 · 삭제 여부 · 권한 단위(메뉴 코드) · 상위 메뉴
  - 순서: 서비스(공통코드 SERVICE 순서) → 같은 부모 안에서 정렬 순서로, 깊이 우선이다.
  - 권한: 권한 그룹마다 메뉴 코드 단위로 조회 · 등록 · 수정 · 삭제를 켠다(role_group_menus). 이 사실을 시트 머리에 적는다.
  - 메뉴 테이블의 서비스는 모두 관리자 웹 메뉴다. 직원 근무 앱 메뉴는 「DB 에 없음」이라고 시트 머리에 적는다.
- 자체 검사(`test_build_menu_structure.py`): 메뉴 테이블 행 수(스냅숏의 `menuCount`, `select count(*)`) · 스냅숏 행 수 · 「메뉴 트리」 시트 줄 수가 같은지 본다. 생성할 때도 다르면 멈춘다.
- 낡음 감지: 스냅숏의 `lastMigration` 이 저장소 `prisma/migrations` 의 마지막 폴더와 다르면 생성이 멈춘다. 마이그레이션이 늘면 스냅숏을 다시 만든다.
- `export_menus.cjs` 는 DATABASE_URL 을 반드시 받고, host 가 localhost · 127.0.0.1 이 아니면 멈춘다(셸에 남은 공용 · 개발 DB 주소로 붙지 않게).

## 실행

```bash
cd deliverables
.venv/bin/python build_requirements.py --version 1.0      # → out/WHALE-REQ-1.0_요구사항정의서.xlsx
.venv/bin/python build_menu_structure.py --version 1.0    # → out/WHALE-MENU-1.0_메뉴구조도.xlsx
.venv/bin/python test_build_requirements.py && .venv/bin/python test_build_menu_structure.py
```

스냅숏을 새로 만들 때:

메뉴 — 일회용 Postgres 를 작업 트리 밖 임시 폴더에서 띄운다. embedded-postgres 는 저장소 의존성이 아니라 그 폴더에만 설치하고, pg 는 저장소 의존성이라 따로 설치하지 않는다.

```bash
T=$(mktemp -d) && cd "$T" && npm init -y >/dev/null && npm i embedded-postgres@17.5.0-beta.15
export PGPORT=55435                                  # 비어 있는 포트를 고른다(lsof -i :<포트> 로 확인)
export PGPASS=$(openssl rand -hex 12)                # 비밀번호는 그때그때 만들고 어디에도 적지 않는다
node -e "const E=require('embedded-postgres').default;const p=new E({databaseDir:'./data',user:'postgres',password:process.env.PGPASS,port:+process.env.PGPORT,persistent:false});(async()=>{await p.initialise();await p.start();await p.createDatabase('menu');console.log('ready');process.on('SIGTERM',async()=>{await p.stop();process.exit(0)});setInterval(()=>{},1<<30)})()" &

cd <저장소 루트>
export DATABASE_URL=postgresql://postgres:$PGPASS@localhost:$PGPORT/menu
TZ=UTC npx prisma migrate deploy                                                   # 마이그레이션 전부
node deliverables/sources/export_menus.cjs deliverables/sources/menus.json          # SELECT 만 한다
kill %1                                                                             # 끝나면 내린다(데이터 폴더도 지워진다)
```

Manyfast — 세션에서 `read_project_meta` 한 번, 전체 읽기 첫 두 쪽(PRD 기기 목록), 서브 에이전트들의 항목별 `read_project` 를 부른 뒤 그 기록에서 꺼낸다.

```bash
P=~/.claude/projects/<프로젝트>/<세션>
python3 deliverables/sources/manyfast_snapshot.py deliverables/sources/manyfast.json $P.jsonl $P/subagents/agent-*.jsonl
```

## 하지 않는 것

- Manyfast 쓰기 · Plane 일감.
- 직원 근무 앱 메뉴를 지어내는 일.
