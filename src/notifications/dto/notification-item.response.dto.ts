import { ApiProperty } from '@nestjs/swagger';
import { RELATED_TYPES, type RelatedType } from '../related-type';

/** 운영 알림 한 줄. 받는 사람별 행이라 id 는 notification_recipient_id 다. */
export class NotificationItemDto {
  /** 알림 ID(받는 사람별). 읽음 · 삭제에 쓴다 */
  id: number;
  /** 만들 때 쓴 템플릿 코드(NTF_*) */
  templateCode: string;
  /** 구분 — 지금 템플릿 이름. 템플릿이 없으면 템플릿 코드 */
  kind: string;
  /** 제목 — 만들 때의 문구 */
  title: string;
  /** 둘째 줄 — 만들 때의 문구 */
  body: string;
  @ApiProperty({
    enum: RELATED_TYPES,
    enumName: 'NotificationRelatedType',
    nullable: true,
  })
  relatedType: RelatedType | null;
  relatedId: number | null;
  isRead: boolean;
  createdAt: Date;
}

export class NotificationListResponseDto {
  items: NotificationItemDto[];
  total: number;
  /** 미확인 건수 — 종 배지 */
  unreadCount: number;
}

export class NotificationReadAllResponseDto {
  /** 이번에 읽음으로 바뀐 건수 */
  updated: number;
}
