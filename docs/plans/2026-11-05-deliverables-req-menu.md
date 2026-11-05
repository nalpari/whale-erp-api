# 내부 납품 산출물: 1번 요구사항정의서 · 2번 메뉴구조도(엑셀)

근거: 2026-11-05 재영 「진행해」(기획 세션 header 전달). 템플릿 · 공통 코드는 테이블정의서(`2026-11-05-deliverables-table-definition.md`)와 같이 쓴다. 작성자는 인터플러그, 담당 팀 칸은 두지 않는다.

## 요구사항정의서 (WHALE-REQ, `build_requirements.py`)

- 원본은 Manyfast 「Whale Erp」 프로젝트의 스냅숏 `deliverables/sources/manyfast.json` 이다(커밋한다). PRD 는 싣지 않고 요구사항 → 기능 → 명세만 싣는다.
- Manyfast 는 읽기만 했다(read_project). 쓰기 도구는 부르지 않았다.
- 스냅숏 만드는 법
  - 스크립트는 MCP 를 직접 부르지 못한다. 그래서 Claude Code 서브 에이전트가 항목 하나씩 읽게 한다. 호출은 `field` + `itemIds: [ID 하나]` 이고, 응답이 잘리면 같은 pageSize 로 `nextCursor` 를 넘겨 `truncated: false` 까지 이어 읽는다.
  - 그 에이전트 기록(jsonl)에서 `sources/manyfast_snapshot.py` 가 응답 원문을 꺼내 합친다. 모델이 본문을 옮겨 적지 않으므로 잘리거나 바뀌지 않는다. 조각(fragment)은 offset 순으로 이어 JSON 으로 푼다.
  - 프로젝트가 1분 남짓마다 바뀌어 전체 읽기(`read_project` 를 cursor 로 한 번에 끝까지)는 매번 중간에 `stale_cursor` 로 끊겼다. 그래서 항목별로 읽었다. 항목 수는 같은 날 전체 읽기 첫 응답의 totalCounts(요구사항 6 · 기능 17 · 명세 44)를 스냅숏의 `totalCounts` 에 적었다.
- 시트: 표지 · 개정 이력 · 요구사항 · 기능 · 명세
  - 요구사항 칸: 이름 · 설명 · 수락 기준 · 1차/2차 · 상태 · 중요도 · Plane · ID. 수락 기준은 완료된 것에 「[완료]」를 붙인다.
  - 기능 · 명세 칸: 이름 · 상위 · 설명 · 근거 · 성공 기준 · 1차/2차 · 상태 · 중요도 · 상세 칸 9개(전제 조건 · 트리거 · 동작 · 결과 · 예외 · 표시 · 권한 · 규칙 · 데이터) · Plane · ID. 상위 칸은 상위 항목 이름이고, 그 줄로 링크한다.
  - 항목은 한글 이름으로 보이고 ID 는 맨 끝 칸에 둔다.
- 값은 Manyfast 에 있는 것만 옮긴다.
  - 상태는 progress, 중요도는 importance 를 한글로 바꿔 적는다.
  - 1차/2차는 Manyfast 에 칸이 없어, 이름에 「[1차]」 · 「[2차]」가 있을 때만 적는다. 지금은 0건이다.
  - Plane 칸은 본문에 적힌 WHALEERP-번호만 모아 적는다. 제목으로 짐작해 잇지 않는다.
- 추적용 문서라 API 명세의 내부 표지 제외 규칙은 쓰지 않는다. 예시 이메일 · 휴대전화번호만 example.com · 01012345678 로 바꿔 쓴다.
- 자체 검사(`test_build_requirements.py`)
  - Manyfast 항목 수(totalCounts) · 스냅숏 항목 수 · 시트 줄 수가 같은지 본다.
  - 스냅숏의 본문 문자열(코드값 칸 제외)이 공백을 정규화한 뒤 어느 셀엔가 통째로 있는지 본다(잘림 없음).
  - 문서 안 이메일 도메인이 example.com 뿐인지 본다.

## 메뉴구조도 (WHALE-MENU, `build_menu_structure.py`)

- 「메뉴구조도 v0.9」 원본 파일은 로컬에 없어 DB 의 `menus` 테이블을 원본으로 쓴다. 1팀 초기 데이터와 3팀 마이그레이션이 채운 테이블이다.
- **읽은 곳: 일회용 로컬 Postgres(embedded-postgres)** 다. `prisma/migrations` 95개를 모두 `prisma migrate deploy` 로 적용한 뒤 SELECT 로만 읽었다. 공용 DB 는 쓰지 않았다.
  - 스냅숏은 `deliverables/sources/menus.json` 이고 커밋한다. 마지막 마이그레이션은 `20261104093700_team1_withdrawn_bp_sub_admins_inactive` 이다.
  - 1팀 메뉴 데이터는 읽기만 했다.
- 시트: 표지 · 개정 이력 · 메뉴 트리(전체) · 서비스별 시트(관리자 웹 - Whale ERP, 관리자 웹 - Whale ERP 플랫폼 관리)
  - 칸: 서비스 · 깊이 · 메뉴 이름(깊이만큼 들여 씀) · URL · 정렬 순서 · 사용 여부 · 삭제 여부 · 권한 단위(메뉴 코드) · 상위 메뉴
  - 순서: 서비스(공통코드 SERVICE 순서) → 같은 부모 안에서 정렬 순서로, 깊이 우선이다.
  - 권한: 권한 그룹마다 메뉴 코드 단위로 조회 · 등록 · 수정 · 삭제를 켠다(role_group_menus). 이 사실을 시트 머리에 적는다.
  - 메뉴 테이블의 서비스는 모두 관리자 웹 메뉴다. 직원 근무 앱 메뉴는 「DB 에 없음」이라고 시트 머리에 적는다.
- 자체 검사(`test_build_menu_structure.py`): 메뉴 테이블 행 수(스냅숏의 `menuCount`, `select count(*)`) · 스냅숏 행 수 · 「메뉴 트리」 시트 줄 수가 같은지 본다. 생성할 때도 다르면 멈춘다.

## 실행

```bash
cd deliverables
.venv/bin/python build_requirements.py --version 1.0      # → out/WHALE-REQ-1.0_요구사항정의서.xlsx
.venv/bin/python build_menu_structure.py --version 1.0    # → out/WHALE-MENU-1.0_메뉴구조도.xlsx
.venv/bin/python test_build_requirements.py && .venv/bin/python test_build_menu_structure.py
```

스냅숏을 새로 만들 때:

```bash
# 메뉴: 일회용 Postgres(npm embedded-postgres · pg 를 작업 트리 밖 임시 폴더에 설치)를 띄우고
DATABASE_URL=postgresql://postgres:<비번>@localhost:<포트>/<db> TZ=UTC npx prisma migrate deploy   # 저장소 루트
DATABASE_URL=… node deliverables/sources/export_menus.cjs deliverables/sources/menus.json             # pg 가 있는 곳의 NODE_PATH 로

# Manyfast: 서브 에이전트에게 항목별 read_project 를 시킨 뒤 그 기록에서 꺼낸다
python3 deliverables/sources/manyfast_snapshot.py deliverables/sources/manyfast.json <세션>/subagents/agent-*.jsonl
# 꺼낸 뒤 같은 날 전체 읽기 첫 응답의 totalCounts 를 스냅숏 totalCounts 에 적는다
```

## 하지 않는 것

- Manyfast 쓰기 · Plane 일감.
- 직원 근무 앱 메뉴를 지어내는 일.
