import { PickType } from '@nestjs/swagger';
import { CreateContractDto } from './create-contract.dto';

/**
 * 날인 전 근로자 정보 수정(WHALEERP-125 「본인 대조」 · 126). 발송 대기 · 서명 대기 · 수정 요청 계약의 이름 · 휴대전화번호 ·
 * 생년월일 · 성별 · 외국인 여부를 고친다. 칸 검사는 초안 저장과 같다 — 다섯 칸 모두 필수(외국인 여부는 빼면 내국인).
 * 번호를 바꿔 같은 점포의 진행 중 계약과 겹치면 409 CONTRACT_IN_PROGRESS 를 받고, 대체를 확인하면 replaceContractIds 로 다시 보낸다.
 */
export class UpdateWorkerDto extends PickType(CreateContractDto, [
  'name',
  'phone',
  'birthDate',
  'gender',
  'isForeigner',
  'replaceContractIds',
] as const) {}
