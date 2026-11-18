import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AttendanceStoresQueryDto } from './attendance-records.dto';

// ValidationPipe 처럼 바꾸고 검사한다. 걸린 칸 이름이 곧 400 이다.
const check = (plain: object) => {
  const dto = plainToInstance(AttendanceStoresQueryDto, plain);
  return { dto, failed: validateSync(dto).map((e) => e.property) };
};

describe('AttendanceStoresQueryDto (출퇴근 현황 점포 조건) — 점포 유형', () => {
  // 본사 점포(2026-11-17) — 점포 유형에 HQ(본사)가 더해졌다
  it('HQ 를 받는다 — 다른 유형과 섞어도', () => {
    expect(check({ storeTypes: 'HQ' })).toMatchObject({
      dto: { storeTypes: ['HQ'] },
      failed: [],
    });
    expect(check({ storeTypes: 'DIRECT,HQ' })).toMatchObject({
      dto: { storeTypes: ['DIRECT', 'HQ'] },
      failed: [],
    });
  });

  it('모르는 유형은 400', () =>
    expect(check({ storeTypes: 'BRANCH' }).failed).toEqual(['storeTypes']));
});
