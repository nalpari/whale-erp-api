import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { UseStatus } from '@prisma/client';
import {
  CODE_PATTERN,
  INT4_MAX,
  PLATFORM_OWNER_CODES,
  type PlatformOwnerCode,
  toUpperCode,
  trimText,
} from '../code-format';

const CODE_MESSAGE =
  '그룹 코드는 영문 대문자·숫자·밑줄만 쓰고 영문으로 시작하며 20자 이내입니다';

/** 기존 그룹 수정. 그룹 코드는 대상을 가리킬 뿐 바뀌지 않는다 — 관리 주체도 받지 않는다. */
export class UpdateCodeGroupDto {
  /** 그룹 코드. 수정이면 대상을 가리킬 뿐 바뀌지 않는다. @example EMP_TYPE */
  @Transform(toUpperCode)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  groupCode: string;

  /** 그룹명. 앞뒤 공백을 지우고 1~50자. @example 고용 형태 */
  @Transform(trimText)
  @IsString()
  @Length(1, 50)
  groupName: string;

  /** 사용 상태. */
  @IsIn(Object.values(UseStatus))
  status: UseStatus;

  /** 표시 순서. 화면이 끌어 옮긴 뒤 1부터 다시 매긴 값. */
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  sortOrder: number;
}

/** 새 그룹. BP 적용 여부는 받지 않는다 — 늘 미적용으로 만든다. */
export class CreateCodeGroupDto extends UpdateCodeGroupDto {
  /** 관리 주체. 플랫폼고정 · 플랫폼제공만. 등록 뒤 바꾸지 않는다. */
  @IsIn(PLATFORM_OWNER_CODES)
  manageOwnerCode: PlatformOwnerCode;
}

/** 그룹 목록 패널 저장 — 행마다가 아니라 패널마다 한 번이다. 삭제는 없다(사용 상태를 끈다). */
export class SaveCodeGroupsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UpdateCodeGroupDto)
  updates: UpdateCodeGroupDto[];

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateCodeGroupDto)
  creates: CreateCodeGroupDto[];
}
