import type { EnumSource } from './enums.service';
import { ANSWER_STATUS_LABELS } from '../common/answer-status';
import { STAFF_JOIN_STATE_LABELS } from '../staff-members/join-state';
import {
  BUSINESS_VERIFICATION_RESULT_LABELS,
  OPERATION_REQUIREMENT_LABELS,
} from '../stores/store-format';

/**
 * DB 에 없는 API 전용 enum 의 한글. DB enum 은 db-enums.generated.ts(enum 타입 설명에서 생성)에 있고,
 * 같은 이름을 여기 두면 EnumsService 가 띄울 때 막는다.
 *
 * 값은 코드에 이미 있는 상수에서 가져온다. 값 목록을 여기 따로 적으면 둘이 어긋난다.
 */
export const API_ENUMS: EnumSource = {
  /** 직원 목록의 가입·인증 상태 (WHALEERP-329) */
  StaffJoinState: Object.entries(STAFF_JOIN_STATE_LABELS),
  /** 커뮤니티 관리 문의사항 · 도입문의 목록의 답변 상태 거르기 (WHALEERP-332) */
  InquiryAnswerStatus: Object.entries(ANSWER_STATUS_LABELS),
  /** 점포를 운영으로 바꾸는 데 모자란 것 — 점포 상세 · 전환 확인의 missingForOperation (MN000002) */
  StoreOperationRequirement: Object.entries(OPERATION_REQUIREMENT_LABELS),
  /** 저장 전 사업자 인증 결과 — POST /stores/business-verifications (MN000002) */
  StoreBusinessVerificationResult: Object.entries(
    BUSINESS_VERIFICATION_RESULT_LABELS,
  ),
};
