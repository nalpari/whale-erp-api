import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsInt, IsOptional, Max, Min } from 'class-validator';

const MAX_ID = 2_147_483_647;

/** `a=1&a=2` 와 `a=1,2` 를 같은 배열로 받고 숫자로 바꾼다(TO-DO 목록 ListTodosQueryDto 와 같다). */
const splitNumbers = ({ value }: { value: unknown }): unknown => {
  const parts = typeof value === 'string' ? value.split(',') : value;
  return Array.isArray(parts)
    ? parts.map((p: unknown) =>
        typeof p === 'string' && p !== '' ? Number(p) : p,
      )
    : parts;
};

/** 로그인 후 홈의 업무 범위 — front 범위 선택기가 점포 ID 로 풀어 보낸다 */
export class HomeQueryDto {
  /** 업무 범위의 점포. 여러 개는 `storeIds=1&storeIds=2` 와 쉼표 `storeIds=1,2` 중 하나로(섞으면 400), 1000개까지. 관리 범위 밖 ID 는 조용히 빠진다. 주지 않으면 관리 범위 전체 */
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_ID, { each: true })
  storeIds?: number[];
}
