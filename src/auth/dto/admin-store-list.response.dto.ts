import { AdminStoreDto } from './admin-login-info.response.dto';

export class AdminStoreListResponseDto {
  /** 관리 점포 — 로그인 정보의 `stores` 와 같은 항목 · 순서(점포 이름순). 플랫폼 계정은 빈 목록이다. */
  items: AdminStoreDto[];
  total: number;
}
