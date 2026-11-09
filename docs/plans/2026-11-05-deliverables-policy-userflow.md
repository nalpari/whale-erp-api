# 내부 납품 산출물: 운영 정책서 · 유저플로우(워드)

근거: 2026-11-05 재영 지시(기획 세션 header 전달). 템플릿 · 공통 코드는 테이블정의서(`2026-11-05-deliverables-table-definition.md`)와 같이 쓴다. 지금까지는 엑셀만 채웠고, 이번에 워드 템플릿(`templates/template.docx`)을 처음 채운다.

## 정해진 것

- 문서 번호는 `WHALE-POL-1.0`(운영 정책서) · `WHALE-FLOW-1.0`(유저플로우)이고, 작성자는 `revisions.json` 의 「인터플러그」다.
- 워드 채우기는 `common.py` 에 둔다.
  - `open_docx`: 표지 자리표시자(본문 · 표 · 머리글)와 개정 이력 표를 채운다.
  - `heading`: 제목 1~3.
  - `para`: 본문. 글자열 또는 (글, 굵게) 조각 목록을 받는다.
  - `table`: 「WHALE 표」, 첫 줄은 머리행.
  - `picture`: 그림.
  - `save_docx`: out/ 에 쓴다.
- 내부 표지 정규식(`INTERNAL`)과 예시 이메일 · 휴대전화번호 바꾸기(`safe`)는 `common.py` 로 옮겼다. API 명세 · 요구사항정의서는 거기서 가져다 쓰고, 동작은 그대로다.
- 결정 기록 괄호 지우기는 API 명세의 `strip_decisions` 로는 모자라 `common.py` 에 `strip_records` 를 따로 두었다.
  - `strip_decisions` 는 괄호를 「, 」로만 나눈다. 정책 문서에는 「2026-10-16 김민식 · 2026-10-19 재영」처럼 이름이 여럿인 조각과, 「WHALEERP-618 · 637 리뷰」처럼 일감이 든 조각이 많아 따로 만들었다.
  - API 명세는 `strip_decisions` 를 그대로 쓴다. 출력이 바뀌지 않게 하려는 것이다.

## 운영 정책서 (WHALE-POL, `build_policy.py`)

- **원본:** `whale-erp-v2/docs/raw/운영정책.html` 을 `deliverables/sources/운영정책.html` 로 그대로 복사한 스냅숏이다. 원본 파일은 고치지 않는다.
  - 운영 정책 아티팩트 **v271** 이고, 복사한 날은 **2026-11-09** 다.
  - 파일 안에는 버전 표기가 없다. v271 은 2026-11-09 지시(header 전달)에서 온 값이다. 그래서 생성기 상수로 두고 문서 첫머리에 적는다.
  - 개수: 규칙(div.rule) 220 · 장(h2) 16 · 소제목(h3) 6 · 표 1 · 출처(span.src) 206.
- **구성:** 원본의 장(h2) · 소제목(h3) 순서를 그대로 따른다.
  - 「근거」 장은 납품본에서 뺀다(2026-11-09 재영, PR #256 리뷰). 팀원 실명과 내부 논의가 담긴 장이다. 규칙은 없어 규칙 수는 그대로다.
  - 맨 앞에 「머리말」 장을 둔다. 원본 머리(masthead)의 기준 표시 · 소개 문단, 소제목 「8월 31일 판에서 바뀐 것」, 바닥 줄 기준 표시를 싣는다.
  - 원본 목차(nav)는 싣지 않는다. 워드의 제목 스타일이 그 역할을 한다.
  - 장 = 제목 1. 장 코드(ACC 등)와 이름을 함께 쓰고, 장 머리의 부제(span.sub)는 그 아래 본문으로 싣는다.
  - 장 안의 묶음 제목(div.gh) = 제목 2. 「아직 정해지지 않은 것」의 항목 제목(h3) = 제목 2.
  - 규칙 = 「규칙 번호(굵게) + 본문」 한 단락이다. 본문의 `<b>` 는 굵게 둔다.
  - 장 머리 · 끝의 설명 문단(p.intro · p.note · p)도 싣는다.
  - 상태 흐름(div.flow)은 「임시저장 → 발송 대기 → …」 한 단락, 1차 범위 제외 칩(chip)은 글머리 목록으로 싣는다.
  - 미정 항목의 상태 표시(tag)는 단락 앞에 「[노무]」처럼 굵게 남긴다.
  - 원본 표(권한 정책 역할 7종)는 워드 표로 푼다.
  - 링크(`<a>`)는 글자만 남긴다.
- **내부 기록 정리(API 명세와 같은 기준)**
  - `span.src` 출처 줄은 싣지 않는다.
  - 결정 기록 괄호는 괄호 조각만 지운다(`strip_records`).
    - 괄호 안을 「, 」 「 · 」 「 — 」 「. 」로 조각낸다.
    - 다음 조각을 지운다.
      - 날짜 · 사람 이름 · 내부 표지(`INTERNAL`) 가운데 하나가 들어 있고, 그것과 결정 낱말(제안 · 승인 · 정리 · 질문 · 리뷰 · 변경 등)을 빼면 아무것도 남지 않는 조각.
      - 일감 번호를 이어 쓴 숫자 조각(「WHALEERP-618 · 637 리뷰」의 「637 리뷰」).
      - 지운 조각 바로 뒤에서 「…을 바꿈」 「…바로잡음」처럼 바뀐 이력만 적은 조각.
    - 정책 번호 · 쟁점 번호(ATT-29 · 쟁점 ATT-11 등)와 법 조항이 든 조각은 남긴다. 「노무사 답변 2026-10-14 질문 17」처럼 외부 검토 근거도 남긴다.
    - 조각이 모두 지워지면 괄호째 지운다.
    - 날짜 · 이름이 없어도 결정 낱말뿐인 괄호 넷(`홈 PR 리뷰` · `구현 기준` · `구현 그대로` · `후속 일감`)은 지운다. 「(홈)」 같은 보통 괄호를 지우지 않게 낱말을 넓히지 않고 이 넷만 맞춘다.
  - 지운 조각 수를 생성 출력에 보인다.
  - 괄호 밖 문장 본문에 내부 표지가 있으면 그 표지만 지운다. 대상은 생성기의 `SENTENCE_FIXES` 에 원문 그대로 적는다. 원문에서 못 찾으면 생성이 멈춘다. 문장 자체가 결정 표시뿐이면 문장째 뺀다.
    - CTR-20 「셈법은 front #15 구현을 따른다」
    - CTR-13 · 26 문장째, CTR-24 · ATT-31 · PAY-04 표시만
    - 날짜뿐인 결정 표시 3곳: 근로계약 묶음 제목, 출퇴근 「GPS 판정으로 전면 교체」, 미정 장 집계 줄. 머리말의 「2026-10-19 기준」과 노무사 답변 날짜는 남긴다.
    - 팀 간 할 일 · 목업 언급은 문장째 뺀다: ATT-37 · RET-09 · PAY-03 · 미정 장 끝 문단 · ACC 장 소개의 팀 분담 설명.
    - 팀 표시만 뺀다: ACC-02 · 03 · 21, CTR-31, ATT-02, NTF-21, CNT-11 · 18, PRM-05.
  - 팀원 실명 · 팀 표시(1팀 · 3팀)가 본문이나 표 셀에 남으면 생성이 멈춘다(`common.TEAM_NAMES` · `common.TEAM`). 노무사 답변 괄호는 남긴다.
  - 머리말에는 「운영 정책 v269」와 복사일만 적는다. 저장소 경로와 정리 방식 설명은 싣지 않는다.
  - 지우면 뜻이 바뀌는 조각, 지우고 남은 괄호에 이름이 남은 것은 판단 목록으로 보고한다.
- **자체 검사(`test_build_policy.py`)**
  - 원본 규칙 수(220) = 문서 규칙 수, 원본 장 수(16) + 머리말 = 문서 제목 1 수.
  - 규칙 본문은 정리 규칙을 적용한 원문과 문서 글이 같다. 공백을 정규화해서 비교하며 잘린 것이 없어야 한다.
  - 작은 예로 `strip_records` 가 결정 기록만 지우고 정책 번호는 남기는지 본다.
  - 내부 표지 0건, 이메일 도메인은 example.com 뿐.

## 유저플로우 (WHALE-FLOW, `build_userflow.py`)

- **원본:** 두 저장소의 origin/main 이다. 체크아웃은 바꾸지 않고 `git show` 로 읽는다.
  - 관리자 웹: `whale-erp-front/docs/flow/*/`. 흐름 15개이고 1팀 화면 흐름도 들어 있다. 1팀 원본은 읽기만 한다.
  - 직원 근무 앱: `whale-erp-staff/docs/flow/*/`. 흐름 5개.
  - 흐름 폴더마다 `*.workflow.json` 과 `*.html` 만 `deliverables/sources/flow/{admin,staff}/<폴더>/` 로 스냅숏한다. 폴더 밖 `index.html` 과 `*.visual-check.*` 는 뺀다.
  - 원본 커밋 해시는 `deliverables/sources/flow/SOURCE.json` 에 적고 문서 첫머리에도 적는다.
  - 스냅숏은 `build_userflow.py --snapshot` 으로 다시 만든다(그 전에 각 저장소에서 `git fetch origin main`).
- **머리말:** 「원본 커밋」 표와 단계 표 칸 설명만 싣는다. 내부 파일 이름은 적지 않는다.
- **구성:** 장 = 클라이언트(관리자 웹 / 직원 근무 앱), 절 = 흐름(`meta.title`). 흐름 순서는 폴더 이름 순이다.
  - 흐름마다 그림 1장, 단계 표, 결정 목록(cards)을 싣는다.
- **단계 표 매핑:** header 는 「단계 · 화면 · 사용자 동작 · 시스템 처리 · 분기」를 요청했다. 그러나 workflow.json 에는 노드(lane · label · sublabel · type · col · tag) · 레인(label) · 구간(phases: label, fromCol~toCol) · 선(edges: from · to · label)뿐이다. 그래서 값을 지어내지 않고 다음처럼 옮긴다.

  | 문서 칸 | workflow.json 값 |
  |---|---|
  | 단계 | 순번(열 순서 → 같은 열 안에서는 선의 방향 → 순서가 없으면 레인 순서) |
  | 구간 | 노드의 col 이 fromCol~toCol 에 드는 phase 의 label. 없으면 비운다 |
  | 화면 · 주체 | 노드 lane 의 label |
  | 유형 | 노드 type 의 범례 이름(`meta.legend.entries[type].label`). 범례가 없으면 type 원문. header 의 「사용자 동작 / 시스템 처리」 구분은 이 칸으로 갈음한다 |
  | 내용 | label, 다음 줄에 sublabel. tag 가 있으면 「(ATT-3)」처럼 붙인다. 단, Manyfast ID 처럼 내부 표지인 tag 는 뺀다 |
  | 다음 · 분기 | 그 노드에서 나가는 edges. 한 줄에 하나씩 「→ 대상 label」을 적고, edge label 이 있으면 「(허용)」처럼 붙인다 |

  - 흐름마다 단계 수 = 원본 nodes 수다.
  - views(보기별 설명) · groups(묶음 표시) · mainPath 는 표에 싣지 않는다. 그림에 이미 그려져 있다.
- **결정 목록:** cards 의 제목을 굵게 두고, 그 아래 items 를 글머리 목록으로 싣는다. 내부 표지 · 결정 기록에는 정책서와 같은 정리 규칙(`strip_records`)을 적용한다. 흐름의 내부 표지는 모두 괄호 안(「(#272·#276)」 「(S-PTWREE)」 등)이라 괄호 밖 바꾸기는 두지 않았다. 남으면 생성이 멈춘다.
  - 노드 tag 가 Manyfast ID(관리자 웹 「공통」의 S-RCJXIG 등)면 내용 칸에 붙이지 않는다.
  - 미결 · 팀 간 메모는 싣지 않는다. 항목을 「 · 」로 나눈 조각에 `미정 · 보류 · 협의 · 법무 · 노무사 · 검토 · 확인 중 · 1팀 · 3팀 · 두 팀`이 있으면 조각째 뺀다(`미정산`은 제외). 카드에 남는 조각이 없으면 카드째 뺀다. 「직원 앱 약관 ③~⑥은 3팀 직원 근무 앱에서 받는다」는 「3팀」만 지운다. 조각 끝의 「(1팀 MYPAGE-3)」 같은 팀 표시는 괄호만 지운다. 「진입과 홈」의 「로그인·가입·계정 찾기는 1팀 화면이다 — 」는 앞부분만 지우고 뒤의 사실 설명을 남긴다.
- **쟁점 번호 제거(2026-11-09 재영):** 카드 · 단계 표 · 그림 라벨 · 노드 태그에서 목업 쟁점 번호(ATT-2, CONFIG-3 등)를 지운다. 사본은 고치지 않는다.
  - 「운영 정책 ATT-25」처럼 「운영 정책」을 붙인 번호는 남긴다.
  - 원문에 「운영 정책」 없이 적힌 운영 정책 번호(ACC-11 · CTR-19 · CTR-26)는 「운영 정책 」을 붙인다(`POLICY_CITES`). 납품본에 남는 번호는 이 형태만 통과한다.
  - 「(공통정책 1)」 같은 괄호는 괄호째 지운다.
  - 번호 형태가 글자나 그림에 남으면 생성이 멈춘다.
- **흐름 그림:** 흐름 HTML(archify 산출물)은 인라인 스크립트 · 인라인 SVG 로 그림을 그린다.
  - Playwright(Python) 의 헤드리스 Chromium 으로 1800×1200 뷰포트, 밝은 테마, 배율 2 로 연다. `meta.viewBox` 가 있으면 그 viewBox 를 가진 첫 `svg` 를, 없으면 첫 `svg` 를 잘라 PNG 로 찍는다.
  - `requirements.txt` 에 `playwright==1.58.0` 하나만 더한다. 이 판의 Chromium 리비전이 1208 이라 `~/Library/Caches/ms-playwright` 에 있는 chromium-1208 · chromium_headless_shell-1208 을 그대로 쓴다. 브라우저가 없으면 `.venv/bin/playwright install chromium` 을 쓴다.
  - 찍기 전에 그림 글자의 내부 메모를 고치거나 지운다(`FIGURE_FIXES`, 원본 스냅숏은 그대로). 표 칸의 같은 글자도 같이 고친다. 고친 뒤 그림에 남은 글자에 내부 표지 · 팀 표시 · 실명 · 날짜가 있으면 생성이 멈춘다.
  - PNG 는 `out/flow_png/` 에만 쓰고 커밋하지 않는다.
  - 그림 하나라도 못 찍으면 빈 칸을 두지 않고 생성을 멈춘다.
- **자체 검사(`test_build_userflow.py`)**
  - workflow.json 흐름 수(20) = 문서 절(제목 2) 수.
  - 흐름마다 단계 표 줄 수 = 원본 nodes 수.
  - 그림이 빠진 흐름이 0건이어야 한다(문서 그림 수 = 흐름 수).
  - 내부 표지 0건, 이메일 도메인은 example.com 뿐.

## 한계

- 흐름 원본(workflow.json)과 운영 정책 최신본이 다를 수 있다(예: 출퇴근 흐름의 「반경 밖 출근 불가」). 산출물은 원본을 그대로 옮기고 고치지 않는다.

## 실행

```bash
cd deliverables
uv pip install -p .venv/bin/python -r requirements.txt     # playwright 추가분
.venv/bin/python build_policy.py --version 1.0             # → out/WHALE-POL-1.0_운영 정책서.docx
.venv/bin/python build_userflow.py --version 1.0           # → out/WHALE-FLOW-1.0_유저플로우.docx
for t in test_*.py; do .venv/bin/python $t || break; done   # 기존 검사 포함 전부
```

스냅숏을 새로 만들 때:

```bash
cp ~/IdeaProjects/whale-erp-v2/docs/raw/운영정책.html deliverables/sources/운영정책.html   # 생성기의 버전 · 복사일 상수도 고친다
git -C ~/IdeaProjects/whale-erp-v2/whale-erp-front fetch origin main
git -C ~/IdeaProjects/whale-erp-v2/whale-erp-staff fetch origin main
.venv/bin/python build_userflow.py --snapshot                # sources/flow/ 와 SOURCE.json 을 다시 쓴다
```

## 하지 않는 것

- 원본(운영정책.html · 두 저장소의 흐름)을 고치는 일.
- workflow.json 에 없는 「사용자 동작 / 시스템 처리」 문장을 지어내는 일.
