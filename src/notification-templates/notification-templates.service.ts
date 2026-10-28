import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ListTemplatesDto } from './dto/list-templates.dto';
import type {
  CreateTemplateDto,
  SetTemplateActiveDto,
  TemplateVersionDto,
  UpdateTemplateDto,
} from './dto/save-template.dto';
import type {
  TemplateFieldsDto,
  TemplateVariableDto,
} from './dto/template-fields.dto';
import type {
  TemplateDetailDto,
  TemplateListItemDto,
  TemplateListResponseDto,
} from './dto/template.response.dto';
import { validateTemplate } from './validate-template';

const NOT_FOUND = '알림 템플릿을 찾을 수 없습니다';
const STALE = '그사이 다른 운영자가 고쳤습니다. 다시 불러온 뒤 고쳐 주세요';
const DUPLICATE_CODE = '이미 다른 템플릿이 쓰는 템플릿 코드입니다';

type Row = Prisma.NotificationTemplateGetPayload<object>;
/** 이력 행과 템플릿 행이 함께 갖는 칸 — 요약 비교에 쓴다 */
type Snapshot = Pick<
  Row,
  | 'templateCode'
  | 'channel'
  | 'templateName'
  | 'preferenceCategory'
  | 'kakaoTemplateCode'
  | 'isActive'
  | 'title'
  | 'body'
  | 'variables'
>;

/**
 * 알림 템플릿 관리(WHALEERP-572 · 573 · 581). 플랫폼 운영자만 부른다 — 권한은 컨트롤러가 본다. 고칠 때마다
 * 바뀌기 전 행 전체를 이력에 남기고(지우지 않음), 읽은 updatedAt 이 다르면 409 다. 지우는 길은 없고 사용 여부로 끈다
 * (운영 정책 NTF-21). 기본 문구(default_*)는 마이그레이션으로 넣은 기본 템플릿 44건에만 있다(NOTIFY-17).
 */
@Injectable()
export class NotificationTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListTemplatesDto): Promise<TemplateListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = { channel: query.channel };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notificationTemplate.findMany({
        where,
        orderBy: [{ templateCode: 'asc' }, { notificationTemplateId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationTemplate.count({ where }),
    ]);
    const names = await this.adminNames(rows.map((r) => r.updatedBy));
    return { items: rows.map((r) => toItem(r, names)), total };
  }

  async get(id: number): Promise<TemplateDetailDto> {
    const row = await this.prisma.notificationTemplate.findUnique({
      where: { notificationTemplateId: id },
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const histories = await this.prisma.notificationTemplateHistory.findMany({
      where: { notificationTemplateId: id },
      orderBy: [{ changedAt: 'asc' }, { notificationTemplateHistoryId: 'asc' }],
    });
    const names = await this.adminNames([
      row.updatedBy,
      ...histories.map((h) => h.changedBy),
    ]);
    // 이력 한 줄은 바뀌기 전 행이다 — 바뀐 뒤는 다음 이력 줄이거나 지금 행이다.
    const items = histories.map((h, i) => ({
      changedAt: h.changedAt,
      changedByName: names.get(h.changedBy) ?? null,
      summary: historySummary(h, histories[i + 1] ?? row),
    }));
    return {
      ...toItem(row, names),
      body: row.body,
      // CHECK notification_templates_variables_array 가 배열임을 보장한다.
      variables: row.variables as unknown as TemplateVariableDto[],
      histories: items.reverse(),
    };
  }

  async create(
    adminId: number,
    dto: CreateTemplateDto,
  ): Promise<TemplateDetailDto> {
    const data = fieldsOf(dto);
    try {
      const created = await this.prisma.notificationTemplate.create({
        data: { ...data, isActive: dto.isActive, updatedBy: adminId },
      });
      return this.get(created.notificationTemplateId);
    } catch (e) {
      throw duplicateOr(e);
    }
  }

  async update(
    adminId: number,
    id: number,
    dto: UpdateTemplateDto,
  ): Promise<TemplateDetailDto> {
    const data = fieldsOf(dto);
    await this.change(adminId, id, dto, () => data);
    return this.get(id);
  }

  /** 기본 문구로 되돌리기 — 제목 · 본문 · 변수 목록만(NOTIFY-18). 기본값이 없으면(등록한 템플릿) 409 */
  async restore(
    adminId: number,
    id: number,
    dto: TemplateVersionDto,
  ): Promise<TemplateDetailDto> {
    await this.change(adminId, id, dto, (current) => {
      if (current.defaultBody === null || current.defaultVariables === null)
        throw new ConflictException(
          '등록한 템플릿은 되돌릴 기본 문구가 없습니다',
        );
      const restored = {
        title: current.channel === 'ALIMTALK' ? null : current.defaultTitle,
        body: current.defaultBody,
        // CHECK notification_templates_default_variables_array 가 배열임을 보장한다.
        variables: current.defaultVariables as unknown as TemplateVariableDto[],
      };
      // 채널 · 코드는 그대로라, 채널을 바꾼 뒤 되돌리면 기본값이 지금 채널 규칙(앱 푸시 글자 수 · 버튼 링크 등)에 어긋날 수 있다.
      const errors = validateTemplate({ ...current, ...restored });
      if (errors.length) throw new BadRequestException(errors);
      return {
        ...restored,
        variables: current.defaultVariables,
      };
    });
    return this.get(id);
  }

  async setActive(
    adminId: number,
    id: number,
    dto: SetTemplateActiveDto,
  ): Promise<TemplateDetailDto> {
    await this.change(adminId, id, dto, () => ({ isActive: dto.isActive }));
    return this.get(id);
  }

  /**
   * 한 트랜잭션에서 바뀌기 전 행을 이력에 남기고 고친다. 고치기는 읽은 updatedAt 과 같을 때만 — 0건이면 그사이 누가
   * 고친 것이라 409 로 되돌린다(이력도 함께 사라진다).
   */
  private async change(
    adminId: number,
    id: number,
    version: TemplateVersionDto,
    next: (current: Row) => Prisma.NotificationTemplateUpdateManyMutationInput,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.notificationTemplate.findUnique({
          where: { notificationTemplateId: id },
        });
        if (!current) throw new NotFoundException(NOT_FOUND);
        const data = next(current);
        await tx.notificationTemplateHistory.create({
          data: {
            notificationTemplateId: id,
            templateCode: current.templateCode,
            channel: current.channel,
            templateName: current.templateName,
            preferenceCategory: current.preferenceCategory,
            kakaoTemplateCode: current.kakaoTemplateCode,
            isActive: current.isActive,
            title: current.title,
            body: current.body,
            variables: current.variables as Prisma.InputJsonValue,
            changedBy: adminId,
            changedAt: new Date(),
          },
        });
        const { count } = await tx.notificationTemplate.updateMany({
          where: {
            notificationTemplateId: id,
            updatedAt: sameMillisecond(version.updatedAt),
          },
          data: { ...data, updatedBy: adminId },
        });
        if (count === 0) throw new ConflictException(STALE);
      });
    } catch (e) {
      throw duplicateOr(e);
    }
  }

  private async adminNames(
    ids: (number | null)[],
  ): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((v): v is number => v !== null))];
    if (unique.length === 0) return new Map();
    const admins = await this.prisma.adminAccount.findMany({
      where: { adminAccountId: { in: unique } },
      select: { adminAccountId: true, name: true },
    });
    return new Map(admins.map((a) => [a.adminAccountId, a.name ?? '']));
  }
}

/** 저장 검사를 거친 칸. 걸리면 400 과 고칠 문장 목록(Nest 기본 형식의 message 배열) */
function fieldsOf(dto: TemplateFieldsDto) {
  const input = {
    channel: dto.channel,
    templateName: dto.templateName,
    templateCode: dto.templateCode,
    preferenceCategory: dto.preferenceCategory ?? null,
    // 빈 제목은 없음과 같다 — 알림톡은 그대로 저장되고, 다른 채널은 검사가 「제목을 넣어 주세요」로 막는다.
    title: dto.title || null,
    body: dto.body,
    // 빈 글자도 없음과 같다 — 그대로 두면 알림톡이 아닌 채널에서 CHECK 에 걸려 500 이 된다.
    kakaoTemplateCode: dto.kakaoTemplateCode || null,
    variables: dto.variables.map((v) => ({
      name: v.name,
      label: v.label,
      isRequired: v.isRequired,
      sampleValue: v.sampleValue,
      ...(v.isButtonLink ? { isButtonLink: true } : {}),
    })),
  };
  const errors = validateTemplate(input);
  if (errors.length) throw new BadRequestException(errors);
  return { ...input, variables: input.variables as Prisma.InputJsonValue };
}

function duplicateOr(e: unknown): unknown {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
    ? new ConflictException(DUPLICATE_CODE)
    : e;
}

function toItem(r: Row, names: Map<number, string>): TemplateListItemDto {
  return {
    id: r.notificationTemplateId,
    templateCode: r.templateCode,
    channel: r.channel,
    templateName: r.templateName,
    preferenceCategory: r.preferenceCategory,
    title: r.title,
    bodySummary: r.body.slice(0, 60),
    kakaoTemplateCode: r.kakaoTemplateCode,
    isActive: r.isActive,
    hasDefault: r.defaultBody !== null,
    updatedByName:
      r.updatedBy === null ? null : (names.get(r.updatedBy) ?? null),
    updatedAt: r.updatedAt,
  };
}

const SUMMARY_FIELDS: [keyof Snapshot, string][] = [
  ['isActive', '사용 여부'],
  ['channel', '발송 채널'],
  ['templateName', '템플릿 이름'],
  ['templateCode', '템플릿 코드'],
  ['preferenceCategory', '수신 설정 묶음'],
  ['kakaoTemplateCode', '카카오 템플릿 코드'],
  ['title', '제목'],
  ['body', '본문'],
  ['variables', '변수 목록'],
];

/** 이력 한 줄에서 바뀐 칸 이름을 화면 순서로 잇는다 — 「제목 · 본문」 */
export function historySummary(before: Snapshot, after: Snapshot): string {
  const changed = SUMMARY_FIELDS.filter(
    ([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  ).map(([, label]) => label);
  return changed.length ? changed.join(' · ') : '바뀐 것 없음';
}

/** 응답의 updatedAt(밀리초)과 DB(마이크로초)를 같은 밀리초 안에서 비교한다 — posts 와 같은 방식 */
function sameMillisecond(iso: string): { gte: Date; lt: Date } {
  const at = new Date(iso);
  return { gte: at, lt: new Date(at.getTime() + 1) };
}
