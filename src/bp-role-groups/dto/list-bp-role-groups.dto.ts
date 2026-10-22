import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';

/** 대상 BP 는 쿼리가 아니라 X-Bp-Code-Id 헤더로 받는다(가드가 정한다). */
export class ListBpRoleGroupsDto extends PageDto {}
