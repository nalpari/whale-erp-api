import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';

/** 경로의 알림 ID. integer 범위 밖의 값은 DB 에 닿기 전에 404 로 끊는다(CLAUDE.md 「id 는 integer」). */
@Injectable()
export class NotificationIdPipe implements PipeTransform<string, number> {
  transform(raw: string): number {
    const id = /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
    if (!(id >= 1 && id <= 2147483647))
      throw new NotFoundException('알림을 찾을 수 없습니다');
    return id;
  }
}
