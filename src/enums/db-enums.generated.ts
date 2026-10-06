// docs/erd-physical/_build_enum_labels.py 가 _model.py 에서 만든다. 손으로 고치지 말 것.
import type { EnumSource } from './enums.service';

export const DB_ENUMS: EnumSource = {
  AccountChangeChannel: [
    ['SELF', '본인'],
    ['PIN_RESET', '핀 재설정'],
    ['ADMIN_RESET', '관리자 초기화'],
  ],
  AccountChangeField: [
    ['PHONE', '휴대전화번호'],
    ['EMAIL', '이메일'],
    ['ADDRESS', '주소'],
    ['PASSWORD', '비밀번호'],
  ],
  AccountLoginFailureReason: [
    ['PASSWORD_MISMATCH', '불일치'],
    ['ACCOUNT_NOT_FOUND', '없는 계정'],
    ['LOCKED', '잠금'],
  ],
  AccountStatus: [
    ['JOINED', '가입 완료'],
    ['LINK_HOLD', '연결 보류'],
  ],
  AttendanceEntryMethod: [
    ['SELF', '직원 등록'],
    ['PROXY', '대신 등록'],
  ],
  AttendanceKind: [
    ['CHECK_IN', '출근'],
    ['CHECK_OUT', '퇴근'],
  ],
  AttendanceReviewReason: [
    ['ACCURACY_EXCEEDED', '위치 오차 초과'],
    ['OUT_OF_RADIUS_CHECKOUT', '반경 밖 퇴근'],
    ['MOCK_LOCATION', '위치 조작 감지'],
  ],
  ContractDocumentKind: [
    ['SENT_ORIGINAL', '발송 원본'],
    ['SIGNED_COPY', '날인 완료본'],
    ['PAPER_EMPLOYMENT_CONTRACT', '종이 계약 근로계약서'],
    ['WAGE_CONTRACT', '임금계약서'],
  ],
  ContractDraftAction: [
    ['SIGNUP_INVITE', '가입 초대'],
    ['AFFILIATION_CONFIRM', '소속 추가 확인'],
    ['RETURN_CONFIRM', '복귀 확인'],
    ['IMMEDIATE_SEND', '즉시 발송'],
  ],
  ContractMethod: [
    ['ELECTRONIC', '전자계약'],
    ['PAPER', '종이 계약'],
  ],
  ContractStatus: [
    ['PENDING_SEND', '발송 대기'],
    ['PENDING_SIGNATURE', '서명 대기'],
    ['SIGNED', '체결 완료'],
    ['REJECTED', '거부'],
    ['EXPIRED', '만료'],
    ['ENDED', '종료'],
  ],
  DispatchResult: [
    ['SUCCEEDED', '성공'],
    ['FAILED', '실패'],
  ],
  EmploymentStatus: [
    ['EMPLOYED', '재직'],
    ['RETIRED', '퇴직'],
  ],
  EmploymentType: [
    ['FULL_TIME', '정직원'],
    ['PART_TIME', '파트타이머'],
  ],
  IdentityVerificationPurpose: [
    ['SIGNUP', '가입'],
    ['PHONE_CHANGE', '휴대전화번호 변경'],
  ],
  IdentityVerificationResult: [
    ['SUCCEEDED', '성공'],
    ['FAILED', '실패'],
  ],
  InquiryStatus: [
    ['RECEIVED', '접수'],
    ['IN_PROGRESS', '처리중'],
    ['ANSWERED', '답변완료'],
  ],
  InvitationChannel: [
    ['SMS', 'SMS'],
    ['ALIMTALK', '알림톡'],
  ],
  InvitationStatus: [
    ['SENT', '발송'],
    ['ACCEPTED', '수락'],
    ['EXPIRED', '만료'],
    ['REJECTED', '거절'],
    ['REJECTED_UNDER_AGE', '가입 불가(만 19세 미만)'],
  ],
  InvitationType: [
    ['SIGNUP', '가입 초대'],
    ['REINVITE', '재초대'],
    ['AFFILIATION_CONFIRM', '소속 추가 확인'],
    ['RETURN_CONFIRM', '복귀 확인'],
  ],
  LeadInterest: [
    ['STORE_OPERATION', '매장운영'],
    ['FINANCE', '재무관리'],
    ['FRANCHISE', '프랜차이즈'],
    ['OTHER', '기타'],
  ],
  LinkHoldMismatchReason: [
    ['PHONE_MISMATCH', '번호 불일치'],
    ['NAME_MISMATCH', '이름 불일치'],
  ],
  LinkHoldResolution: [
    ['APPROVED', '승인'],
    ['REINVITED', '번호 수정 후 재초대'],
  ],
  LocationAccessAction: [
    ['COLLECT', '수집'],
    ['USE', '이용'],
    ['PROVIDE', '제공'],
  ],
  NoticeType: [
    ['MAINTENANCE', '점검'],
    ['FEATURE', '기능'],
    ['TERMS', '약관'],
    ['GENERAL', '안내'],
  ],
  NotificationChannel: [
    ['PUSH', '앱 푸시'],
    ['ALIMTALK', '알림톡'],
    ['EMAIL', '이메일'],
  ],
  NotificationTarget: [
    ['ADMIN', '운영 알림'],
    ['STAFF', '직원 알림'],
  ],
  PayslipDispatchChannel: [
    ['EMAIL', '이메일'],
    ['PUSH', '앱 푸시'],
  ],
  PayslipItemCategory: [
    ['EARNING', '지급'],
    ['DEDUCTION', '공제'],
  ],
  PayslipLogType: [
    ['DRAFT', '초안 생성'],
    ['EDIT', '수정'],
    ['CONFIRM', '확정'],
    ['CANCEL_CONFIRMATION', '확정 취소'],
    ['SEND', '발송'],
  ],
  PayslipReviewReason: [
    ['MISSING_ATTENDANCE', '출퇴근 누락'],
    ['AFTER_CONTRACT_END', '계약 만료 후 기록'],
    ['CONTRACT_CHANGED', '기간 중 계약 변경'],
    ['DEDUCTION_MISSING', '공제 미입력'],
  ],
  PayslipStatus: [
    ['DRAFTING', '작성 중'],
    ['REVIEWING', '검토 중'],
    ['CONFIRMED', '확정'],
    ['SENT', '발송 완료'],
  ],
  PostAudienceType: [
    ['GUEST', '비회원'],
    ['MEMBER', '회원'],
    ['BP', 'BP'],
    ['STORE', '점포'],
    ['ADDON', '부가서비스'],
  ],
  PostContentType: [
    ['NOTICE', '공지사항'],
    ['FAQ', 'FAQ'],
  ],
  PostStatus: [
    ['DRAFT', '임시저장'],
    ['PUBLISHED', '게시'],
    ['PRIVATE', '비공개'],
  ],
  StaffMemberJoinStatus: [
    ['DRAFT', '초안'],
    ['INVITED', '초대 발송'],
    ['JOINED', '가입 완료'],
  ],
  StatusChangeActor: [
    ['ADMIN', '관리자'],
    ['STAFF', '직원'],
    ['SYSTEM', '시스템'],
  ],
  TodoAssigneeType: [
    ['INDIVIDUAL', '개인'],
    ['ALL', '근무지 전체'],
  ],
  TodoExecutionMode: [
    ['EACH', '각자 수행'],
    ['ANY_ONE', '한 명 수행'],
  ],
  TodoStatus: [
    ['PENDING', '대기'],
    ['IN_PROGRESS', '진행 중'],
    ['DONE', '완료'],
  ],
  Weekday: [
    ['MON', '월'],
    ['TUE', '화'],
    ['WED', '수'],
    ['THU', '목'],
    ['FRI', '금'],
    ['SAT', '토'],
    ['SUN', '일'],
  ],
  WorkScheduleChangeType: [
    ['CREATED', '등록'],
    ['UPDATED', '수정'],
    ['DELETED', '삭제'],
  ],
  WorkScheduleConfirmStatus: [
    ['UNCONFIRMED', '확정 전'],
    ['CONFIRMED', '확정'],
  ],
  WorkType: [
    ['OPEN', '오픈'],
    ['MIDDLE', '미들'],
    ['CLOSE', '마감'],
  ],
};
