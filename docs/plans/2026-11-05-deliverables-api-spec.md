# 내부 납품 산출물: 4번 API 명세(엑셀)

근거: 2026-11-05 재영 「진행해」(기획 세션 header 전달). 템플릿 · 공통 코드는 테이블정의서(`2026-11-05-deliverables-table-definition.md`)와 같이 쓴다.

## 정해진 것

- 스크립트는 `deliverables/build_api_spec.py`, 문서 번호는 `WHALE-API-<버전>`이다. 작성자는 `revisions.json` 에 적힌 「인터플러그」다.
- 원본은 두 가지다.
  - `openapi/openapi.json`: 경로 · 파라미터 · 본문 · 응답 · 오류 · 설명을 읽는다. 저장소의 `pnpm openapi:export` 가 만들고 nest swagger 플러그인(introspectComments)을 거친다. DB 에 붙지 않는다.
  - `src` 의 컨트롤러 · DTO 소스: 권한 데코레이터, 검증 데코레이터, 반환형을 읽는다.
  - 앱은 하나(`src/main.ts`)이고 전역 경로 접두어는 없다.
- 시트 구성: 표지 · 개정 이력 · API 목록 · 영역 시트들
  - API 목록 칸: 영역 · 메서드 · 경로 · 이름 · 권한. 경로를 누르면 그 API 의 상세로 간다.
  - 영역은 `src` 바로 아래 폴더(모듈)다. 영역마다 시트를 하나 둔다.
  - 영역 시트에는 API 마다 제목 · 권한 · 설명 줄을 두고, 그 아래 표를 둔다. 표 칸은 구분 · 이름 · 타입 · 필수 · 검증 규칙 · 설명이고, 구분은 path · query · header · 본문 · 응답 · 오류다.
  - 담당 팀 칸은 두지 않는다.
- 권한
  - `@Public` · `@UserTypes` · `@MenuPermission` · `@UseGuards` · `@AllowPasswordChangePending` 을 클래스 것, 메서드 것 순서로 원문 그대로 옮긴다.
  - `@Public()` 이 없으면 맨 앞에 「JwtAuthGuard(전역)」를 붙인다.
- 검증 규칙
  - DTO 의 데코레이터 원문을 옮긴다. `@Api*` · `@Type` · `@Transform` 은 빼고, 메시지는 남긴다.
  - 그 클래스에 속성이 없으면 `extends` 에 나오는 클래스에서 찾는다.
  - 소스에서 못 찾으면 openapi 의 제약을 쓴다(min · max · enum 등).
- 설명: 주석 · Swagger 데코레이터에서 온 openapi 의 summary · description 만 옮긴다. 없으면 비운다.
- 응답 형태
  - 스키마가 있으면 필드를 펼친다.
  - 스키마가 없으면 둘로 나눈다. 반환형이 `void` 이거나 204 면 「본문 없음」이고, 그 밖은 「코드에서 판정 불가」다.
- 오류: `@Api…Response` 로 적은 상태 코드와 설명만 담는다. 서비스가 그 밖에 던지는 오류는 담지 않는다. 이 사실은 API 목록 시트에 적어 둔다.
- 검증
  - 생성할 때 소스에서 찾은 라우트(operationId = 클래스_메서드)와 문서의 operation 이 하나라도 어긋나면 멈춘다.
  - `test_build_api_spec.py` 는 두 가지를 본다. 작은 컨트롤러 · DTO 로 렉서를 확인하고, 라우트 데코레이터를 줄 단위로 센 수와 엑셀 API 목록의 줄 수가 같은지 확인한다.

## 실행

```bash
pnpm openapi:export                                  # 저장소 루트. 문서를 코드와 맞춘다(바뀌면 따로 커밋)
cd deliverables
.venv/bin/python build_api_spec.py --version 1.0     # → out/WHALE-API-1.0_API 명세.xlsx
.venv/bin/python test_build_api_spec.py              # 자체 검사
```

## 하지 않는 것

- 서비스 코드를 따라가 오류를 모으는 일. 데코레이터로 적지 않은 오류는 담지 않는다.
- 응답 예시 값 칸. 요청에 없다.
