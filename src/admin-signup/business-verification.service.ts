import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LIVE_STORE_STATUSES } from '../stores/store-format';
import {
  NtsBusinessClient,
  NtsUnavailableError,
  type BizIdentity,
} from '../nts/nts-business.client';

/** 진위확인 결과 토큰. typ 으로 가입 완료(signup) · 로그인(access) 토큰과 가른다 */
export type BizVerificationTokenPayload = BizIdentity & {
  typ: 'biz-verification';
};

const WITHDRAWN = 'WITHDRAWN';

export const DUPLICATE_BIZ_REGISTRATION_NUMBER =
  '이미 등록된 사업자등록번호입니다.';
const MISMATCH = '입력한 사업자정보가 국세청 정보와 일치하지 않습니다.';
const UNAVAILABLE =
  '국세청 확인이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.';
const EXPIRED = '사업자정보 인증이 만료되었습니다. 다시 인증해 주세요.';

/**
 * 사업자정보 인증(국세청 진위확인). 번호 중복을 먼저 보고(PL-OCJOFP), 국세청이 일치라고 하면 10분짜리
 * 토큰을 준다. 가입은 이 토큰에서만 사업자정보를 꺼내 저장한다 — 화면이 보낸 값을 믿지 않는다(S-RCJXIG).
 * 마이페이지의 재인증도 나중에 이 서비스를 쓴다(점포는 NtsBusinessClient 를 직접 쓴다).
 */
@Injectable()
export class BusinessVerificationService {
  private readonly logger = new Logger(BusinessVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: NtsBusinessClient,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 사용·미사용 상태인 다른 고객 BP 나 미운영·운영 점포가 이 번호를 쓰는지. 탈퇴·삭제한 BP 와 폐점·삭제한
   * 점포의 번호는 다시 쓸 수 있다(Manyfast S-CQGGZS). 점포 조건은 점포 등록(StoreManagementService
   * .isNumberTaken)과 같다 — 다르면 점포에서는 다시 쓰는 번호가 가입에서만 막힌다. 플랫폼 BP 는 bp_codes 부분
   * 고유 인덱스처럼 뺀다. 가입은 트랜잭션 안에서 한 번 더 부르려고 db 를 받는다.
   * excludeBpCodeId — 재인증(이미 그 번호를 쓰고 있는 자기 자신)을 중복으로 보지 않는다. 그 BP 소속 점포의
   * 번호도 BP 가 쓸 수 있어 점포 조건에서 뺀다(PL-OCJOFP). 마이페이지 BP 사업자정보 재인증(BpProfileService)만
   * 쓴다 — 가입은 BP 가 아직 없어 소속 점포도 없다.
   */
  async isBizRegistrationNumberTaken(
    bizRegistrationNumber: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    excludeBpCodeId?: number,
  ): Promise<boolean> {
    const [bp, store] = await Promise.all([
      db.bpCode.findFirst({
        where: {
          bizRegistrationNumber,
          isPlatform: false,
          isDeleted: false,
          accountStatusCode: { not: WITHDRAWN },
          ...(excludeBpCodeId !== undefined && {
            bpCodeId: { not: excludeBpCodeId },
          }),
        },
        select: { bpCodeId: true },
      }),
      db.storeBusinessProfile.findFirst({
        where: {
          bizRegistrationNumber,
          store: {
            isDeleted: false,
            storeStatusCode: { in: [...LIVE_STORE_STATUSES] },
            ...(excludeBpCodeId !== undefined && {
              bpCodeId: { not: excludeBpCodeId },
            }),
          },
        },
        select: { storeId: true },
      }),
    ]);
    return bp !== null || store !== null;
  }

  async verify(
    identity: BizIdentity,
    excludeBpCodeId?: number,
  ): Promise<string> {
    // 누가 쓰는지는 알리지 않는다 — 문구 하나로 막는다.
    if (
      await this.isBizRegistrationNumberTaken(
        identity.bizRegistrationNumber,
        this.prisma,
        excludeBpCodeId,
      )
    )
      throw new ConflictException(DUPLICATE_BIZ_REGISTRATION_NUMBER);

    let result: 'MATCH' | 'MISMATCH';
    try {
      result = await this.client.verify(identity);
    } catch (e) {
      if (!(e instanceof NtsUnavailableError)) throw e;
      // 대표자명 · 번호는 남기지 않는다 — 개인정보이고, 장애 추적에는 원인만 있으면 된다.
      this.logger.error(`nts verify UNAVAILABLE ${e.message}`);
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    if (result === 'MISMATCH') throw new UnprocessableEntityException(MISMATCH);

    const payload: BizVerificationTokenPayload = {
      typ: 'biz-verification',
      ...identity,
    };
    return this.jwt.signAsync(payload, { expiresIn: '10m' });
  }

  /** 받은 토큰을 푼다 — 가입과 마이페이지 BP 사업자정보 저장(BpProfileService.update)이 함께 쓴다.
   * 서명 · 만료 · 용도 중 하나라도 틀리면 다시 인증하라고 한다. 흔한 「시간
   * 지남(TokenExpiredError)」은 로그에 남기지 않는다 — 다른 실패(서명 불일치 등)는 비밀키 교체 같은
   * 배포 문제를 가리킬 수 있어 원인만 남긴다(토큰 안 값은 남기지 않는다, 코드 리뷰로 찾음, 2026-10-22). */
  async readToken(token: string): Promise<BizIdentity> {
    const payload = await this.jwt
      .verifyAsync<Partial<BizVerificationTokenPayload>>(token)
      .catch((e: unknown) => {
        const name = e instanceof Error ? e.name : 'unknown';
        if (name !== 'TokenExpiredError')
          this.logger.warn(`biz-verification token invalid: ${name}`);
        return null;
      });
    if (
      payload?.typ !== 'biz-verification' ||
      typeof payload.bizRegistrationNumber !== 'string' ||
      typeof payload.bizCeoName !== 'string' ||
      typeof payload.bizOpenDate !== 'string'
    )
      throw new BadRequestException(EXPIRED);
    const { bizRegistrationNumber, bizCeoName, bizOpenDate } = payload;
    return { bizRegistrationNumber, bizCeoName, bizOpenDate };
  }
}
