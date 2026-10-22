import type { EnumSource } from './enums.service';
import { ANSWER_STATUS_LABELS } from '../common/answer-status';
import { ROLE_GROUP_LOCK_REASON_LABELS } from '../platform-role-groups/platform-role-group-format';
import { MENU_BLOCK_REASON_LABELS } from '../platform-role-groups/role-menu-rules';
import { LOCATION_CONSENT_STATE_LABELS } from '../my-profile/location-consent-state';
import { STAFF_JOIN_STATE_LABELS } from '../staff-members/join-state';
import { HQ_SHARING_CONSENT_STATE_LABELS } from '../admin-scope/hq-sharing';
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
  /** 직원 상세의 본사 제공 동의 상태 — 가맹 점포 직원만 (WHALEERP-184) */
  HqSharingConsentState: Object.entries(HQ_SHARING_CONSENT_STATE_LABELS),
  /** 커뮤니티 관리 문의사항 · 도입문의 목록의 답변 상태 거르기 (WHALEERP-332) */
  InquiryAnswerStatus: Object.entries(ANSWER_STATUS_LABELS),
  /** 점포를 운영으로 바꾸는 데 모자란 것 — 점포 상세 · 전환 확인의 missingForOperation (MN000002) */
  StoreOperationRequirement: Object.entries(OPERATION_REQUIREMENT_LABELS),
  /** 저장 전 사업자 인증 결과 — POST /stores/business-verifications (MN000002) */
  StoreBusinessVerificationResult: Object.entries(
    BUSINESS_VERIFICATION_RESULT_LABELS,
  ),
  /** 메뉴 등록 팝업에서 칸을 바꿀 수 없는 이유 — GET /platform-role-groups/{id}/menus (MN000214) */
  PlatformRoleMenuBlockReason: Object.entries(MENU_BLOCK_REASON_LABELS),
  /** 플랫폼 권한 상세의 수정 · 삭제가 막힌 이유 — GET /platform-role-groups/{id} (MN000214) */
  PlatformRoleGroupLockReason: Object.entries(ROLE_GROUP_LOCK_REASON_LABELS),
  /** 직원 앱 내 정보의 위치정보 동의 상태 — GET /me/profile (WHALEERP-188) */
  LocationConsentState: Object.entries(LOCATION_CONSENT_STATE_LABELS),
};
