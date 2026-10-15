import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PLATFORM_BP_CODE } from '../code-groups/code-format';
import { errorKind } from '../common/error-kind';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  deleteLeadNotifications,
  notifyLeadOperators,
} from './lead-notifications';
import { CreateLeadDto, INDUSTRY_OTHER } from './dto/create-lead.dto';

/** 같은 전화번호 · 이메일로 다시 접수할 수 있을 때까지 (Plane #295, 2026-10-12 재영). */
const REPEAT_WINDOW_MS = 10 * 60_000;

/**
 * 접수 확인 메일. 비로그인 접수라 주소가 확인되지 않았으므로 입력값 없는 고정 문구이고, 서비스 전체에서 시간당
 * 50건까지만 보낸다 — 넘으면 접수는 저장하고 메일만 건너뛴다(재영 결정 2026-10-15, api #50 리뷰).
 */
const CONFIRMATION_TEMPLATE = 'EMAIL_LEAD_CONFIRMATION';
const CONFIRMATION_HOURLY_LIMIT = 50;
const HOUR_MS = 60 * 60_000;

/**
 * 도입문의 (Plane #295). 고객지원 문의사항(`inquiries`)과 다른 유형으로 따로 관리한다.
 * 개인정보를 담으므로 상담 완료일로부터 1년 뒤 파기한다(운영 정책 CNT-12).
 *
 * 접수되면 플랫폼 운영자에게 운영 알림 `NTF_LEAD_RECEIVED` 를, 문의자에게 고정 문구의 접수 확인 메일
 * `EMAIL_LEAD_CONFIRMATION` 을 보낸다(#296). 둘은 서로의 실패에 묶이지 않고, 커밋 뒤에 응답을 기다리게 하지 않고 보낸다. 실패해도 접수는 성공이다.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsNotificationService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
  ) {}

  async create(dto: CreateLeadDto): Promise<void> {
    await this.assertActiveCode('INDUSTRY', dto.industryCode);
    // @IsOptional 은 null 도 통과시키므로 null · undefined 둘 다 「고르지 않음」이다.
    if (dto.planPeriodCode != null)
      await this.assertActiveCode('PLAN_PERIOD', dto.planPeriodCode);

    const now = new Date();
    // 거듭 누른 제출은 거의 동시에 온다. 잠그지 않으면 둘 다 아래 확인을 통과해 둘 다 저장된다.
    // 전화번호 · 이메일 키를 늘 이 순서로 잡는다 — 순서가 같으면 두 요청이 서로를 기다리는 일이 없고,
    // 다른 번호 · 이메일의 접수는 줄을 서지 않는다. 키는 배치 잡 이름(BATCH_JOB)과 같은 advisory lock
    // 공간을 쓰므로 `lead-intake:` 로 시작하게 둔다.
    const { leadId } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-intake:phone:${dto.phone}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-intake:email:${dto.email}`}))`;
      const recent = await tx.lead.findFirst({
        where: {
          createdAt: { gt: new Date(now.getTime() - REPEAT_WINDOW_MS) },
          OR: [{ phone: dto.phone }, { email: dto.email }],
        },
        select: { leadId: true },
      });
      // 안내 문구는 Manyfast 「도입문의 등록」 · 운영 정책 CNT-14 (2026-10-13 재영).
      if (recent)
        throw new HttpException(
          '이미 접수된 문의가 있습니다. 담당자가 영업일 기준 1~2일 안에 연락드립니다',
          HttpStatus.TOO_MANY_REQUESTS,
        );

      return tx.lead.create({
        select: { leadId: true },
        data: {
          contactName: dto.contactName,
          industryCode: dto.industryCode,
          industryDetail:
            dto.industryCode === INDUSTRY_OTHER ? dto.industryDetail : null,
          phone: dto.phone,
          email: dto.email,
          interests: dto.interests,
          planPeriodCode: dto.planPeriodCode ?? null,
          body: dto.body,
          privacyAgreedAt: now,
          marketingAgreedAt: dto.marketingAgreed ? now : null,
        },
      });
    });

    // ponytail: 프로세스 안에서 뒤로 미룬다. 보내는 중에 서버가 내려가면 그 알림 · 메일은 사라진다.
    // 잃으면 안 되게 되면 발송 대기 표 + 배치로 옮긴다(문의 답변 알림과 같은 한계).
    void this.notifyReceived(leadId, dto);
  }

  /** 운영 알림과 접수 확인 메일. 무엇이 실패해도 던지지 않는다. */
  private async notifyReceived(
    leadId: number,
    dto: CreateLeadDto,
  ): Promise<void> {
    await Promise.all([
      notifyLeadOperators(this.prisma, this.ops, leadId, {
        templateCode: 'NTF_LEAD_RECEIVED',
        eventKey: String(leadId),
      }).catch((e: unknown) =>
        this.logger.error(
          `lead received notification FAILED lead=${leadId}: ${reasonOf(e)}`,
        ),
      ),
      this.sendConfirmation(leadId, dto).catch((e: unknown) =>
        // 메시지는 남기지 않는다 — SMTP 오류에는 받는 주소가 섞인다. SMTP 단계의 결과는 MailService 가
        // 주소를 가려 남긴다.
        this.logger.error(
          `lead confirmation mail FAILED lead=${leadId} ${errorKind(e)}`,
        ),
      ),
    ]);
  }

  private async sendConfirmation(
    leadId: number,
    dto: CreateLeadDto,
  ): Promise<void> {
    if (!this.mail) {
      this.logger.warn(
        `lead confirmation mail SKIPPED no MAIL_* lead=${leadId}`,
      );
      return;
    }
    // 메일 이력이 아니라 도입문의 행을 센다 — 이력은 SMTP 응답 뒤에야 생겨 보내는 중인 메일을 못 센다(api #50 재리뷰).
    // 이 행은 이미 커밋됐으므로 동시에 몰려도 51번째 이후로 커밋된 접수는 언제 세도 51 이상을 봐 잠금 없이 50건을 넘지
    // 않는다. 운영자가 그 1시간 안에 도입문의를 지우면(#590) 그만큼 다시 보낼 수 있다.
    const received = await this.prisma.lead.count({
      where: { createdAt: { gt: new Date(Date.now() - HOUR_MS) } },
    });
    if (received > CONFIRMATION_HOURLY_LIMIT) {
      this.logger.warn(
        `lead confirmation mail SKIPPED hourly limit ${CONFIRMATION_HOURLY_LIMIT} lead=${leadId}`,
      );
      return;
    }
    // 고정 문구라 변수가 없다 — 확인되지 않은 주소로 가는 회사 명의 메일에 입력값을 싣지 않는다.
    await this.mail.send({
      templateCode: CONFIRMATION_TEMPLATE,
      to: dto.email,
      variables: {},
    });
  }

  /**
   * 상담 완료일로부터 1년이 지난 도입문의를 지운다. 완료일 당일부터 1년째 되는 날까지 남고 그다음 날
   * 지워진다. 날짜는 한국 날짜로 센다 — DB 세션 타임존(UTC)의 날짜로 세면 한국 자정 직후에는 아직
   * 전날이라 하루 늦게 지운다.
   * 상담 완료일이 비어 있는(상담이 안 끝난) 행은 남는다.
   * 관리자 조회(`LeadsAdminService` 의 `notExpired`)도 같은 기준으로 거른다 — 기준을 바꾸면 둘을 같이 바꾼다.
   */
  async purgeExpired(tx: Prisma.TransactionClient): Promise<number> {
    const purged = await tx.$queryRaw<{ leadId: number }[]>`
      DELETE FROM "leads"
      WHERE "consulted_date" < (now() AT TIME ZONE 'Asia/Seoul')::date - interval '1 year'
      RETURNING "lead_id" AS "leadId"
    `;
    await deleteLeadNotifications(
      tx,
      purged.map((l) => l.leadId),
    );
    return purged.length;
  }

  /** 업종 · 도입 예정 시기는 플랫폼고정 공통코드다. 사용 중지한 값은 받지 않는다. */
  private async assertActiveCode(
    groupCode: 'INDUSTRY' | 'PLAN_PERIOD',
    itemCode: string,
  ): Promise<void> {
    const found = await this.prisma.codeItem.count({
      where: {
        groupCode,
        itemCode,
        bpCode: PLATFORM_BP_CODE,
        status: 'ACTIVE',
        isDeleted: false,
      },
    });
    if (!found)
      // 화면은 공통코드 그룹 이름을 모르므로 칸 이름으로 알린다. 운영자가 막 사용 중지한
      // 값이 화면 캐시에 남아 있을 때 나는 오류다.
      throw new BadRequestException(
        groupCode === 'INDUSTRY'
          ? '업종을 다시 선택해 주세요'
          : '도입 예정 시기를 다시 선택해 주세요',
      );
  }
}
