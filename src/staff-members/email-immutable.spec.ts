import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateContractDto } from '../contracts/dto/create-contract.dto';
import { RetirementDateDto } from './dto/retirement-date.dto';

// 이메일은 회원 ID 다 — 관리자 웹은 보이기만 하고 고치지 못한다(WHALEERP-180, ACC-17). 지금(2026-10-16) 관리자가
// 직원을 쓰는 요청은 근로계약 등록 · 수정(직원 레코드 칸)과 퇴직 처리 · 퇴직일 변경뿐이고, 어느 DTO 에도 email 이 없다.
// 그래서 email 을 보내면 무시되지 않고 400 이다. 이 둘에 email 칸이 생기면 여기서 깨진다 — 그때는 회원 ID 를 고치는
// 경로인지 먼저 정한다. 직원을 쓰는 관리자 요청을 새로 만들면 그 DTO 도 여기에 더한다.
// 파이프 옵션은 AppModule 의 전역 파이프 · 계약 multipart 파이프를 옮겨 적었다 — 그쪽을 바꾸면 여기도 맞춘다. 실제
// 파이프는 계약 · 퇴직 e2e 가 확인한다.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function messagesOf(metatype: new () => object, body: object) {
  try {
    await pipe.transform(body, { type: 'body', metatype });
  } catch (e) {
    if (e instanceof BadRequestException) {
      return (e.getResponse() as { message: string[] }).message;
    }
    throw e;
  }
  return [];
}

describe('직원 이메일(회원 ID)은 관리자 요청으로 고칠 수 없다', () => {
  it.each([
    ['근로계약 등록 · 수정', CreateContractDto],
    ['퇴직 처리 · 퇴직일 변경', RetirementDateDto],
  ])('%s 요청에 email 을 보내면 400', async (_, metatype) => {
    await expect(
      messagesOf(metatype, { email: 'changed@test.invalid' }),
    ).resolves.toContain('property email should not exist');
  });
});
