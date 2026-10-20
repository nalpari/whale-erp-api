import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { MAX_ITEM_ROWS } from '../code-format';
import { CodeItemInputDto } from './code-item-input.dto';

/** 상세 코드 등록 — 고른 그룹에 새 상세 코드 여러 개를 한 번에 만든다. */
export class CreateCodeItemsDto {
  /** 만들 상세 코드. 1~500행. 한 요청 안에서 코드가 겹치면 409. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEM_ROWS)
  @ValidateNested({ each: true })
  @Type(() => CodeItemInputDto)
  items: CodeItemInputDto[];
}
