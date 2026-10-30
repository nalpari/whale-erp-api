import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
import { INT4_MAX, MAX_GROUP_ROWS } from '../code-format';
import { CodeGroupInputDto } from './code-group-input.dto';

/** 고칠 그룹 한 행. */
export class UpdateCodeGroupDto extends CodeGroupInputDto {
  /** 표시 순서. 화면이 끌어 옮긴 뒤 1부터 다시 매긴 값. */
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  sortOrder: number;

  /** 목록에서 받은 그 행의 updatedAt 그대로. 그 사이 다른 관리자가 고쳤으면 요청 전체를 저장하지 않고 409. */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 그룹 수정 — 기존 그룹 여러 개를 한 번에 고친다. 삭제는 없다(사용 상태를 끈다). */
export class UpdateCodeGroupsDto {
  /** 고칠 그룹. 1~200행. 한 요청 안에서 그룹 코드가 겹치면 409. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_ROWS)
  @ValidateNested({ each: true })
  @Type(() => UpdateCodeGroupDto)
  items: UpdateCodeGroupDto[];
}
