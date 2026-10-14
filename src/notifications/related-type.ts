/**
 * 운영 알림이 가리키는 업무(notifications.related_type). 화면은 이 값과 템플릿 코드로 갈 곳을 정한다.
 * 가입 연결 보류·소속 추가 확인 거절은 그 직원 레코드를 가리킨다.
 */
export const RELATED_TYPES = [
  'CONTRACT',
  'INQUIRY',
  'LEAD',
  'STAFF_MEMBER',
] as const;

export type RelatedType = (typeof RELATED_TYPES)[number];
