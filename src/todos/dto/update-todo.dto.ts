import { PartialType } from '@nestjs/swagger';
import { TodoFieldsDto } from './create-todo.dto';

/**
 * 제목 · 내용 · 수행 예정 일시 · 긴급 수정. 보낸 칸만 바꾸고, 내용 · 수행 시간은 null 이면 비운다. 배정 대상 · 수행
 * 방식 · 근무지 · 직원은 받지 않는다(모르는 칸이라 400). 그룹이면 그룹 전체에 같은 값을 쓴다.
 */
export class UpdateTodoDto extends PartialType(TodoFieldsDto) {}
