import { randomInt } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { PlatformAdminMail } from '../platform-admins/platform-admin-mail';
import { PrismaService } from '../prisma/prisma.service';
import { CLEARED_ATTEMPT_STATE } from './attempt-lock';
import { AdminTemporaryPasswordDto } from './dto/admin-temporary-password.dto';
import { AdminTemporaryPasswordResponseDto } from './dto/admin-temporary-password.response.dto';
import { hashPassword } from './password';

const VALID_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 5;
export const TEMPORARY_PASSWORD_SENT_MESSAGE =
  '입력한 정보와 일치하는 계정이 있으면 임시 비밀번호를 메일로 보냈습니다';

/**
 * 임시 비밀번호 메일 수단 — `createPlatformAdminMail` 이 만든다. `MAIL_*` 와 `ADMIN_WEB_URL` 이 다 있어야 있고,
 * 하나라도 비면 null 이라 앱은 뜨고 발급은 메일 없이 같은 202 다(플랫폼 관리자 초기 비밀번호 메일과 같은 규칙, api #29).
 */
export const ADMIN_MAIL = Symbol('ADMIN_MAIL');

// 헷갈리는 글자(0·O·1·l·I)를 뺐다. 메일을 보고 손으로 옮겨 적는다.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*';

/** 12자. 비밀번호 정책(PL-QSBSYY: 영문 대문자 · 소문자 · 숫자 · 특수문자 각 1자 이상)을 채운다. */
export function generateTemporaryPassword(): string {
  const pick = (s: string) => s[randomInt(s.length)];
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [
    pick(UPPER),
    pick(LOWER),
    pick(DIGITS),
    pick(SYMBOLS),
    ...Array.from({ length: 8 }, () => pick(all)),
  ];
  // 정해 둔 앞 네 자리 순서가 드러나지 않게 섞는다(Fisher–Yates).
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * 비밀번호 찾기의 임시 비밀번호(front okf auth.md 「계정 찾기」). 이름·아이디·이메일이 모두 맞는 사용 중 계정에만
 * 보낸다. 메일을 먼저 보내고, 보내진 뒤에만 저장한다 — 메일이 나가지 않으면 임시 비밀번호도 활성화하지 않는다.
 *
 * 본인 비밀번호는 그대로 둔다(`password_hash` 를 '!' 로 바꾸지 않는다). 기억난 사람은 본인 비밀번호로
 * 들어오고, 그때 로그인이 쓰지 않은 임시 비밀번호와 강제 변경을 거둔다.
 */
@Injectable()
export class AdminTemporaryPasswordService {
  private readonly logger = new Logger(AdminTemporaryPasswordService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ADMIN_MAIL) private readonly sender: PlatformAdminMail,
  ) {}

  async issue(
    dto: AdminTemporaryPasswordDto,
  ): Promise<AdminTemporaryPasswordResponseDto> {
    const sent = { message: TEMPORARY_PASSWORD_SENT_MESSAGE };
    const matching = {
      loginId: dto.loginId,
      name: dto.name,
      email: dto.email,
      accountStatusCode: 'ACTIVE',
      isDeleted: false,
    };
    const account = await this.prisma.adminAccount.findFirst({
      where: matching,
      select: { adminAccountId: true, name: true, email: true },
    });
    // 계정이 있는지 드러내지 않는다.
    if (!account?.email) return sent;

    const since = new Date(Date.now() - VALID_MS);
    // shortcut: 1시간 5회는 행 잠금 밖에서 센다 — 메일 발송(1~2초) 사이 동시 요청이 몇 건 더 통과할 수 있다(계정 축 요청 제한이 상한, 마지막 비밀번호만 유효). 남용이 보이면 잠금 아래에서 다시 센다.
    const issuedLastHour = await this.prisma.temporaryPassword.count({
      where: {
        adminAccountId: account.adminAccountId,
        purpose: 'TEMPORARY',
        issuedAt: { gte: since },
      },
    });
    // 한도는 맞는 정보를 넣은 사람에게만 알린다. 이름·아이디·이메일을 모두 아는 사람에게는 계정 존재가 이미 드러나 있다.
    if (issuedLastHour >= MAX_PER_HOUR)
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `임시 비밀번호는 1시간에 ${MAX_PER_HOUR}번까지 받을 수 있습니다`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    // 메일을 못 보내면 아무것도 저장하지 않고 같은 202 로 답한다 — 503 이면 응답만으로 이름 · 아이디 · 이메일이
    // 맞았는지 드러난다. 받지 못한 사람은 다시 요청하고, 운영자는 이 경고로 안다.
    if (!this.sender) {
      this.logger.warn(
        `MAIL_* · ADMIN_WEB_URL 이 없어 임시 비밀번호를 보내지 못함 admin=${account.adminAccountId}`,
      );
      return sent;
    }
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);
    try {
      await this.sender.mail.send({
        templateCode: 'EMAIL_TEMP_PASSWORD',
        to: account.email,
        variables: {
          관리자이름: account.name ?? dto.loginId,
          임시비밀번호: password,
          링크: `${this.sender.webUrl}/login`,
        },
        maskedVariables: ['임시비밀번호'],
        adminAccountId: account.adminAccountId,
      });
    } catch (e) {
      this.logger.warn(
        `임시 비밀번호 메일 실패 admin=${account.adminAccountId}: ${(e as Error).message}`,
      );
      return sent;
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${account.adminAccountId} FOR UPDATE`;
      // 메일을 보내는 사이(최대 수십 초) 이메일이 바뀌었거나 계정이 막혔으면 저장하지 않는다 — 옛 주소로 간
      // 비밀번호가 1시간 살아 있게 된다. 메일은 이미 나갔지만 쓸 수 없는 값이다.
      const still = await tx.adminAccount.findFirst({
        where: { adminAccountId: account.adminAccountId, ...matching },
        select: { adminAccountId: true },
      });
      if (!still) {
        this.logger.warn(
          `임시 비밀번호 발송 중 계정이 바뀌어 저장하지 않음 admin=${account.adminAccountId}`,
        );
        return;
      }
      // 다시 받으면 앞의 찾기용 임시 비밀번호는 바로 끝난다. 만료 전까지 다시 쓸 수 있으므로 이미 쓴 것도 끝낸다.
      // 플랫폼 관리자가 준 초기 · 초기화 비밀번호는 둔다 — 공개 경로라, 그것으로 강제 변경 중인 세션을 남이 401 로
      // 만들 수 있다. 로그인은 가장 최근 것만 받으므로 그 값으로는 더 들어오지 못한다.
      await tx.temporaryPassword.updateMany({
        where: {
          adminAccountId: account.adminAccountId,
          purpose: 'TEMPORARY',
          invalidatedAt: null,
        },
        data: { invalidatedAt: now },
      });
      await tx.temporaryPassword.create({
        data: {
          adminAccountId: account.adminAccountId,
          passwordHash,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + VALID_MS),
          purpose: 'TEMPORARY',
        },
      });
      // 잠긴 계정도 받을 수 있고, 받으면 잠금이 풀린다. 강제 변경 표시는 여기서 켜지 않는다 — 로그인 없이 부르는
      // 경로라, 켜면 이름 · 아이디 · 이메일만 아는 사람이 로그인 중인 관리자의 세션을 모두 403 으로 묶는다.
      // 표시는 이 임시 비밀번호로 실제로 들어올 때 로그인이 켠다.
      await tx.adminAccount.update({
        where: { adminAccountId: account.adminAccountId },
        data: {
          failedLoginCount: CLEARED_ATTEMPT_STATE.failedCount,
          lockExpiresAt: CLEARED_ATTEMPT_STATE.lockExpiresAt,
        },
      });
    });
    return sent;
  }
}
