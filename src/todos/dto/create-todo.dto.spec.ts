import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTodoDto } from './create-todo.dto';
import { UpdateTodoDto } from './update-todo.dto';

const base = {
  storeId: 3,
  title: '마감 정산표 확인',
  assigneeType: 'INDIVIDUAL',
  staffMemberIds: [11],
  dueDate: '2026-10-20',
};
const errorsOf = async (patch: Record<string, unknown>) =>
  (await validate(plainToInstance(CreateTodoDto, { ...base, ...patch }))).map(
    (e) => e.property,
  );

describe('CreateTodoDto', () => {
  it('맞는 입력은 통과한다', async () => {
    expect(await errorsOf({ dueTime: '23:59' })).toEqual([]);
  });

  it.each([
    ['공백만인 제목', { title: '   ' }, 'title'],
    ['같은 직원을 두 번', { staffMemberIds: [11, 11] }, 'staffMemberIds'],
    ['24시', { dueTime: '24:00' }, 'dueTime'],
    ['분 없는 시각', { dueTime: '9:00' }, 'dueTime'],
    [
      '201명',
      { staffMemberIds: Array.from({ length: 201 }, (_, i) => i + 1) },
      'staffMemberIds',
    ],
  ])('%s 은 400', async (_, patch, property) => {
    expect(await errorsOf(patch)).toContain(property);
  });

  it('200명까지는 받는다', async () => {
    expect(
      await errorsOf({
        staffMemberIds: Array.from({ length: 200 }, (_, i) => i + 1),
      }),
    ).toEqual([]);
  });

  it('내용은 앞뒤 공백을 지우고, 비면 null 이다(등록 · 수정)', () => {
    expect(
      plainToInstance(CreateTodoDto, { ...base, body: '  메모  ' }).body,
    ).toBe('메모');
    expect(plainToInstance(CreateTodoDto, { ...base, body: '   ' }).body).toBe(
      null,
    );
    expect(plainToInstance(UpdateTodoDto, { body: ' \n ' }).body).toBe(null);
  });
});
