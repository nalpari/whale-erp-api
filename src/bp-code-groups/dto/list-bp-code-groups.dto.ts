import { ListCodeGroupsDto } from '../../code-groups/dto/list-code-groups.dto';

/**
 * BP 공통코드 그룹 목록 검색 — 플랫폼 공통코드 관리와 같은 조건(쪽 · 그룹 코드 · 그룹명). 대상 BP 는 쿼리가 아니라
 * X-Bp-Code-Id 헤더로 받는다(가드가 정한다).
 */
export class ListBpCodeGroupsDto extends ListCodeGroupsDto {}
