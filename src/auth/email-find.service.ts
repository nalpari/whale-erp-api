import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttemptState,
  CLEARED_ATTEMPT_STATE,
  isLocked,
  registerFailure,
} from './attempt-lock';
import { EmailFindTooManyRequestsResponseDto } from './dto/email-find.response.dto';
import { maskEmail } from './email-mask';
import { readJwtSecret } from './jwt-secret';
import { phoneKeyOf } from './phone-key';

// 이름 · 휴대전화번호 · 생년월일 가운데 어느 값이 틀렸는지 알리지 않는다.
const NOT_FOUND_MESSAGE = '일치하는 계정이 없습니다.';

const LOCKED_MESSAGE =
  '이메일 찾기가 잠시 막혔습니다. 잠시 뒤에 다시 시도하거나 근무지 점포에 직접 방문해 문의해 주세요.';

/** `EmailFindDto` 검증을 거친 값. 번호 형식이 다르면 잠금 키와 계정 조회가 함께 어긋난다. */
export interface EmailFindInput {
  name: string;
  /** 숫자 10~11자리 휴대전화번호(하이픈 · 공백을 지운 것). */
  phone: string;
  /** YYYY-MM-DD, 있는 날짜 */
  birthDate: string;
}

/**
 * 이름 비교용. 입력기에 따라 한글이 자모로 풀려(NFD) 오기도 해서 정규형을 맞춘다. 아니면 본인이 맞게 넣고도
 * 404 를 받고, 그 실패가 잠금 횟수에 쌓인다. 앞뒤 공백만 무시한다.
 */
function comparableName(name: string): string {
  return name.normalize('NFC').trim();
}

type Outcome =
  | { kind: 'found'; emails: string[] }
  | { kind: 'not_found' }
  | { kind: 'locked'; lockExpiresAt: Date };

/**
 * 이메일 찾기(WHALEERP-178). 넣은 이름 · 휴대전화번호 · 생년월일을 계정의 본인인증 값과 견주고,
 * 맞는 계정의 이메일을 가려서 목록으로 돌려준다. 찾은 이메일을 메일이나 문자로 보내지 않는다.
 *
 * 시도 제한은 계정이 아니라 넣은 휴대전화번호에 건다. 막으려는 것은 남의 번호를 알고 이름 ·
 * 생년월일을 맞혀 보는 것이라, 그 번호로 5번 틀리면 누가 시도하든 5분 막는다(로그인 잠금과 같은
 * 규칙, `attempt-lock.ts`). 번호를 바꿔 가며 두드리는 것은 이 잠금으로 못 막고, 요청 제한의 IP 축이
 * 늦출 뿐이다(프록시 뒤에서는 모두가 한 IP 버킷이다 — `throttle.ts`).
 */
@Injectable()
export class EmailFindService {
  private readonly logger = new Logger(EmailFindService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = readJwtSecret(config.get<string>('JWT_SECRET'));
  }

  async find(input: EmailFindInput): Promise<string[]> {
    const phoneKey = phoneKeyOf(this.secret, input.phone);
    // 시도 기록은 트랜잭션 안에서 남기고, 거절은 트랜잭션 밖에서 던진다. 안에서 던지면 실패 기록도 되돌아간다.
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        // 같은 번호의 요청을 한 줄로 세운다. 시도 기록은 시도마다 한 행이라 잠글 행이 없다.
        // 세우지 않으면 병렬 요청이 같은 마지막 기록을 읽어 5회 제한을 넘길 수 있다.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phoneKey}))`;
        // 시각은 잠금을 잡은 뒤에 잡는다. 기다린 사이 풀린 잠금을 잠긴 것으로 보지 않게.
        const now = new Date();
        const last = await tx.emailFindAttempt.findFirst({
          where: { phoneKey },
          // 잠금 안에서 발급된 id 가 곧 처리 순서다. 시도 시각은 앱 서버 시계라 인스턴스끼리 어긋날 수 있다.
          orderBy: { emailFindAttemptId: 'desc' },
          select: { failedCount: true, lockExpiresAt: true },
        });
        const state: AttemptState = last ?? CLEARED_ATTEMPT_STATE;
        const record = (isSucceeded: boolean, next: AttemptState) =>
          tx.emailFindAttempt.create({
            data: {
              phoneKey,
              isSucceeded,
              failedCount: next.failedCount,
              lockExpiresAt: next.lockExpiresAt,
              attemptedAt: now,
            },
          });

        // 막힌 동안의 시도는 남기되 세지 않는다. 세면 남의 번호를 끝없이 막아 둘 수 있다.
        if (isLocked(state, now)) {
          await record(false, state);
          return { kind: 'locked', lockExpiresAt: state.lockExpiresAt };
        }

        const accounts = await tx.account.findMany({
          // 휴대전화번호는 고유하지 않다. 탈퇴 계정만 뺀다.
          where: { phone: input.phone, status: { not: 'WITHDRAWN' } },
          orderBy: { accountId: 'asc' },
          select: { email: true, realName: true, birthDate: true },
        });
        const name = comparableName(input.name);
        const matched = accounts.filter(
          (a) =>
            comparableName(a.realName) === name &&
            a.birthDate.toISOString().slice(0, 10) === input.birthDate,
        );
        if (matched.length > 0) {
          // 그 번호의 계정이 모두 맞았을 때만 실패 횟수를 지운다(2026-10-13 노영주, api #20 리뷰). 일부만 맞은 성공으로
          // 지우면, 같은 번호를 쓰는 가족처럼 내 계정을 맞혀 가며 남의 계정 이름 · 생년월일을 끝없이 대입할 수 있다.
          // 일부만 맞으면 찾은 것은 주되 실패로 세지도 지우지도 않는다. 번호에 계정이 하나면(대부분) 성공은 늘 지운다.
          const clears = matched.length === accounts.length;
          await record(true, clears ? CLEARED_ATTEMPT_STATE : state);
          return {
            kind: 'found',
            emails: matched.map((a) => maskEmail(a.email)),
          };
        }

        const next = registerFailure(state, now);
        await record(false, next);
        if (!isLocked(next, now)) return { kind: 'not_found' };
        // 이 실패로 5회를 채워 막혔다면 지금 알린다. 막힌 것은 남의 번호를 맞혀 보는 신호일 수 있어 로그로도
        // 남긴다 — 흔적이 시도 기록 표에만 있으면 아무도 보지 않는다. 번호 원문 대신 키 앞부분으로 가리킨다.
        this.logger.warn(
          `이메일 찾기 5회 실패로 번호를 막았다 phoneKey=${phoneKey.slice(0, 8)}`,
        );
        return { kind: 'locked', lockExpiresAt: next.lockExpiresAt };
      },
    );

    switch (outcome.kind) {
      case 'found':
        return outcome.emails;
      case 'not_found':
        throw new NotFoundException(NOT_FOUND_MESSAGE);
      case 'locked':
        // 앱이 남은 시간을 보이고 입력을 잠글 수 있게 해제 시각을 함께 준다.
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: LOCKED_MESSAGE,
            error: 'Too Many Requests',
            lockExpiresAt: outcome.lockExpiresAt,
          } satisfies EmailFindTooManyRequestsResponseDto,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      default: {
        // 결과가 늘었는데 여기를 빠뜨리면 컴파일이 깨진다. 조용히 429 로 떨어지지 않게.
        const unhandled: never = outcome;
        throw new Error(`처리하지 않은 결과: ${JSON.stringify(unhandled)}`);
      }
    }
  }
}
