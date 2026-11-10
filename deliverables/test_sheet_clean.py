"""엑셀 납품본 정리 자체 검사 — .venv/bin/python test_sheet_clean.py

기대값은 손으로 고정한다. clean_text 의 결과를 기대값으로 쓰면 오작동을 잡지 못한다(#266 리뷰).
"""
import sheet_clean as S
import build_api_spec as A
import build_requirements as R
import build_table_definition as T
from openpyxl import Workbook

# 상태 이름: 표준으로 바꾸고 두 번 붙이지 않는다
for before, after in [("서명 대기로 바꾼다", "직원 서명 대기로 바꾼다"), ("직원 서명 대기로 바꾼다", "직원 서명 대기로 바꾼다"),
                      ("체결 완료 계약", "서명 완료 계약"), ("계약을 발송 대기로 둔다", "계약을 서명 요청 전으로 둔다"), ("계약이 발송 대기가 된다", "계약이 서명 요청 전이 된다"),
                      ("계약 상태를 거부로 변경한다", "계약 상태를 서명 거절로 변경한다"), ("계약 거부·만료·종료 상태", "계약 서명 거절·계약 기간 만료·계약 종료 상태"),
                      ("계약이 거부·만료·종료돼도", "계약이 서명 거절·계약 기간 만료·계약 종료돼도"), ("임시저장 계약", "작성 중 계약"),
                      ("계약이 수정 요청 상태", "계약이 직원 수정 요청 상태"), ("계약이 직원 수정 요청 상태", "계약이 직원 수정 요청 상태"),
                      # 블로커 7: 혼합 나열
                      ("근로계약 상태값은 임시저장, 발송 대기, 서명 대기, 수정 요청, 체결 완료, 거부, 만료, 종료로 정의한다.",
                       "근로계약 상태값은 작성 중, 서명 요청 전, 직원 서명 대기, 직원 수정 요청, 서명 완료, 서명 거절, 계약 기간 만료, 계약 종료로 정의한다."),
                      ("서명 대기·수정 요청 계약", "직원 서명 대기·직원 수정 요청 계약"),
                      # 블로커 2: 이미 표준인 표기는 다시 바꾸지 않는다
                      ("계약이 서명 거절 · 계약 기간 만료 · 종료 · 수정 요청이면 그 일자", "계약이 서명 거절 · 계약 기간 만료 · 계약 종료 · 직원 수정 요청이면 그 일자")]:
    assert S.states(before) == after, (before, S.states(before))
# 다른 뜻은 그대로 둔다(블로커 1 · 3)
for same in ("위치정보 동의 거부", "소속 추가 확인 거절", "초대가 만료된다", "공지 임시저장 · 게시 · 비공개", "수정 요청 사유를 받는다",
             "날인하거나 거부하면", "세션은 1시간으로 밀린다. 만료 · 종료 · 미사용 계정이면 401.",
             "앱 푸시 줄은 발송 대기로만 남기며 계약서 발송은 알림톡이다", "출퇴근 등록이 거부된 경우 안내한다"):
    assert S.states(same) == same, same

# 내부 표시(블로커 5 · 6): 「쟁점」이 붙은 번호는 운영 정책 번호와 겹쳐도 지운다
for before, after in [("규칙이다(쟁점 ATT-11, 2026-10-20 재영).", "규칙이다."),
                      ("구성한다(쟁점 ATT-11, 운영 정책 ATT-04·ATT-19).", "구성한다(운영 정책 ATT-04·ATT-19)."),
                      ("맞춘다(HOME-2·WORK-4, 운영 정책 CTR-29).", "맞춘다(운영 정책 CTR-29)."),
                      ("않는다(운영 정책 NTF-21, 목업 NOTIFY-11).", "않는다(운영 정책 NTF-21)."),
                      ("둔다(운영 정책 ATT-22 · HOME-1).", "둔다(운영 정책 ATT-22)."), ("필수다(목업 contracts-new, 2026-10-08).", "필수다."),
                      ("없다(218 · ATT-19).", "없다."), ("한다(PR ②).", "한다."), ("이하(「한 번에」)", "이하(「한 번에」)"), ("일반 설명(필수)", "일반 설명(필수)"),
                      ("점포 테이블(1팀)에 없다", "점포 테이블에 없다")]:
    assert S.clean_text(before) == after, (before, S.clean_text(before))

# 팀 표시 문장(블로커 4): 낱말만 지우지 않는다. FIXES 없이는 남아서 멈추고, FIXES 로 문장이 된다
team = "웹 로그인 화면의 구성은 1팀 영역이며, 3팀은 그 화면에 초대 확인 탭을 두지 않는다는 것만 정한다"
assert S.left_in(S.clean_text(team))
assert S.clean_text(team, R.FIXES) == "웹 로그인 화면에는 초대 확인 탭을 두지 않는다"
assert S.clean_text("true 면 3팀이 위도·경도 기준으로", T.FIXES) == "true 면 위도·경도 기준으로"
assert S.clean_text("그 상황은 3팀이 정한다.", R.FIXES) == "그 상황은 별도로 정한다."
assert S.clean_text("3팀 출퇴근 위치 확인이 볼 자리다", A.FIXES) == "출퇴근 위치 확인이 볼 자리다"
# 재영 결정: 스키마에 남은 값은 지우지 않고 표시한다
assert S.clean_text("가입 완료·연결 보류·탈퇴", T.FIXES) == f"가입 완료·연결 보류({S.UNUSED})·탈퇴"

# 점검: 도구 이름 · 목업 · 숫자 일감 · 이중 치환은 남으면 잡고, HTTP 코드는 잡지 않는다
for bad in ("Manyfast", "MCP", "Plane", "목업", "(218 · 메모", "계약 기간 계약 기간 만료", "직원 직원 서명 대기", "쟁점"):
    assert S.left_in(bad), bad
for ok in ("응답 코드(200)", "최대(100)", "운영 정책 CTR-29", "WHALE-REQ-1.0"):
    assert not S.left_in(ok), ok


def stops(fn, *args):
    try:
        fn(*args)
    except SystemExit:
        return True
    return False


wb = Workbook()
wb.active.title = "표"
wb.active.append(["담당 3팀 정리", "WHALEERP-1"])
leaks, _ = S.sanitize(wb)
assert leaks and wb.active["B1"].value == ""
wb2 = Workbook()
wb2.active.append(["값"])
assert stops(S.sanitize, wb2, None, {"없는 문장": ""})
print("ok — 정리 규칙 · 고정 기대값 회귀")
