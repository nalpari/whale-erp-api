import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { MAX_GROUP_ROWS } from '../code-format';
import { CodeGroupInputDto } from './code-group-input.dto';

/** 그룹 수정 — 기존 그룹 여러 개를 한 번에 고친다. 삭제는 없다(사용 상태를 끈다). */
export class UpdateCodeGroupsDto {
  /** 고칠 그룹. 1~200행. 한 요청 안에서 그룹 코드가 겹치면 409. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_ROWS)
  @ValidateNested({ each: true })
  @Type(() => CodeGroupInputDto)
  items: CodeGroupInputDto[];
}
