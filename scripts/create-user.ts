/**
 * 로그인 계정 생성/비밀번호 변경.
 *
 *   pnpm user:create staff    admin@whale.test 'pw12345!' 관리자
 *   pnpm user:create customer buyer@whale.test 'pw12345!' 구매처
 *
 * 회원가입 API 는 없다. 직원 계정은 운영자가, 고객 계정은 영업이 만든다는
 * 전제이므로, 공개 엔드포인트 대신 이 스크립트로 만든다.
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/auth/password';

async function main(): Promise<void> {
  const [type, rawEmail, password, name] = process.argv.slice(2);
  if (
    (type !== 'staff' && type !== 'customer') ||
    !rawEmail ||
    !password ||
    !name
  ) {
    console.error(
      '사용법: pnpm user:create <staff|customer> <email> <password> <name>',
    );
    process.exit(1);
  }

  // DB 의 CHECK 제약이 소문자 이메일만 받는다. 여기서 맞춰 넣는다.
  const email = rawEmail.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  const prisma = new PrismaService();
  try {
    const args = {
      where: { email },
      create: { email, name, passwordHash },
      // 이미 있으면 비밀번호를 갈아 끼운다. 기존 세션은 끊는다.
      update: { name, passwordHash, refreshTokenHash: null },
    };
    const user =
      type === 'staff'
        ? await prisma.staff.upsert(args)
        : await prisma.customer.upsert(args);

    console.log(`${type} #${user.id} ${user.email} 준비 완료`);
  } finally {
    // 실패해도 커넥션은 닫는다. 닫지 않으면 프로세스가 죽을 때까지
    // 서버 쪽 커넥션이 남는다.
    await prisma.$disconnect();
  }
}

// void 로 던지면 실패가 미처리 rejection 스택으로 튀고 종료 코드도 0 이다.
// CHECK 제약 위반 같은 흔한 실수를 운영자가 읽을 수 있게 만든다.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
