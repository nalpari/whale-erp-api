import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SaveInternalMemoDto } from './save-internal-memo.dto';

const updatedAt = '2026-10-14T01:02:03.456Z';
const errorsOf = async (body: object) =>
  (await validate(plainToInstance(SaveInternalMemoDto, body))).map(
    (e) => e.property,
  );

describe('SaveInternalMemoDto', () => {
  it('internalMemo 키를 빼먹으면 400 — 빠진 키로 메모가 지워지지 않게', async () => {
    expect(await errorsOf({ updatedAt })).toEqual(['internalMemo']);
  });

  it.each([null, '', '메모'])('internalMemo %p 는 받는다', async (memo) => {
    expect(await errorsOf({ internalMemo: memo, updatedAt })).toEqual([]);
  });
});
