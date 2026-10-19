import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';
import { parseRouteId } from '../common/route-id';

/** 경로의 todoId. integer 범위(1..2147483647) 밖이면 DB 에 묻기 전에 404 다(CLAUDE.md 「id 는 integer」). */
@Injectable()
export class TodoIdPipe implements PipeTransform<string, number> {
  transform(raw: string): number {
    const id = parseRouteId(raw);
    if (id === null) throw new NotFoundException('TO-DO 를 찾을 수 없습니다');
    return id;
  }
}
