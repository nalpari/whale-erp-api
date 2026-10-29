import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';

/**
 * 경로의 contractId. integer 컬럼에 들어가는 1..2147483647 의 정수만 받는다. 범위를 넘는 값을 DB 에 보내면
 * Postgres 가 오류를 내 404 가 500 이 되므로 여기서 404 로 끊는다(CLAUDE.md 「id 는 integer」).
 */
@Injectable()
export class ContractIdPipe implements PipeTransform<string, number> {
  transform(raw: string): number {
    const id = /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
    if (!(id >= 1 && id <= 2147483647))
      throw new NotFoundException('근로계약을 찾을 수 없습니다.');
    return id;
  }
}
