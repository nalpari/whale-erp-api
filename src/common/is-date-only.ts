import { ValidateBy } from 'class-validator';
import { parseDateOnly } from '../staff-members/kst-date';

/**
 * `YYYY-MM-DD` 이고 실제로 있는 날짜인지. 모양 검사와 달력 검사를 한 데코레이터에서 해야 400 응답이
 * 한 모양(ValidationPipe 의 배열 message)이 된다 — 둘을 나누면 2월 30일만 다른 모양으로 나간다.
 */
export function IsDateOnly(message: string): PropertyDecorator {
  return ValidateBy({
    name: 'isDateOnly',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && parseDateOnly(value) !== null,
      defaultMessage: () => message,
    },
  });
}
