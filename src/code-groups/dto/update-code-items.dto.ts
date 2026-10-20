import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { MAX_ITEM_ROWS } from '../code-format';
import { CodeItemInputDto } from './code-item-input.dto';

/** 상세 코드 수정 — 고른 그룹의 기존 상세 코드 여러 개를 한 번에 고친다. 삭제는 없다(사용 상태를 끈다). */
export class UpdateCodeItemsDto {
  /** 고칠 상세 코드. 1~500행. 한 요청 안에서 코드가 겹치면 409. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEM_ROWS)
  @ValidateNested({ each: true })
  @Type(() => CodeItemInputDto)
  items: CodeItemInputDto[];
}
