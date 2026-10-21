import { ValidateBy, type ValidationOptions } from 'class-validator';
import { isSendableEmail } from './mail-address';

/**
 * 메일을 보낼 수 있는 주소인지 — MailService 와 같은 `isSendableEmail` 이다. `@Matches(SENDABLE_EMAIL)` 로 걸면 안 된다:
 * 전역 ValidationPipe 에 stopAtFirstError 가 없어 `@MaxLength` 가 실패해도 정규식이 전체 문자열에 돌고, 이 정규식은
 * 끝이 맞지 않는 긴 입력에서 제곱으로 일한다(10만 자에 약 1.8초, 그동안 이벤트 루프가 멈춘다). 여기서는 길이를 먼저
 * 본다(api #87 리뷰).
 */
export function IsSendableEmail(
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isSendableEmail',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isSendableEmail(value),
      },
    },
    options,
  );
}
