import { AdminStoreDto } from '../../auth/dto/admin-login-info.response.dto';

export class BpStoreListResponseDto {
  /** 점포 이름순. 운영 상태와 상관없이 미삭제 점포 전체. 항목 모양은 로그인 정보의 `stores` 와 같다. */
  items: AdminStoreDto[];
  total: number;
}
