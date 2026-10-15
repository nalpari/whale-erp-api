import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { hashPassword } from '../auth/password';
import { readOptionalAdminWebUrl } from '../common/admin-web-url';
import { isProduction } from '../config/profile';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import { validateAdminPassword } from './admin-password-policy';
import {
  BusinessVerificationService,
  DUPLICATE_BIZ_REGISTRATION_NUMBER,
} from './business-verification.service';
import type { SignupResponseDto } from './dto/signup.response.dto';

export type SignupInput = {
  loginId: string;
  password: string;
  name: string;
  phone: string;
  email: string;
  tradeName: string;
  agreeTermsOfUse: boolean;
  agreePrivacy: boolean;
  /** 사업자정보 인증(선택)을 마쳤으면 그 토큰. 사업자정보는 이 토큰에서만 꺼낸다 */
  bizVerificationToken?: string;
};

/** 가입 완료 화면을 여는 토큰. typ 이 access 가 아니라 JwtAuthGuard 를 통과하지 못한다. */
export type SignupTokenPayload = { sub: number; typ: 'signup' };

// 공통코드 값. 1팀 초기 데이터(20261006000100_team1_initial_data)가 넣은 행이다.
const ACTIVE = 'ACTIVE';
const WITHDRAWN = 'WITHDRAWN';
const BP_MASTER = 'BM';
const PLATFORM_MASTER = 'PM';
const BP_MASTER_ROLE_CODE = 'BM000001';
const TERMS_OF_USE = 'TERMS_SERVICE';
const PRIVACY = 'PRIVACY_COLLECT';

const DUPLICATE_LOGIN_ID = '사용할 수 없는 아이디입니다.';
const DUPLICATE_EMAIL = '이미 등록된 이메일입니다.';

/**
 * BP 회원가입(manyfast F-JVTPSU). 한 번에 BP 와 그 BP 마스터 계정을 만든다 — 점포는 만들지 않는다.
 * 사업자정보 인증(국세청 진위확인)은 선택이다. 인증했으면 진위확인 토큰(BusinessVerificationService)을 받아
 * bp_codes 의 biz_registration_number · biz_ceo_name · biz_open_date · biz_verified_at 을 채운다.
 */
@Injectable()
export class AdminSignupService {
  private readonly logger = new Logger(AdminSignupService.name);
  private readonly webUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
    private readonly jwt: JwtService,
    private readonly verifications: BusinessVerificationService,
    config: ConfigService,
  ) {
    // 잘못된 값은 여기서 던져 기동을 멈춘다. 비었으면 null — 가입 메일만 건너뛴다(가입은 메일 없이도 끝난다).
    this.webUrl = readOptionalAdminWebUrl(
      config.get<string>('ADMIN_WEB_URL'),
      isProduction(),
    );
    // 운영에서 비어 있으면 기동은 하되 남긴다 — 가입자가 「메일이 안 온다」고 묻기 전에 배포 로그에서 알게.
    const missing = [
      !this.mail && 'MAIL_*',
      !this.webUrl && 'ADMIN_WEB_URL',
    ].filter(Boolean);
    if (isProduction() && missing.length > 0)
      this.logger.error(
        `${missing.join(', ')} 이 비어 있어 가입 메일을 보낼 수 없다`,
      );
  }

  /**
   * 아이디는 탈퇴·삭제한 계정의 것도 다시 내주지 않는다(admin_accounts_login_id_key). 대소문자는 가리지 않는다 —
   * 가입은 소문자로 저장하지만 플랫폼 관리자 등록은 대소문자를 그대로 두므로, 그대로 비교하면 `SeoJun01` 이 있어도
   * `seojun01` 을 내준다. 고유 인덱스는 대소문자를 가리므로 이 확인이 유일한 방어다.
   */
  async isLoginIdAvailable(loginId: string): Promise<boolean> {
    const row = await this.prisma.adminAccount.findFirst({
      where: { loginId: { equals: loginId, mode: 'insensitive' } },
      select: { adminAccountId: true },
    });
    return row === null;
  }

  /** 이메일은 삭제·탈퇴하지 않은 계정끼리만 고유하다 — 부분 고유 인덱스와 같은 조건이다. */
  async isEmailAvailable(email: string): Promise<boolean> {
    const row = await this.prisma.adminAccount.findFirst({
      where: { email, isDeleted: false, accountStatusCode: { not: WITHDRAWN } },
      select: { adminAccountId: true },
    });
    return row === null;
  }

  async signup(
    raw: SignupInput,
    clientAddress?: string,
  ): Promise<SignupResponseDto> {
    // DTO 가 이미 바꿔 오지만 서비스가 직접 불려도 같게 — 대문자 이메일은 admin_accounts_email_lower CHECK 에
    // 걸려 500 이 되고, 대문자 아이디는 관리자 웹 로그인이 기대하는 정규화를 깬다.
    const input: SignupInput = {
      ...raw,
      loginId: raw.loginId.trim().toLowerCase(),
      email: raw.email.trim().toLowerCase(),
      tradeName: raw.tradeName.trim(),
    };
    const passwordError = validateAdminPassword(input.password);
    if (passwordError) throw new BadRequestException(passwordError);
    if (!input.agreeTermsOfUse || !input.agreePrivacy)
      throw new BadRequestException('필수 약관에 모두 동의해 주세요.');

    await this.ensureAvailable(input);
    // 화면이 보낸 사업자정보는 받지 않는다 — 진위확인을 통과한 값만 토큰에 들어 있다.
    const biz = input.bizVerificationToken
      ? await this.verifications.readToken(input.bizVerificationToken)
      : null;
    const [termsOfUseVersionId, privacyVersionId] = await Promise.all([
      this.activeTermsVersionId(TERMS_OF_USE),
      this.activeTermsVersionId(PRIVACY),
    ]);
    const roleGroup = await this.prisma.roleGroup.findFirst({
      where: { roleCode: BP_MASTER_ROLE_CODE, isDeleted: false },
      select: { roleGroupId: true },
    });
    if (!roleGroup)
      throw new Error(`권한 그룹 ${BP_MASTER_ROLE_CODE} 이(가) 없습니다`);
    const passwordHash = await hashPassword(input.password);

    const now = new Date();
    let adminAccountId: number;
    try {
      adminAccountId = await this.prisma.$transaction(async (tx) => {
        const bpCode = await nextBpCode(tx);
        // 인증과 가입 사이에 다른 BP 가 같은 번호로 먼저 가입했을 수 있다. 채번 잠금(advisory lock) 뒤에
        // 다시 봐야 동시 가입 둘이 같은 번호로 함께 통과하지 못한다.
        if (
          biz &&
          (await this.verifications.isBizRegistrationNumberTaken(
            biz.bizRegistrationNumber,
            tx,
          ))
        )
          throw new ConflictException(DUPLICATE_BIZ_REGISTRATION_NUMBER);
        const { bpCodeId } = await tx.bpCode.create({
          data: {
            bpCode,
            isPlatform: false,
            accountStatusCode: ACTIVE,
            tradeName: input.tradeName,
            ...(biz && {
              bizRegistrationNumber: biz.bizRegistrationNumber,
              bizCeoName: biz.bizCeoName,
              bizOpenDate: new Date(`${biz.bizOpenDate}T00:00:00.000Z`),
              bizVerifiedAt: now,
            }),
          },
          select: { bpCodeId: true },
        });
        const account = await tx.adminAccount.create({
          data: {
            loginId: input.loginId,
            bpCodeId,
            name: input.name,
            passwordHash,
            phone: input.phone,
            email: input.email,
            roleTypeCode: BP_MASTER,
            roleGroupId: roleGroup.roleGroupId,
            termsOfUseVersionId,
            termsOfUseAgreedAt: now,
            privacyVersionId,
            privacyAgreedAt: now,
            termsAgreedAt: now,
            joinPathCode: 'SIGNUP',
            // BP 마스터는 늘 BP 전체 범위다(로그인 후 홈 · 공통정책 1).
            isAllStores: true,
            accountStatusCode: ACTIVE,
          },
          select: { adminAccountId: true },
        });
        await tx.termsAgreementLog.createMany({
          data: [termsOfUseVersionId, privacyVersionId].map(
            (termsVersionId) => ({
              adminAccountId: account.adminAccountId,
              termsVersionId,
              isAgreed: true,
              agreedAt: now,
              channel: 'SIGNUP' as const,
              clientAddress: clientAddress ?? null,
            }),
          ),
        });
        return account.adminAccountId;
      });
    } catch (e) {
      // 확인과 저장 사이에 다른 가입이 같은 아이디·이메일을 먼저 넣었다. 다시 보면 어느 쪽인지
      // 알 수 있다. 둘 다 비어 있으면 다른 고유 위반이므로 그대로 던진다.
      // 다시 확인하다 실패하면(DB 오류) 원래 위반을 던진다 — 재확인 오류가 원인을 덮지 않게.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        await this.ensureAvailable(input).catch((recheck: unknown) => {
          if (recheck instanceof ConflictException) throw recheck;
        });
      throw e;
    }

    // 응답을 메일에 묶지 않는다. Gmail 이 멈추면 기다림마다 30초씩 묶이고, 메일이 실패해도 가입은 완료다.
    // 안에서 모두 잡지만, 고치다 잡히지 않는 거부가 생겨도 프로세스가 내려가지 않게 여기서 한 번 더 잡는다.
    void this.sendSignupMails(adminAccountId, input).catch((reason: unknown) =>
      this.mailFailed(adminAccountId, reason),
    );

    const payload: SignupTokenPayload = { sub: adminAccountId, typ: 'signup' };
    return {
      signupToken: await this.jwt.signAsync(payload, { expiresIn: '10m' }),
      tradeName: input.tradeName,
      loginId: input.loginId,
      email: input.email,
    };
  }

  private async ensureAvailable(input: SignupInput): Promise<void> {
    const [loginIdAvailable, emailAvailable] = await Promise.all([
      this.isLoginIdAvailable(input.loginId),
      this.isEmailAvailable(input.email),
    ]);
    if (!loginIdAvailable) throw new ConflictException(DUPLICATE_LOGIN_ID);
    if (!emailAvailable) throw new ConflictException(DUPLICATE_EMAIL);
  }

  /** 지금 시행 중인 버전. 시행일이 지난 사용 중 버전 가운데 가장 늦게 시행한 것이다.
   * new Date() 대신 kstToday 를 쓴다 — 새 버전 시행일 0~9시(KST)에는 UTC 날짜가 아직
   * 전날이라, new Date() 를 그대로 비교하면 가입 동의 기록에 전 버전이 찍힌다(2026-10-12 코드리뷰). */
  private async activeTermsVersionId(termsTypeCode: string): Promise<number> {
    const row = await this.prisma.termsVersion.findFirst({
      where: {
        termsTypeCode,
        isActive: true,
        isDeleted: false,
        effectiveDate: { lte: kstToday() },
      },
      orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
      select: { termsVersionId: true },
    });
    if (!row)
      throw new Error(`사용 중인 약관 ${termsTypeCode} 이(가) 없습니다`);
    return row.termsVersionId;
  }

  /**
   * 어느 계정의 메일이 왜 실패했는지 남긴다. 문의 답변 메일과 같이 error 다.
   * SMTP 오류(code · responseCode 가 있다)는 응답에 받는 주소가 섞여 메시지를 빼고 코드만 남긴다 — 자세한 사유는
   * MailService 가 주소를 가려 로그와 mail_send_logs 에 남긴다. 그 전 단계 오류(템플릿 없음 · 꺼짐, 변수, 링크)는
   * mail_send_logs 에도 남지 않으므로 메시지까지 남긴다. 그 메시지에는 템플릿 코드 · 변수 이름과 가린 주소만 들어간다.
   */
  private mailFailed(adminAccountId: number, reason: unknown): void {
    const { name, code, responseCode } = (reason ?? {}) as {
      name?: unknown;
      code?: unknown;
      responseCode?: unknown;
    };
    const beforeSmtp =
      code === undefined &&
      responseCode === undefined &&
      reason instanceof Error;
    const message = beforeSmtp ? ` message=${reason.message}` : '';
    this.logger.error(
      `signup mail FAILED adminAccountId=${adminAccountId} error=${String(name)} code=${String(code)}${message}`,
    );
  }

  private async sendSignupMails(
    adminAccountId: number,
    input: SignupInput,
  ): Promise<void> {
    const { mail, webUrl } = this;
    if (!mail || !webUrl) {
      this.logger.warn(
        `signup mail SKIPPED ${!mail ? 'no MAIL_*' : 'no ADMIN_WEB_URL'} adminAccountId=${adminAccountId}`,
      );
      return;
    }
    const doneMail = mail
      .send({
        templateCode: 'EMAIL_SIGNUP_DONE',
        to: input.email,
        variables: {
          관리자이름: input.name,
          BP이름: input.tradeName,
          로그인아이디: input.loginId,
          링크: webUrl,
        },
        adminAccountId,
      })
      .catch((reason: unknown) => this.mailFailed(adminAccountId, reason));

    const alertMails = this.prisma.adminAccount
      .findMany({
        where: {
          roleTypeCode: PLATFORM_MASTER,
          isDeleted: false,
          accountStatusCode: ACTIVE,
          email: { not: null },
        },
        select: { adminAccountId: true, email: true },
      })
      .then((masters) => {
        if (masters.length === 0)
          this.logger.warn(
            `signup alert SKIPPED no active platform master adminAccountId=${adminAccountId}`,
          );
        return Promise.all(
          // 마스터마다 따로 잡아야 한 명이 실패해도 나머지가 가려지지 않는다
          // (2026-10-12 코드리뷰 — 전엔 allSettled 결과를 throw 로 하나만 넘겨, 여러 명이
          // 실패해도 로그는 한 줄만 남고 adminAccountId 도 새 BP 마스터 것으로 잘못 찍혔다).
          masters.map((master) =>
            mail
              .send({
                templateCode: 'EMAIL_SIGNUP_ALERT',
                to: master.email as string,
                variables: { BP이름: input.tradeName, 링크: webUrl },
                adminAccountId: master.adminAccountId,
              })
              .catch((reason: unknown) =>
                this.mailFailed(master.adminAccountId, reason),
              ),
          ),
        );
      })
      // 마스터 목록 조회 자체가 실패하면 보낼 대상이 없다 — 어느 마스터 탓도 아니므로
      // 새로 가입한 계정 기준으로 남긴다.
      .catch((reason: unknown) => this.mailFailed(adminAccountId, reason));

    await Promise.all([doneMail, alertMails]);
  }
}

/**
 * 다음 BP 코드. 트랜잭션 스코프 advisory lock 으로 채번을 한 줄로 세운다 — 잠그지 않으면 동시
 * 가입 둘이 같은 최댓값을 읽고 둘째가 bp_codes_bp_code_key 위반으로 500 이 된다. 삭제·탈퇴한
 * BP 의 코드도 다시 쓰지 않으므로 행을 거르지 않는다. BP000000(플랫폼)이 가장 작아 첫 고객 BP 는
 * BP000001 이다.
 */
async function nextBpCode(tx: Prisma.TransactionClient): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bp_codes.bp_code'))`;
  const last = await tx.bpCode.findFirst({
    orderBy: { bpCode: 'desc' },
    select: { bpCode: true },
  });
  const next = Number(last?.bpCode.slice(2) ?? 0) + 1;
  if (next > 999_999) throw new Error('BP 코드를 더 채번할 수 없습니다');
  return `BP${String(next).padStart(6, '0')}`;
}
