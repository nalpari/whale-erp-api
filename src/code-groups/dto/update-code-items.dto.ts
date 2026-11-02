import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
import { MAX_ITEM_ROWS } from '../code-format';
import { CodeItemInputDto } from './code-item-input.dto';

/** 고칠 상세 코드 한 행. 플랫폼 · BP 공통코드 관리가 함께 쓴다. */
export class UpdateCodeItemDto extends CodeItemInputDto {
  /** 목록에서 받은 그 행의 updatedAt 그대로. 그 사이 다른 관리자가 고쳤으면 요청 전체를 저장하지 않고 409. */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 상세 코드 수정 — 고른 그룹의 기존 상세 코드 여러 개를 한 번에 고친다. 삭제는 없다(사용 상태를 끈다). */
export class UpdateCodeItemsDto {
  /** 고칠 상세 코드. 1~500행. 한 요청 안에서 코드가 겹치면 409. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEM_ROWS)
  @ValidateNested({ each: true })
  @Type(() => UpdateCodeItemDto)
  items: UpdateCodeItemDto[];
}
