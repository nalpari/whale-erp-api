import { Injectable, PipeTransform } from '@nestjs/common';
import { parseRouteId } from '../common/route-id';
import { invitationNotFound } from './staff-signup.service';

/**
 * 경로의 invitationId. integer 범위(1..2147483647) 밖이면 DB 에 묻기 전에 없는 초대와 같은 404 다(CLAUDE.md Database 절 —
 * id 는 integer).
 */
@Injectable()
export class InvitationIdPipe implements PipeTransform<string, number> {
  transform(raw: string): number {
    const id = parseRouteId(raw);
    if (id === null) throw invitationNotFound();
    return id;
  }
}
