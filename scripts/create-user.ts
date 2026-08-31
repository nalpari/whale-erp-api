/**
 * 로그인 계정 생성/비밀번호 변경.
 *
 *   pnpm user:create staff    admin@whale.test 관리자
 *   pnpm user:create customer buyer@whale.test 구매처
 *
 * 비밀번호는 인자로 받지 않는다. 인자로 받으면 셸 히스토리와 프로세스 목록
 * (ps), CI 로그에 평문으로 남는다. 터미널에서는 에코를 끄고 물어보고,
 * 파이프로 들어오면 표준 입력에서 읽는다.
 *
 *   echo 'pw12345!' | pnpm user:create staff admin@whale.test 관리자
 *
 * 회원가입 API 는 없다. 직원 계정은 운영자가, 고객 계정은 영업이 만든다는
 * 전제이므로, 공개 엔드포인트 대신 이 스크립트로 만든다.
 */
import { createInterface } from 'node:readline';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/auth/password';

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let piped = '';
    for await (const chunk of process.stdin) piped += chunk;
    return piped.replace(/\r?\n$/, '');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const answered = new Promise<string>((resolve) =>
      rl.question('비밀번호: ', resolve),
    );
    // 프롬프트는 이미 찍혔고, 이후의 되울림만 막는다. 입력이 화면에 남으면
    // 어깨너머로도 보이고 스크롤백에도 남는다.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
      () => {};
    const password = await answered;
    process.stdout.write('\n');
    return password;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [type, rawEmail, name] = process.argv.slice(2);
  if ((type !== 'staff' && type !== 'customer') || !rawEmail || !name) {
    console.error('사용법: pnpm user:create <staff|customer> <email> <name>');
    console.error('비밀번호는 실행 후 입력하거나 표준 입력으로 넘긴다.');
    process.exit(1);
  }

  const password = await readPassword();
  if (!password) {
    console.error('비밀번호가 비어 있습니다.');
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
