import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, StoreImageFileType } from '@prisma/client';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';
import { isPlatformRole } from '../admin-scope/admin-scope.service';
import { containsText } from '../common/contains-text';
import { sameMillisecond } from '../common/updated-at';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import type { MenuCaller } from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday, parseDateOnly } from '../staff-members/kst-date';
import {
  type OptionalStorage,
  requireStorage,
  STORAGE,
} from '../storage/storage.module';
import {
  StorageService,
  type ThumbnailOption,
} from '../storage/storage.service';
import { assertUpload } from '../storage/upload-check';
import type {
  ListStoresQueryDto,
  StoreExcelQueryDto,
  StoreHistoryPageDto,
} from './dto/list-stores-query.dto';
import type {
  BusinessIdentityInputDto,
  CreateStoreDto,
  SaveStoreDto,
  StoreFloorInputDto,
  UpdateStoreDto,
  VerifyStoreBusinessDto,
} from './dto/save-store.dto';
import type {
  CreateStoreResponseDto,
  StoreBusinessVerificationResponseDto,
  StoreDetailResponseDto,
  StoreHistoryListResponseDto,
  StoreImageResponseDto,
  StoreListResponseDto,
  StoreTransitionCheckResponseDto,
} from './dto/store.response.dto';
import {
  type BusinessIdentity,
  type OptionalStoreBusinessVerifier,
  STORE_BUSINESS_VERIFIER,
} from './store-business-verifier';
import {
  buildStoreWorkbook,
  STORE_EXCEL_INTERVAL_MS,
  STORE_EXCEL_MAX_ROWS,
  storeExcelFileName,
} from './store-excel';
import {
  canTransition,
  floorLabel,
  FRANCHISE_ROLE_TYPES,
  IN_PROGRESS_CONTRACT_STATUSES,
  LIVE_STORE_STATUSES,
  missingForOperation,
  regionOf,
  retainEndDate,
  OPERATION_REQUIREMENT_LABELS,
  statusLabel,
  STORE_TYPES,
} from './store-format';
import { dateOnly } from '../common/date-only';
import { SIGNED_ONCE } from '../contracts/signed-contract';

type Tx = Prisma.TransactionClient;
type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

const NOT_FOUND = '점포를 찾을 수 없습니다';
const CHANGED_MEANWHILE =
  '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요';
const BP_INACTIVE =
  '소속 BP가 미사용 상태여서 이 업무를 할 수 없습니다. 조회는 그대로 됩니다';
/** 번호를 쓰는 것이 점포인지 BP 인지 드러내지 않는다 — 가입 · MY PAGE 와 같은 문구(PL-OCJOFP). */
const NUMBER_TAKEN = '이미 등록된 사업자등록번호입니다.';

/**
 * 관리자별 국세청 호출 한도 — 한 시간 10번. 국세청 키 · 하루 할당량을 모든 BP 가 함께 쓰므로, 한 관리자가
 * 인증 확인 · 등록 · 수정으로 거듭 부르면 그날 모든 BP 의 가입 · 점포 인증이 503 이 된다. 회원가입 진위확인과
 * 같은 기준이고, 국세청을 실제로 부를 때만 센다 — 일반 저장은 막지 않는다.
 */
const NTS_CALLS_PER_HOUR = 10;
const NTS_WINDOW_MS = 3_600_000;
/**
 * 화면은 「인증하기」로 한 번 묻고 저장 때 서버가 다시 묻는다. 같은 관리자가 이 시간 안에 일치를 받은 같은 세
 * 값이면 저장 때 다시 묻지 않는다 — 점포 하나가 국세청 호출 하나가 되게(그러지 않으면 위 한도로 시간당 점포
 * 5개다). 서버가 국세청에서 직접 받은 결과만 기억하므로 화면이 보낸 「인증됨」을 믿는 것이 아니다.
 */
const VERIFIED_REUSE_MS = 600_000;

/** 대표 이미지 한 장의 상한. 정책「JPG · PNG 5MB 이하」, DB CHECK 와 같다. */
export const STORE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * 대표 이미지는 늘 썸네일과 함께 올린다 — 목록 카드가 thumbnailUrl 을 쓰고, thumbnailUrl 은 사본이 있는지 보지 않는다
 * (okf storage: 업무마다 옵션을 바꾸지 않는다). true 는 긴 변 320px 이다.
 */
export const STORE_IMAGE_THUMBNAIL: ThumbnailOption = true;
/** 허용 종류는 file_type 컬럼의 enum 이다 — 업무 코드에 목록을 따로 적지 않는다. */
const STORE_IMAGE_TYPES = Object.values(StoreImageFileType);
const IMAGE_FIELD = '대표 이미지';

/** multipart 로 받은 대표 이미지 한 장 */
export type StoreImageUpload = {
  buffer: Buffer;
  size: number;
  originalname: string;
};

const IMAGE_SELECT = {
  fileId: true,
  fileName: true,
  fileType: true,
  sizeBytes: true,
  storageKey: true,
} as const;
/** 지우지 않은 대표 이미지는 점포당 하나다(부분 고유 인덱스). */
const LIVE_IMAGE = {
  where: { isDeleted: false },
  select: IMAGE_SELECT,
  take: 1,
} as const;

/**
 * 등록 트랜잭션 시간. 모든 등록이 점포코드 잠금에 줄을 서므로 기본값(대기 2초 · 실행 5초)보다 넉넉히 둔다.
 */
const STORE_CODE_TX = { maxWait: 5_000, timeout: 15_000 };

const FLOOR_SELECT = {
  storeFloorId: true,
  floorTypeCode: true,
  floorNumber: true,
  floorAreaPyeong: true,
  floorAreaSqm: true,
  seatCount: true,
} as const;

const DETAIL_SELECT = {
  storeId: true,
  storeCode: true,
  name: true,
  storeTypeCode: true,
  storeStatusCode: true,
  closedDate: true,
  bpCodeId: true,
  phone: true,
  zipCode: true,
  address: true,
  addressDetail: true,
  latitude: true,
  longitude: true,
  isLocationApplied: true,
  createdAt: true,
  updatedAt: true,
  bpCode: {
    select: { bpCode: true, tradeName: true, accountStatusCode: true },
  },
  creator: { select: { name: true } },
  updater: { select: { name: true } },
  businessProfile: true,
  floors: {
    where: { isDeleted: false },
    select: FLOOR_SELECT,
    orderBy: { storeFloorId: 'asc' },
  },
  imageFiles: LIVE_IMAGE,
} satisfies Prisma.StoreSelect;

type StoreDetailRow = Prisma.StoreGetPayload<{ select: typeof DETAIL_SELECT }>;
type ProfileRow = NonNullable<StoreDetailRow['businessProfile']>;

/**
 * 점포를 다루는 관리자. 가드가 메뉴 권한을 본 뒤 계정 한 행에서 권한 유형 · 소속 BP · 점포 범위를 읽어 둔다. `isPlatform` 은 플랫폼 계정
 * (권한 유형 PM · PA 이면서 소속 BP 가 플랫폼 BP)인가다 — 판정은 isPlatformRole(admin-scope) 하나로 한다.
 */
type StoreCaller = MenuCaller & {
  /** 소속 BP. 범위 · 등록에는 쓰지 않는다 — targetBpCodeId 를 쓴다. */
  bpCodeId: number;
  isAllStores: boolean;
  isPlatform: boolean;
  /** 다루는 점포의 BP — 플랫폼 계정은 상단에서 고른 고객 BP(X-Bp-Code-Id → @TargetBp), 그 밖의 계정은 소속 BP. */
  targetBpCodeId: number;
};

/**
 * 관리자 웹 「점포 정보 관리」(MN000002). 1팀 `stores` 와 층별정보 · 사업자정보 · 변경 이력을 다룬다.
 *
 * 범위: 플랫폼 계정(PM · PA 이면서 소속 BP 가 플랫폼 BP)은 상단에서 고른 BP(X-Bp-Code-Id → @TargetBp)의 점포만이고,
 * 고르지 않았으면(헤더 없음) 어느 경로든 400 이다 — BP 권한 그룹과 같다. 그 밖의 계정은 자기 BP 의 점포 —
 * 전체 점포가 아니면 매핑된 점포만이다. 고객 BP 소속인데 권한 유형이 PM · PA 인 계정도 자기 BP 범위다. 메뉴 권한은 가드(@MenuPermission)가 먼저 본다. 여기서는 그 위의 업무 규칙을 본다.
 * - 상태는 미운영 → 운영 → 폐점 한 방향이다. 운영은 사업자 인증 · 좌표 · 사용 중인 BP 가 있어야 한다(STORE-2).
 * - 폐점 · 삭제는 진행 중인 근로계약이 없어야 한다. 삭제는 미운영만, 폐점한 점포는 조회만 된다.
 * - 소속 BP 가 미사용이면 조회만 된다(STORE-3). 가맹 역할은 등록하지 못한다.
 * - 사업자등록번호는 미운영 · 운영 점포끼리 고유하다. DB 제약으로 표현할 수 없어(상태가 다른 표에 있다)
 *   번호로 잠근 뒤 센다.
 */
@Injectable()
export class StoreManagementService implements OnModuleInit {
  private readonly logger = new Logger(StoreManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** 국세청 진위확인. NTS_SERVICE_KEY 가 없으면 null — 인증을 요구하는 요청은 503. */
    @Inject(STORE_BUSINESS_VERIFIER)
    private readonly verifier: OptionalStoreBusinessVerifier,
    /** 첨부파일 저장소. 설정이 없으면 null — 이미지 올리기만 503 이고 조회의 주소는 null 이다. */
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  /** 관리자별 국세청 호출 시각(ms). NTS_CALLS_PER_HOUR 에 쓴다. 프로세스 메모리라 인스턴스마다 따로 센다. */
  private readonly ntsCallsAt = new Map<number, number[]>();

  /** 관리자 · 세 값별로 국세청이 일치라고 한 시각(ms). VERIFIED_REUSE_MS 에 쓴다. */
  private readonly verifiedAt = new Map<string, number>();

  /** 관리자별 마지막 엑셀 받은 시각(ms). 1분 1회 제한에 쓴다. */
  private readonly excelAt = new Map<number, number>();

  /** 연동이 없으면 아무 점포도 운영으로 바꿀 수 없다 — 운영자가 로그에서 알 수 있게 기동 때 남긴다. */
  onModuleInit(): void {
    if (!this.verifier)
      this.logger.warn(
        '사업자 진위확인 연동이 없습니다 — 사업자 인증을 보낸 요청은 503 이고, 인증된 점포가 없어 운영으로 바꿀 수 없습니다',
      );
    if (!this.storage)
      this.logger.warn(
        '첨부파일 저장소 설정이 없습니다 — 점포 이미지 올리기는 503 이고, 목록 · 상세의 이미지 주소는 null 입니다',
      );
  }

  async list(
    callerId: number,
    bp: TargetBpContext,
    query: ListStoresQueryDto,
  ): Promise<StoreListResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    const { page, pageSize } = query;
    const where = listWhere(caller, query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.store.findMany({
        where,
        select: {
          storeId: true,
          storeCode: true,
          name: true,
          storeTypeCode: true,
          storeStatusCode: true,
          bpCodeId: true,
          phone: true,
          address: true,
          createdAt: true,
          bpCode: { select: { tradeName: true } },
          businessProfile: { select: { bizRegistrationNumber: true } },
          imageFiles: LIVE_IMAGE,
        },
        orderBy: [{ createdAt: 'desc' }, { storeId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.store.count({ where }),
    ]);
    const [staff, imageUrls] = await Promise.all([
      this.staffCounts(rows.map((r) => r.storeId)),
      this.thumbnailUrls(rows.map((r) => r.imageFiles[0])),
    ]);
    return {
      items: rows.map((r, i) => ({
        storeId: r.storeId,
        storeCode: r.storeCode,
        name: r.name,
        storeTypeCode: r.storeTypeCode,
        storeStatusCode: r.storeStatusCode,
        bpCodeId: r.bpCodeId,
        bpTradeName: r.bpCode.tradeName,
        bizRegistrationNumber: r.businessProfile?.bizRegistrationNumber ?? null,
        phone: r.phone,
        region: regionOf(r.address),
        staffCount: staff.get(r.storeId) ?? 0,
        imageUrl: imageUrls[i],
        createdAt: r.createdAt,
      })),
      total,
    };
  }

  /**
   * 엑셀 바로 받기. 목록과 같은 조건 · 순서로 전부 담는다. 1만 건 이상은 예약 생성 대상이라 아직 받지 않는다
   * (400 — 조건을 좁히면 된다). 한 사람 1분에 한 번이다(429). 횟수는 이 프로세스 메모리에서 센다 — 서버를
   * 여러 대로 늘리면 대수만큼 늘어난다.
   */
  async excel(
    callerId: number,
    bp: TargetBpContext,
    query: StoreExcelQueryDto,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const caller = await this.loadCaller(callerId, bp);
    const id = caller.adminAccountId;
    const now = Date.now();
    const last = this.excelAt.get(id);
    if (last !== undefined && now - last < STORE_EXCEL_INTERVAL_MS)
      throw new HttpException(
        `엑셀은 1분에 한 번 받을 수 있습니다. ${Math.ceil((last + STORE_EXCEL_INTERVAL_MS - now) / 1000)}초 뒤 다시 받아 주세요`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    // 파일을 만들기 전에 적어 둔다 — 두 번 누른 요청 중 하나만 지나가게.
    this.excelAt.set(id, now);
    for (const [admin, at] of this.excelAt)
      if (now - at >= STORE_EXCEL_INTERVAL_MS) this.excelAt.delete(admin);

    try {
      return await this.buildExcel(caller, query);
    } catch (error) {
      // 조건을 고치면 되는 거절(1만 건 초과 같은 4xx)은 1분에 세지 않는다. 서버 오류는 센다 — 다시 눌러
      // 최대 1만 행을 거듭 읽지 않게.
      if (error instanceof HttpException && error.getStatus() < 500)
        this.excelAt.delete(id);
      throw error;
    }
  }

  private async buildExcel(
    caller: StoreCaller,
    query: StoreExcelQueryDto,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const where = listWhere(caller, query);
    const total = await this.prisma.store.count({ where });
    if (total >= STORE_EXCEL_MAX_ROWS) {
      throw new BadRequestException(
        `1만 건 이상은 바로 받을 수 없습니다(${total.toLocaleString('ko-KR')}건). 검색 조건을 좁혀 주세요`,
      );
    }
    const rows = await this.prisma.store.findMany({
      where,
      select: {
        storeId: true,
        storeCode: true,
        name: true,
        storeTypeCode: true,
        storeStatusCode: true,
        phone: true,
        zipCode: true,
        address: true,
        addressDetail: true,
        createdAt: true,
        bpCode: { select: { tradeName: true } },
        businessProfile: {
          select: {
            bizRegistrationNumber: true,
            bizTradeName: true,
            bizCeoName: true,
            bizCeoPhone: true,
            bizOpenDate: true,
            bizZipCode: true,
            bizAddress: true,
            bizAddressDetail: true,
            bizCategory: true,
            bizItem: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { storeId: 'desc' }],
    });
    const staff = await this.staffCounts(rows.map((r) => r.storeId));
    const buffer = await buildStoreWorkbook(
      rows.map(({ bpCode, businessProfile, storeId, ...r }) => ({
        ...r,
        bpTradeName: bpCode.tradeName,
        staffCount: staff.get(storeId) ?? 0,
        business: businessProfile,
      })),
    );
    return { fileName: storeExcelFileName(), buffer };
  }

  async detail(
    callerId: number,
    bp: TargetBpContext,
    storeId: number,
  ): Promise<StoreDetailResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    const store = await this.findStore(this.prisma, caller, storeId);
    const [image] = store.imageFiles;
    // 읽기를 동시에 보내지 않는다 — e2e 의 PGlite 소켓 서버가 연결을 하나만 받는다(문의 · 공지와 같은 관례).
    const staff = await this.staffCounts([storeId]);
    const transitions = await this.transitionsOf(store);
    const url = await this.imageUrl(image);
    const profile = store.businessProfile;
    return {
      storeId: store.storeId,
      storeCode: store.storeCode,
      name: store.name,
      storeTypeCode: store.storeTypeCode,
      storeStatusCode: store.storeStatusCode,
      closedDate: dateOnly(store.closedDate),
      bpCodeId: store.bpCodeId,
      bpCode: store.bpCode.bpCode,
      bpTradeName: store.bpCode.tradeName,
      bpAccountStatusCode: store.bpCode.accountStatusCode,
      phone: store.phone,
      zipCode: store.zipCode,
      address: store.address,
      addressDetail: store.addressDetail,
      latitude: numberOrNull(store.latitude),
      longitude: numberOrNull(store.longitude),
      isLocationApplied: store.isLocationApplied,
      staffCount: staff.get(storeId) ?? 0,
      business: {
        isVerified: Boolean(profile?.bizRegistrationNumber),
        bizRegistrationNumber: profile?.bizRegistrationNumber ?? null,
        ceoName: profile?.bizCeoName ?? null,
        openDate: dateOnly(profile?.bizOpenDate ?? null),
        verifiedAt: profile?.bizVerifiedAt ?? null,
        tradeName: profile?.bizTradeName ?? null,
        ceoPhone: profile?.bizCeoPhone ?? null,
        zipCode: profile?.bizZipCode ?? null,
        address: profile?.bizAddress ?? null,
        addressDetail: profile?.bizAddressDetail ?? null,
        category: profile?.bizCategory ?? null,
        item: profile?.bizItem ?? null,
      },
      floors: store.floors.map((f) => ({
        storeFloorId: f.storeFloorId,
        floorTypeCode: f.floorTypeCode,
        floorNumber: f.floorNumber,
        floorAreaPyeong: numberOrNull(f.floorAreaPyeong),
        floorAreaSqm: numberOrNull(f.floorAreaSqm),
        seatCount: f.seatCount,
      })),
      image: image ? imageOf(image, url) : null,
      transitions,
      createdAt: store.createdAt,
      createdByName: store.creator?.name ?? null,
      updatedAt: store.updatedAt,
      updatedByName: store.updater?.name ?? null,
    };
  }

  /** 상태 전환 · 삭제를 지금 할 수 있는가. 수정 화면이 폐점을 고를 때 다시 묻는다. */
  async transitionCheck(
    callerId: number,
    bp: TargetBpContext,
    storeId: number,
  ): Promise<StoreTransitionCheckResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    return this.transitionsOf(
      await this.findStore(this.prisma, caller, storeId),
    );
  }

  /** 변경 이력. 보존 기한(5년) 안의 것만, 최신순. */
  async histories(
    callerId: number,
    bp: TargetBpContext,
    storeId: number,
    { page, pageSize }: StoreHistoryPageDto,
  ): Promise<StoreHistoryListResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    await this.findStore(this.prisma, caller, storeId);
    const where: Prisma.StoreChangeHistoryWhereInput = {
      storeId,
      retainEndDate: { gte: kstToday() },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.storeChangeHistory.findMany({
        where,
        select: {
          changeId: true,
          field: true,
          beforeValue: true,
          afterValue: true,
          changedAt: true,
          changer: { select: { name: true } },
        },
        orderBy: [{ changedAt: 'desc' }, { changeId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.storeChangeHistory.count({ where }),
    ]);
    return {
      items: rows.map(({ changer, ...row }) => ({
        ...row,
        changedByName: changer?.name ?? null,
      })),
      total,
    };
  }

  /**
   * 등록. 늘 미운영으로 만들고 점포코드(ST+6자리)를 채번한다. 지운 점포의 코드도 다시 쓰지 않는다 — 마지막
   * 코드 다음 번호를, 채번끼리 줄 세운 채 고른다.
   */
  async create(
    callerId: number,
    bp: TargetBpContext,
    dto: CreateStoreDto,
  ): Promise<CreateStoreResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    if (FRANCHISE_ROLE_TYPES.includes(caller.roleTypeCode))
      // 관리자 웹은 403 문구로 화면 동작을 가른다 — 공용 문구만 쓴다(auth/access-messages).
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    assertCoordinatePair(dto);
    const { isPlatform, targetBpCodeId: bpCodeId } = caller;
    // 본문의 bpCodeId 는 front 가 아직 보내서 받아 두는 칸이다 — 대상 BP 와 같을 때만 받는다.
    if (dto.bpCodeId && dto.bpCodeId !== bpCodeId)
      throw new BadRequestException('다른 BP 에 점포를 등록할 수 없습니다');

    const target = await this.prisma.bpCode.findFirst({
      where: { bpCodeId, isDeleted: false, isPlatform: false },
      select: { accountStatusCode: true },
    });
    if (!target) throw new BadRequestException('없는 BP 입니다');
    if (target.accountStatusCode !== 'ACTIVE')
      throw new ConflictException(BP_INACTIVE);

    const identity = dto.businessVerification
      ? await this.verifiedIdentity(
          caller.adminAccountId,
          dto.businessVerification,
          null,
          bpCodeId,
        )
      : null;
    const by = caller.adminAccountId;
    const floors = filledFloors(dto.floors);

    return this.prisma
      .$transaction(async (tx) => {
        if (identity) await this.lockNumber(tx, identity, null, bpCodeId);

        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('stores:store_code'))`;
        const last = await tx.store.findFirst({
          orderBy: { storeCode: 'desc' },
          select: { storeCode: true },
        });
        const storeCode = nextStoreCode(last?.storeCode ?? null);

        const store = await tx.store.create({
          data: {
            storeCode,
            bpCodeId,
            storeTypeCode: dto.storeTypeCode,
            ...storeFields(dto),
            storeStatusCode: 'NOT_OPERATING',
            createdBy: by,
          },
          select: { storeId: true, storeCode: true },
        });
        const { storeId } = store;

        const profile = profileFields(dto, identity);
        if (Object.values(profile).some((v) => v !== null))
          await tx.storeBusinessProfile.create({
            data: { storeId, ...profile, createdBy: by },
          });
        if (floors.length)
          await tx.storeFloor.createMany({
            data: floors.map((f) => ({ storeId, ...f, createdBy: by })),
          });
        // 일부 점포만 맡은 계정은 매핑된 점포만 본다 — 자기가 만든 점포를 볼 수 있게 매핑한다.
        // 전체 점포 계정은 매핑 없이도 BP 의 모든 점포를 본다.
        if (!isPlatform && !caller.isAllStores)
          await tx.adminStoreMapping.create({
            data: { adminAccountId: by, storeId, createdBy: by },
          });
        await record(tx, storeId, by, [
          { field: '등록', beforeValue: null, afterValue: dto.name },
        ]);
        return store;
      }, STORE_CODE_TX)
      .catch((error: unknown) => {
        // 채번은 잠금 안에서 하지만, 잠금을 거치지 않은 등록(다른 코드 · 직접 SQL)과 겹치면 고유 제약에 걸린다.
        if (isUniqueViolation(error)) {
          this.logger.warn(
            `점포 등록이 고유 제약에 걸렸다 meta=${JSON.stringify(error.meta ?? null)}`,
          );
          throw new ConflictException(
            '점포코드가 겹쳤습니다. 잠시 뒤 다시 등록해 주세요',
          );
        }
        // 모든 등록이 점포코드 잠금에 줄을 선다 — 몰려서 시간을 넘기면 장애가 아니라 다시 시도할 일이다.
        if (isPrismaError(error, 'P2028')) {
          this.logger.error(
            `점포 등록 트랜잭션 시간 초과 by=${by}`,
            stackOf(error),
          );
          throw new ServiceUnavailableException(
            '등록이 몰렸습니다. 잠시 뒤 다시 등록해 주세요',
          );
        }
        throw error;
      });
  }

  /**
   * 수정. 화면 전체를 받는다 — 빠진 선택 칸은 지운다. 상태 전환도 여기서 한다. 상세에서 받은 updatedAt 과
   * 같을 때만 고치고(그 사이 고쳤으면 409), 바뀐 항목마다 이력을 남긴다.
   */
  async update(
    callerId: number,
    bp: TargetBpContext,
    storeId: number,
    dto: UpdateStoreDto,
  ): Promise<void> {
    assertCoordinatePair(dto);
    const caller = await this.loadCaller(callerId, bp);
    const store = await this.findStore(this.prisma, caller, storeId);
    const from = store.storeStatusCode;
    if (from === 'CLOSED')
      throw new ConflictException(
        '폐점한 점포는 고칠 수 없습니다. 다시 운영하려면 신규 점포로 등록합니다',
      );
    if (store.bpCode.accountStatusCode !== 'ACTIVE')
      throw new ConflictException(BP_INACTIVE);
    if (!canTransition(from, dto.storeStatus))
      throw new BadRequestException(
        `${statusLabel(from)} 점포를 ${statusLabel(dto.storeStatus)}으로 바꿀 수 없습니다`,
      );

    const profile = store.businessProfile;
    const savedNumber = profile?.bizRegistrationNumber ?? null;
    let identity: BusinessIdentity | null = null;
    if (dto.businessVerification) {
      const v = dto.businessVerification;
      if (
        savedNumber &&
        (v.bizRegistrationNumber !== savedNumber ||
          v.openDate !== dateOnly(profile!.bizOpenDate))
      )
        throw new BadRequestException(
          '사업자등록번호 · 개업일자는 저장한 뒤 바꿀 수 없습니다. 대표자명만 다시 인증합니다',
        );
      // 재인증은 이 점포가 이미 가진 번호라 중복을 다시 보지 않는다.
      identity = await this.verifiedIdentity(
        caller.adminAccountId,
        v,
        savedNumber ? 'skip' : storeId,
        store.bpCodeId,
      );
    }

    // 운영 조건은 운영으로 바꿀 때만 본다. 이미 운영 중인 점포는 인증 없이 들어온 것도 있고(이 API 전에
    // 들어온 점포) 그대로 고칠 수 있어야 한다. 그런 점포에서 막는 것은 있던 좌표를 지우는 것 하나 — 출퇴근
    // 위치 확인이 쓴다.
    if (
      from === 'OPERATING' &&
      store.latitude != null &&
      store.longitude != null &&
      (dto.latitude == null || dto.longitude == null)
    )
      throw new BadRequestException('운영 중인 점포의 좌표는 지울 수 없습니다');
    if (from !== 'OPERATING' && dto.storeStatus === 'OPERATING') {
      const missing = missingForOperation({
        bizRegistrationNumber: identity?.bizRegistrationNumber ?? savedNumber,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        bpAccountStatusCode: store.bpCode.accountStatusCode,
      });
      if (missing.length)
        throw new BadRequestException(
          `운영으로 바꾸려면 다음이 필요합니다 — ${missing.map((m) => OPERATION_REQUIREMENT_LABELS[m]).join(', ')}`,
        );
    }
    const isClosing = dto.storeStatus === 'CLOSED';
    if (isClosing) await this.assertNoContracts(storeId, '폐점할');

    const by = caller.adminAccountId;
    await this.prisma.$transaction(async (tx) => {
      if (identity && !savedNumber)
        await this.lockNumber(tx, identity, storeId, store.bpCodeId);
      // 앞의 확인과 이 폐점 사이에 근로계약이 생길 수 있다 — 점포 행을 잠그고 다시 센다(계약 쪽은 아직 잠그지
      // 않아 틈이 남는다 — assertNoContracts).
      if (isClosing) {
        await lockStore(tx, storeId);
        await this.assertNoContracts(storeId, '폐점할', tx);
      }

      const { count } = await tx.store.updateMany({
        where: {
          storeId,
          isDeleted: false,
          storeStatusCode: from,
          updatedAt: sameMillisecond(dto.updatedAt),
        },
        data: {
          ...storeFields(dto),
          storeStatusCode: dto.storeStatus,
          ...(isClosing && { closedDate: kstToday() }),
          updatedBy: by,
        },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);

      const nextProfile = profileFields(dto, identity, profile);
      const profileChanges = profileHistory(profile, nextProfile);
      if (profileChanges.length || (identity && profile))
        await tx.storeBusinessProfile.upsert({
          where: { storeId },
          create: { storeId, ...nextProfile, createdBy: by },
          update: { ...nextProfile, updatedBy: by },
        });

      const beforeFloors = floorsText(store.floors);
      const floors = filledFloors(dto.floors);
      const afterFloors = floorsText(floors);
      if (beforeFloors !== afterFloors) {
        await tx.storeFloor.updateMany({
          where: { storeId, isDeleted: false },
          data: { isDeleted: true, updatedBy: by },
        });
        if (floors.length)
          await tx.storeFloor.createMany({
            data: floors.map((f) => ({ storeId, ...f, createdBy: by })),
          });
      }

      await record(tx, storeId, by, [
        change('점포명', store.name, dto.name),
        change('점포 연락처', store.phone, dto.phone ?? null),
        change(
          '주소',
          addressOf(store.zipCode, store.address, store.addressDetail),
          addressOf(
            dto.zipCode ?? null,
            dto.address ?? null,
            dto.addressDetail ?? null,
          ),
        ),
        change(
          '위도 · 경도',
          coordinatesOf(store.latitude, store.longitude),
          coordinatesOf(dto.latitude ?? null, dto.longitude ?? null),
        ),
        change(
          '위치 적용 여부',
          usedLabel(store.isLocationApplied),
          usedLabel(dto.isLocationApplied),
        ),
        change('점포상태', statusLabel(from), statusLabel(dto.storeStatus)),
        change('층별 정보', beforeFloors, afterFloors),
        ...profileChanges,
      ]);
    });
  }

  /** 삭제(논리 삭제). 미운영이면서 진행 중인 근로계약이 없어야 한다. 폐점한 점포는 지우지 않고 남긴다. */
  async remove(
    callerId: number,
    bp: TargetBpContext,
    storeId: number,
  ): Promise<void> {
    const caller = await this.loadCaller(callerId, bp);
    const store = await this.findStore(this.prisma, caller, storeId);
    if (store.bpCode.accountStatusCode !== 'ACTIVE')
      throw new ConflictException(BP_INACTIVE);
    if (store.storeStatusCode !== 'NOT_OPERATING')
      throw new ConflictException('미운영 점포만 삭제할 수 있습니다');
    await this.assertNoContracts(storeId, '삭제할');

    const by = caller.adminAccountId;
    await this.prisma.$transaction(async (tx) => {
      await lockStore(tx, storeId);
      await this.assertNoContracts(storeId, '삭제할', tx);
      const { count } = await tx.store.updateMany({
        where: { storeId, isDeleted: false, storeStatusCode: 'NOT_OPERATING' },
        data: { isDeleted: true, updatedBy: by },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
      await record(tx, storeId, by, [
        { field: '삭제', beforeValue: store.name, afterValue: null },
      ]);
    });
  }

  /** 저장 전 인증 확인. 번호 중복을 먼저 보고, 겹치면 국세청에 묻지 않는다. */
  async verifyBusiness(
    callerId: number,
    bp: TargetBpContext,
    dto: VerifyStoreBusinessDto,
  ): Promise<StoreBusinessVerificationResponseDto> {
    // 국세청 호출은 하루 할당량을 쓴다 — 사용 중인 계정인지 먼저 본다.
    const caller = await this.loadCaller(callerId, bp);
    // 소속 BP — 수정이면 그 점포의 BP, 등록이면 대상 BP(플랫폼은 탭 BP, 그 밖은 자기 BP — loadCaller 의
    // targetBpCodeId). 소속 BP 의 번호는 점포도 쓸 수 있어 이 BP 만 빼고 BP 번호 중복을 본다(PL-OCJOFP).
    const ownerBpCodeId = dto.storeId
      ? (await this.findStore(this.prisma, caller, dto.storeId)).bpCodeId
      : caller.targetBpCodeId;
    if (
      await this.isNumberTaken(
        this.prisma,
        dto.bizRegistrationNumber,
        dto.storeId ?? null,
        ownerBpCodeId,
      )
    )
      return { result: 'DUPLICATE' };
    const identity = identityOf(dto);
    if (!(await this.askVerifier(caller.adminAccountId, identity)))
      return { result: 'UNVERIFIABLE' };
    // 점포 하나가 국세청 호출 하나가 되게 기억한다(#51). 저장(verifiedIdentity)은 기억한 인증을 쓰기 전에도 소속 BP 로
    // 중복을 늘 다시 본다
    this.rememberVerified(caller.adminAccountId, identity);
    return { result: 'VERIFIED' };
  }

  /**
   * 대표 이미지 올리기 · 바꾸기. 저장소에 먼저 올리고, 점포 행을 잠근 채 옛 이미지를 지움 표시한 뒤 새 행을
   * 넣는다 — 같은 점포의 교체끼리 줄을 서서 마지막 것이 남는다. DB 저장이 실패하면 올린 파일을 지운다.
   * 바뀐 옛 파일은 지우지 않는다 — 행이 지움 표시로 남듯 파일도 남긴다.
   */
  async putImage(
    callerId: number,
    bp: TargetBpContext,
    storeId: number,
    file: StoreImageUpload | undefined,
  ): Promise<StoreImageResponseDto> {
    if (!file) throw new BadRequestException('대표 이미지 파일을 골라 주세요');
    const kind = assertUpload(file, STORE_IMAGE_TYPES, STORE_IMAGE_MAX_BYTES);
    const caller = await this.loadCaller(callerId, bp);
    assertImageEditable(await this.findStore(this.prisma, caller, storeId));
    // 저장소가 없다는 503 은 입력 · 범위 · 상태 검사 뒤에 낸다 — 404 · 409 를 가리지 않게.
    const storage = requireStorage(this.storage);

    const key = StorageService.newKey('stores', storeId, kind);
    try {
      await storage.put(key, file.buffer, kind, {
        thumbnail: STORE_IMAGE_THUMBNAIL,
      });
    } catch (error) {
      // 썸네일을 만들 수 없는 이미지(깨짐 · 화소 초과)는 고쳐 올리면 되는 400 이다 — 장애로 바꾸지 않는다.
      if (error instanceof HttpException) throw error;
      // 권한 · 버킷 설정 같은 영구 오류도 화면에는 같은 503 이다 — 원인은 여기에만 남는다.
      this.logger.error(
        `점포 이미지 올리기 실패 storeId=${storeId} key=${key}`,
        stackOf(error),
      );
      throw new ServiceUnavailableException(
        '이미지를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }

    const fileName = imageFileName(file.originalname, kind);
    const by = caller.adminAccountId;
    let saved: Prisma.StoreImageFileGetPayload<{ select: typeof IMAGE_SELECT }>;
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        const old = await lockForImage(tx, storeId, by);
        const created = await tx.storeImageFile.create({
          data: {
            storeId,
            fileName,
            fileType: kind,
            sizeBytes: file.size,
            storageKey: key,
            createdBy: by,
          },
          select: IMAGE_SELECT,
        });
        await record(tx, storeId, by, [
          {
            field: IMAGE_FIELD,
            beforeValue: old?.fileName ?? null,
            afterValue: fileName,
          },
        ]);
        return created;
      });
    } catch (error) {
      // 행 없는 파일은 아무도 보지 못하는 쓰레기다. 지우기가 실패해도 원래 오류를 내고, 찾아 지울 수 있게 키를 남긴다.
      // COMMIT 뒤에 연결이 끊기면 행은 남았는데 오류가 올 수 있다 — 행이 가리키는 파일은 지우지 않는다.
      try {
        const referenced = await this.prisma.storeImageFile.count({
          where: { storageKey: key },
        });
        if (referenced === 0) await storage.delete(key);
      } catch (cleanupError) {
        this.logger.error(
          `저장하지 못한 점포 이미지 파일을 지우지 못했다(남은 파일) key=${key}`,
          stackOf(cleanupError),
        );
      }
      throw error;
    }
    return imageOf(saved, await this.imageUrl(saved));
  }

  /** 대표 이미지 지우기. 행만 지움 표시하고 파일은 남긴다. 이미지가 없으면 아무것도 하지 않는다. */
  async removeImage(
    callerId: number,
    bp: TargetBpContext,
    storeId: number,
  ): Promise<void> {
    const caller = await this.loadCaller(callerId, bp);
    assertImageEditable(await this.findStore(this.prisma, caller, storeId));
    const by = caller.adminAccountId;
    await this.prisma.$transaction(async (tx) => {
      const old = await lockForImage(tx, storeId, by);
      if (old)
        await record(tx, storeId, by, [
          { field: IMAGE_FIELD, beforeValue: old.fileName, afterValue: null },
        ]);
    });
  }

  /**
   * 상세 · 올린 직후에 보여 줄 원본의 서명한 주소(5분). 저장소가 없거나 서명이 실패하면 null — 조회는 막지
   * 않는다. 서명은 로컬 계산이라 실패는 대개 자격 증명 · 키 문제다.
   */
  private async imageUrl(
    image: { storageKey: string; fileName: string } | undefined,
  ): Promise<string | null> {
    if (!image || !this.storage) return null;
    try {
      return await this.storage.downloadUrl(image.storageKey, image.fileName);
    } catch (error) {
      this.logger.warn(
        `점포 이미지 서명 주소를 만들지 못했다 storageKey=${image.storageKey}`,
        stackOf(error),
      );
      return null;
    }
  }

  /**
   * 목록 카드의 썸네일 주소들. 서명 실패는 null 로 두고, 한 쪽에서 몇 건이 실패했는지와 첫 원인을 warn 한 줄로
   * 남긴다 — 자격 증명이 깨지면 모든 행이 실패하므로 행마다 남기면 로그가 넘친다.
   */
  private async thumbnailUrls(
    images: ({ storageKey: string } | undefined)[],
  ): Promise<(string | null)[]> {
    const storage = this.storage;
    if (!storage) return images.map(() => null);
    const failures: { storageKey: string; error: unknown }[] = [];
    const urls = await Promise.all(
      images.map(async (image) => {
        if (!image) return null;
        try {
          return await storage.thumbnailUrl(image.storageKey);
        } catch (error) {
          failures.push({ storageKey: image.storageKey, error });
          return null;
        }
      }),
    );
    if (failures.length)
      this.logger.warn(
        `점포 이미지 썸네일 주소를 만들지 못했다 ${failures.length}/${images.filter(Boolean).length}건 첫 storageKey=${failures[0].storageKey}`,
        stackOf(failures[0].error),
      );
    return urls;
  }

  /**
   * 사용 중인 관리자 계정의 권한 유형 · 소속 BP · 점포 범위를 한 번에 읽는다. 메뉴 권한은 가드가 먼저 봤지만,
   * 그 사이 계정이 멈췄을 수 있으므로 사용 중인 계정인지 여기서도 본다.
   * 가드가 정한 대상 BP(bp)로 targetBpCodeId 를 정한다 — 플랫폼 계정이 헤더 없이 부르면(대상 = 소속 플랫폼 BP) 400.
   */
  private async loadCaller(
    callerId: number,
    bp: TargetBpContext,
  ): Promise<StoreCaller> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: callerId,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: {
        adminAccountId: true,
        roleGroupId: true,
        bpCodeId: true,
        isAllStores: true,
        roleTypeCode: true,
        bpCode: { select: { isPlatform: true } },
      },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const { bpCode, ...rest } = admin;
    // 권한 유형만 보면 고객 BP 에 잘못 들어간 PM · PA 가 플랫폼 계정으로 읽혀 자기 BP 에서도 400 이 되고 매핑 제한을
    // 건너뛴다 — 소속 BP 도 플랫폼이어야 한다(가드와 같은 판정).
    const isPlatform = isPlatformRole(rest.roleTypeCode, bpCode.isPlatform);
    // 가드는 헤더가 없으면 소속 BP(플랫폼 BP)를 정한다 — 플랫폼 BP 에는 점포가 없으니 고르라고 답한다(BP 권한 그룹과 같다).
    if (isPlatform && bp.bpCodeId === rest.bpCodeId)
      throw new BadRequestException('점포를 볼 BP 를 골라 주세요');
    return {
      ...rest,
      isPlatform,
      targetBpCodeId: isPlatform ? bp.bpCodeId : rest.bpCodeId,
    };
  }

  /** 범위 안의 지우지 않은 점포. 없으면 404. */
  private async findStore(
    db: Tx | PrismaService,
    caller: StoreCaller,
    storeId: number,
  ): Promise<StoreDetailRow> {
    const store = await db.store.findFirst({
      where: { AND: [scopeOf(caller), { storeId }] },
      select: DETAIL_SELECT,
    });
    if (!store) throw new NotFoundException(NOT_FOUND);
    return store;
  }

  private async transitionsOf(
    store: StoreDetailRow,
  ): Promise<StoreTransitionCheckResponseDto> {
    const inProgressContractCount = await this.countContracts(store.storeId);
    const isBpActive = store.bpCode.accountStatusCode === 'ACTIVE';
    const canClose =
      isBpActive &&
      store.storeStatusCode !== 'CLOSED' &&
      inProgressContractCount === 0;
    return {
      missingForOperation: missingForOperation({
        bizRegistrationNumber:
          store.businessProfile?.bizRegistrationNumber ?? null,
        latitude: store.latitude,
        longitude: store.longitude,
        bpAccountStatusCode: store.bpCode.accountStatusCode,
      }),
      inProgressContractCount,
      canClose,
      canDelete: canClose && store.storeStatusCode === 'NOT_OPERATING',
      isSubscriptionChecked: false,
    };
  }

  private countContracts(
    storeId: number,
    db: Tx | PrismaService = this.prisma,
  ): Promise<number> {
    return db.contract.count({
      where: { storeId, status: { in: [...IN_PROGRESS_CONTRACT_STATUSES] } },
    });
  }

  /**
   * 진행 중인 근로계약이 있으면 409. 트랜잭션 밖에서 한 번 보고(빠른 거절), 점포 행을 잠근 트랜잭션 안에서
   * 다시 본다. 계약 쪽은 아직 점포 행을 잠그지 않아 완전히 줄 서지는 않는다(okf Traps).
   */
  private async assertNoContracts(
    storeId: number,
    verb: string,
    db: Tx | PrismaService = this.prisma,
  ) {
    const count = await this.countContracts(storeId, db);
    if (count > 0)
      throw new ConflictException(
        `진행 중인 근로계약이 ${count}건 있어 ${verb} 수 없습니다`,
      );
  }

  /**
   * 점포별 재직 직원 수 — 목록 · 엑셀 · 상세가 같이 쓴다. 아직 퇴직(RETIRED)으로 바뀌지 않았고 체결을 거친 근로계약(체결
   * 완료이거나 체결된 뒤 종료 — SIGNED_ONCE)이 있는 직원 레코드다(WHALEERP-138, 2026-10-21). 체결을 거친 계약이 없는 레코드는
   * 세지 않고, 퇴직 예정은 퇴직 배치가 돌 때까지 센다. 근로계약 하루 배치가 종료일 지난 체결 완료를 종료로 바꾸므로
   * (WHALEERP-152) 「지금 체결 완료」만 세면 계약이 끝났어도 퇴직하지 않고 계속 일하는 직원이 빠진다(api #150 리뷰).
   * 퇴직은 진행 중 계약만 닫고 직원을 퇴직으로 바꿔 여기서 빠진다. 경우별 설명은 okf/api/stores.md 「재직 직원 수」.
   */
  private async staffCounts(storeIds: number[]): Promise<Map<number, number>> {
    if (!storeIds.length) return new Map();
    const groups = await this.prisma.staffMember.groupBy({
      by: ['storeId'],
      where: {
        storeId: { in: storeIds },
        employmentStatus: 'EMPLOYED',
        contracts: { some: SIGNED_ONCE },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.storeId, g._count._all]));
  }

  /**
   * 국세청에 확인한 세 값. 번호 중복을 먼저 본다(`'skip'` 은 재인증 — 이미 이 점포의 번호다).
   * 겹치면 409, 맞지 않으면 400, 연동이 없거나 실패하면 503.
   */
  private async verifiedIdentity(
    adminAccountId: number,
    input: BusinessIdentityInputDto,
    exclude: number | null | 'skip',
    ownerBpCodeId: number,
  ): Promise<BusinessIdentity> {
    if (
      exclude !== 'skip' &&
      (await this.isNumberTaken(
        this.prisma,
        input.bizRegistrationNumber,
        exclude,
        ownerBpCodeId,
      ))
    )
      throw new ConflictException(NUMBER_TAKEN);
    const identity = identityOf(input);
    if (this.recentlyVerified(adminAccountId, identity)) return identity;
    if (!(await this.askVerifier(adminAccountId, identity)))
      throw new BadRequestException(
        '국세청에 등록된 사업자 정보와 맞지 않습니다. 사업자등록번호 · 대표자명 · 개업일자를 확인해 주세요',
      );
    return identity;
  }

  private async askVerifier(
    adminAccountId: number,
    identity: BusinessIdentity,
  ): Promise<boolean> {
    if (!this.verifier)
      throw new ServiceUnavailableException(
        '사업자 진위확인 연동이 아직 없어 인증할 수 없습니다',
      );
    this.countNtsCall(adminAccountId);
    try {
      return await this.verifier.verify(identity);
    } catch (error) {
      // 키 만료 · 한도 초과 · 장애가 모두 같은 503 이라 원인을 남긴다. 대표자명(개인정보)은 남기지 않는다.
      this.logger.error(
        `사업자 진위확인 실패 bizRegistrationNumber=${identity.bizRegistrationNumber}`,
        stackOf(error),
      );
      throw new ServiceUnavailableException(
        '사업자 진위확인 중 오류가 났습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }
  }

  private rememberVerified(
    adminAccountId: number,
    identity: BusinessIdentity,
  ): void {
    const now = Date.now();
    this.verifiedAt.set(verifiedKey(adminAccountId, identity), now);
    for (const [key, at] of this.verifiedAt)
      if (now - at >= VERIFIED_REUSE_MS) this.verifiedAt.delete(key);
  }

  private recentlyVerified(
    adminAccountId: number,
    identity: BusinessIdentity,
  ): boolean {
    const at = this.verifiedAt.get(verifiedKey(adminAccountId, identity));
    return at !== undefined && Date.now() - at < VERIFIED_REUSE_MS;
  }

  /** 부르기 전에 센다 — 동시에 여러 번 눌러도 한도를 넘지 않게. 국세청이 답하지 못한 호출도 할당량을 썼으니 센다. */
  private countNtsCall(adminAccountId: number): void {
    const now = Date.now();
    const recent = (this.ntsCallsAt.get(adminAccountId) ?? []).filter(
      (at) => now - at < NTS_WINDOW_MS,
    );
    if (recent.length >= NTS_CALLS_PER_HOUR)
      throw new HttpException(
        `사업자 인증은 한 시간에 ${NTS_CALLS_PER_HOUR}번까지 할 수 있습니다. 잠시 후 다시 시도해 주세요`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    recent.push(now);
    this.ntsCallsAt.set(adminAccountId, recent);
    for (const [admin, times] of this.ntsCallsAt)
      if (times.every((at) => now - at >= NTS_WINDOW_MS))
        this.ntsCallsAt.delete(admin);
  }

  /** 같은 번호의 저장을 줄 세우고, 잠근 뒤 다시 센다 — 두 점포가 동시에 같은 번호를 인증해도 하나만 남는다. */
  private async lockNumber(
    tx: Tx,
    identity: BusinessIdentity,
    exclude: number | null,
    ownerBpCodeId: number,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stores:biz:${identity.bizRegistrationNumber}`}))`;
    if (
      await this.isNumberTaken(
        tx,
        identity.bizRegistrationNumber,
        exclude,
        ownerBpCodeId,
      )
    )
      throw new ConflictException(NUMBER_TAKEN);
  }

  /**
   * 이 번호를 미운영 · 운영 점포(지우지 않은)나 소속 BP 가 아닌 다른 고객 BP(사용 · 미사용)가 쓰는가. 폐점 ·
   * 삭제한 점포와 탈퇴 · 삭제한 BP 의 번호는 다시 쓸 수 있고, 소속 BP 의 번호는 점포도 쓸 수 있다(PL-OCJOFP).
   * BP 조건은 가입 · MY PAGE 의 BusinessVerificationService.isBizRegistrationNumberTaken 과 같다.
   */
  private async isNumberTaken(
    db: Tx | PrismaService,
    bizRegistrationNumber: string,
    exclude: number | null,
    ownerBpCodeId: number,
  ): Promise<boolean> {
    const [stores, bps] = await Promise.all([
      db.storeBusinessProfile.count({
        where: {
          bizRegistrationNumber,
          ...(exclude !== null && { storeId: { not: exclude } }),
          store: {
            isDeleted: false,
            storeStatusCode: { in: [...LIVE_STORE_STATUSES] },
          },
        },
      }),
      db.bpCode.count({
        where: {
          bizRegistrationNumber,
          bpCodeId: { not: ownerBpCodeId },
          isPlatform: false,
          isDeleted: false,
          accountStatusCode: { not: 'WITHDRAWN' },
        },
      }),
    ]);
    return stores > 0 || bps > 0;
  }
}

/** 목록 · 엑셀의 검색 조건. 조건은 모두 AND, 상태를 고르지 않으면 미운영 · 운영. */
function listWhere(
  caller: StoreCaller,
  query: StoreExcelQueryDto,
): Prisma.StoreWhereInput {
  const { keyword, bizRegistrationNumber } = query;
  return {
    AND: [
      scopeOf(caller),
      {
        storeStatusCode: {
          in: query.statuses?.length
            ? query.statuses
            : [...LIVE_STORE_STATUSES],
        },
        storeTypeCode: {
          in: query.storeTypes?.length ? query.storeTypes : [...STORE_TYPES],
        },
        ...(query.storeIds?.length && { storeId: { in: query.storeIds } }),
        ...(keyword && {
          OR: [
            { name: containsText(keyword) },
            { storeCode: containsText(keyword) },
          ],
        }),
        ...(bizRegistrationNumber && {
          businessProfile: {
            is: {
              bizRegistrationNumber: { contains: bizRegistrationNumber },
            },
          },
        }),
      },
    ],
  };
}

/**
 * 이 관리자가 보는 점포 — 지우지 않은 대상 BP(StoreCaller.targetBpCodeId)의 점포. 플랫폼 계정은 그 BP 의 모든
 * 점포, 그 밖의 계정은 전체 점포가 아니면 매핑된 점포만.
 * AdminScopeService 와 일부러 다르다: 그쪽은 직원 · 근로계약용이라 플랫폼 계정에게 고객 점포를 열지 않지만
 * (WHALEERP-301), 점포 정보 관리는 플랫폼이 고른 BP 의 점포를 다룬다. 하나로 합치지 않는다.
 */
function scopeOf(caller: StoreCaller): Prisma.StoreWhereInput {
  return {
    isDeleted: false,
    bpCodeId: caller.targetBpCodeId,
    ...(!caller.isPlatform &&
      !caller.isAllStores && {
        adminMappings: {
          some: { adminAccountId: caller.adminAccountId, isDeleted: false },
        },
      }),
  };
}

/** 이미지는 수정과 같은 조건에서만 바꾼다 — 폐점한 점포와 소속 BP 가 미사용인 점포는 조회만 된다. */
function assertImageEditable(store: StoreDetailRow): void {
  if (store.storeStatusCode === 'CLOSED')
    throw new ConflictException('폐점한 점포는 고칠 수 없습니다');
  if (store.bpCode.accountStatusCode !== 'ACTIVE')
    throw new ConflictException(BP_INACTIVE);
}

/** 점포 행을 FOR UPDATE 로 잠근다. 그사이 지워졌으면 404. */
async function lockStore(
  tx: Tx,
  storeId: number,
): Promise<{ storeStatusCode: string }> {
  const [locked] = await tx.$queryRaw<
    { storeStatusCode: string; isDeleted: boolean }[]
  >`SELECT store_status_code AS "storeStatusCode", is_deleted AS "isDeleted" FROM stores WHERE store_id = ${storeId} FOR UPDATE`;
  if (!locked || locked.isDeleted) throw new NotFoundException(NOT_FOUND);
  return locked;
}

/**
 * 점포 행을 잠그고 그사이 지워지거나 폐점하지 않았는지 다시 본 뒤, 지우지 않은 이미지를 지움 표시한다.
 * 지운 이미지(없으면 null)를 돌려준다.
 */
async function lockForImage(
  tx: Tx,
  storeId: number,
  by: number,
): Promise<{ fileId: number; fileName: string } | null> {
  const locked = await lockStore(tx, storeId);
  if (locked.storeStatusCode === 'CLOSED')
    throw new ConflictException('폐점한 점포는 고칠 수 없습니다');
  const old = await tx.storeImageFile.findFirst({
    where: { storeId, isDeleted: false },
    select: { fileId: true, fileName: true },
  });
  if (old)
    await tx.storeImageFile.update({
      where: { fileId: old.fileId },
      data: { isDeleted: true, updatedBy: by },
    });
  return old;
}

/**
 * 저장할 원래 파일 이름. 제어 문자(NUL 은 Postgres 가 TEXT 로 받지 않는다)를 빼고 255자로 자른다 — 칸은 TEXT 라
 * DB 상한이 없고, 255자는 화면 · 내려받기 이름을 위한 상한이다.
 * 남는 것이 없으면 image.{확장자}.
 */
function imageFileName(raw: string, kind: StoreImageFileType): string {
  // eslint-disable-next-line no-control-regex
  const name = [...raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()]
    .slice(0, 255)
    .join('');
  return name || `image.${kind.toLowerCase()}`;
}

function imageOf(
  image: {
    fileId: number;
    fileName: string;
    fileType: StoreImageFileType;
    sizeBytes: number;
  },
  url: string | null,
): StoreImageResponseDto {
  return {
    fileId: image.fileId,
    fileName: image.fileName,
    fileType: image.fileType,
    sizeBytes: image.sizeBytes,
    url,
  };
}

function storeFields(dto: SaveStoreDto) {
  return {
    name: dto.name,
    phone: dto.phone ?? null,
    zipCode: dto.zipCode ?? null,
    address: dto.address ?? null,
    addressDetail: dto.addressDetail ?? null,
    latitude: dto.latitude ?? null,
    longitude: dto.longitude ?? null,
    isLocationApplied: dto.isLocationApplied,
  };
}

/** 좌표는 주소 검색이 함께 채운다 — 하나만 있는 좌표는 위치로 쓸 수 없다. */
function assertCoordinatePair(dto: SaveStoreDto): void {
  if ((dto.latitude == null) !== (dto.longitude == null))
    throw new BadRequestException('위도 · 경도는 함께 넣거나 함께 비웁니다');
}

/** 저장할 층 줄. 모든 칸이 빈 줄은 버린다 — 화면의 빈 입력 줄이 빈 행과 「 / 」 이력이 되지 않게. */
function filledFloors(floors: StoreFloorInputDto[]) {
  return floors
    .map(floorFields)
    .filter((f) => Object.values(f).some((v) => v !== null));
}

/** DTO 가 날짜를 검사했지만, DTO 를 거치지 않은 호출이 조용히 null 을 넘기지 않게 막는다. */
function dateOrThrow(raw: string): Date {
  const date = parseDateOnly(raw);
  if (!date) throw new BadRequestException('개업일자는 YYYY-MM-DD 입니다');
  return date;
}

function stackOf(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function isUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return isPrismaError(error, 'P2002');
}

function isPrismaError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

function floorFields(f: StoreFloorInputDto) {
  return {
    floorTypeCode: f.floorTypeCode ?? null,
    floorNumber: f.floorNumber ?? null,
    floorAreaPyeong: f.floorAreaPyeong ?? null,
    floorAreaSqm: f.floorAreaSqm ?? null,
    seatCount: f.seatCount ?? null,
  };
}

/**
 * 저장할 사업자정보. 직접 넣는 칸은 화면 값, 번호 · 대표자명 · 개업일자 · 인증일시는 이번에 인증했으면 그 값,
 * 아니면 저장된 값 그대로다.
 */
function profileFields(
  dto: SaveStoreDto,
  identity: BusinessIdentity | null,
  saved: ProfileRow | null = null,
) {
  const b = dto.business ?? {};
  return {
    bizTradeName: b.tradeName ?? null,
    bizCeoPhone: b.ceoPhone ?? null,
    bizZipCode: b.zipCode ?? null,
    bizAddress: b.address ?? null,
    bizAddressDetail: b.addressDetail ?? null,
    bizCategory: b.category ?? null,
    bizItem: b.item ?? null,
    bizRegistrationNumber:
      identity?.bizRegistrationNumber ?? saved?.bizRegistrationNumber ?? null,
    bizCeoName: identity?.ceoName ?? saved?.bizCeoName ?? null,
    bizOpenDate: identity?.openDate ?? saved?.bizOpenDate ?? null,
    bizVerifiedAt: identity ? new Date() : (saved?.bizVerifiedAt ?? null),
  };
}

function profileHistory(
  saved: ProfileRow | null,
  next: ReturnType<typeof profileFields>,
): History[] {
  const s = saved;
  return [
    change('상호명', s?.bizTradeName ?? null, next.bizTradeName),
    change('대표자 연락처', s?.bizCeoPhone ?? null, next.bizCeoPhone),
    change(
      '사업자주소',
      addressOf(
        s?.bizZipCode ?? null,
        s?.bizAddress ?? null,
        s?.bizAddressDetail ?? null,
      ),
      addressOf(next.bizZipCode, next.bizAddress, next.bizAddressDetail),
    ),
    change('업태', s?.bizCategory ?? null, next.bizCategory),
    change('종목', s?.bizItem ?? null, next.bizItem),
    change(
      '사업자등록번호',
      s?.bizRegistrationNumber ?? null,
      next.bizRegistrationNumber,
    ),
    change('대표자명', s?.bizCeoName ?? null, next.bizCeoName),
    change(
      '개업일자',
      dateOnly(s?.bizOpenDate ?? null),
      dateOnly(next.bizOpenDate),
    ),
  ].filter((c): c is History => c !== null);
}

function identityOf(input: BusinessIdentityInputDto): BusinessIdentity {
  return {
    bizRegistrationNumber: input.bizRegistrationNumber,
    ceoName: input.ceoName,
    openDate: dateOrThrow(input.openDate),
  };
}

function verifiedKey(
  adminAccountId: number,
  identity: BusinessIdentity,
): string {
  return [
    adminAccountId,
    identity.bizRegistrationNumber,
    identity.ceoName,
    identity.openDate.toISOString(),
  ].join('|');
}

/** 다음 점포코드. 6자리를 다 쓰면 더 만들 수 없다. */
function nextStoreCode(last: string | null): string {
  const next = (last ? Number(last.slice(2)) : 0) + 1;
  if (next > 999_999)
    throw new ConflictException('점포코드를 더 만들 수 없습니다');
  return `ST${String(next).padStart(6, '0')}`;
}

async function record(
  tx: Tx,
  storeId: number,
  changedBy: number,
  changes: (History | null)[],
): Promise<void> {
  const until = retainEndDate();
  const data = changes
    .filter((c): c is History => c !== null)
    .map((c) => ({ storeId, ...c, changedBy, retainEndDate: until }));
  if (data.length) await tx.storeChangeHistory.createMany({ data });
}

function change(
  field: string,
  beforeValue: string | null,
  afterValue: string | null,
): History | null {
  return beforeValue === afterValue ? null : { field, beforeValue, afterValue };
}

function floorsText(floors: Parameters<typeof floorLabel>[0][]): string | null {
  return floors.length ? floors.map(floorLabel).join(' / ') : null;
}

function addressOf(
  zipCode: string | null,
  address: string | null,
  addressDetail: string | null,
): string | null {
  const text = [zipCode && `(${zipCode})`, address, addressDetail]
    .filter(Boolean)
    .join(' ');
  return text || null;
}

function coordinatesOf(latitude: unknown, longitude: unknown): string | null {
  if (latitude == null && longitude == null) return null;
  return `${numberOrNull(latitude) ?? '-'}, ${numberOrNull(longitude) ?? '-'}`;
}

function usedLabel(on: boolean): string {
  return on ? '사용' : '미사용';
}

function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}
