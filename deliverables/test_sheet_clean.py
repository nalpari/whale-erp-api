"""엑셀 납품본 정리 자체 검사 — .venv/bin/python test_sheet_clean.py"""
import sheet_clean as S
from openpyxl import Workbook

# 상태 이름: 표준 이름으로 바꾸고 두 번 붙이지 않는다
for before, after in [("서명 대기로 바꾼다", "직원 서명 대기로 바꾼다"), ("직원 서명 대기로 바꾼다", "직원 서명 대기로 바꾼다"),
                      ("체결 완료 계약", "서명 완료 계약"), ("발송 대기로 둔다", "서명 요청 전으로 둔다"), ("발송 대기가 된다", "서명 요청 전이 된다"),
                      ("계약 상태를 거부로 변경한다", "계약 상태를 서명 거절로 변경한다"), ("거부·만료·종료 상태", "서명 거절·계약 기간 만료·계약 종료 상태"),
                      ("전에 계약이 거부·만료·종료돼도", "전에 계약이 서명 거절·계약 기간 만료·계약 종료돼도"), ("임시저장 계약", "작성 중 계약"),
                      ("수정 요청 상태", "직원 수정 요청 상태"), ("직원 수정 요청 상태", "직원 수정 요청 상태")]:
    assert S.states(before) == after, (before, S.states(before))
# 다른 뜻은 그대로 둔다
for same in ("위치정보 동의 거부", "소속 추가 확인 거절", "초대가 만료된다", "공지 임시저장 · 게시 · 비공개", "수정 요청 사유를 받는다", "날인하거나 거부하면"):
    assert S.states(same) == same, same

# 내부 표시: 괄호째 지우고 운영 정책 번호와 정상 괄호는 남긴다
assert S.clean_text("규칙이다(쟁점 ATT-11, 2026-10-20 재영).") == "규칙이다."
assert S.clean_text("맞춘다(HOME-2·WORK-4, 운영 정책 CTR-29).") == "맞춘다(운영 정책 CTR-29)."
assert S.clean_text("않는다(운영 정책 NTF-21, 목업 NOTIFY-11).") == "않는다(운영 정책 NTF-21)."
assert S.clean_text("일반 설명(필수)") == "일반 설명(필수)"
assert S.clean_text("둔다(HOME-2, 운영 정책 CTR-29).") == "둔다(운영 정책 CTR-29)."
assert S.clean_text("둔다(운영 정책 ATT-22 · HOME-1).") == "둔다(운영 정책 ATT-22)."

# 점검: 남으면 멈춘다. 추적 칸은 건너뛴다. 고칠 문장을 못 찾으면 멈춘다.
wb = Workbook()
wb.active.title = "표"
wb.active.append(["담당 3팀 정리", "WHALEERP-1"])
leaks, _ = S.sanitize(wb)
assert not leaks and wb.active["A1"].value == "담당 정리"


def stops(fn, *args):
    try:
        fn(*args)
    except SystemExit:
        return True
    return False


wb2 = Workbook()
wb2.active.append(["값"])
assert stops(S.sanitize, wb2, None, {"없는 문장": ""})
print("ok — 정리 규칙")
