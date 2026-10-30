import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Patch,
  Put,
  Query,
  UploadedFiles,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { AttachmentFileType } from '@prisma/client';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import type { AuthUser } from '../auth/auth.types';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import {
  AttachmentFieldsInterceptor,
  assertUpload,
} from '../storage/upload-check';
import {
  ContractDetailDto,
  ContractListResponseDto,
} from './dto/contract.response.dto';
import { UpdateWorkerDto } from './dto/update-worker.dto';
import {
  CreateContractDto,
  CreatedContractResponseDto,
} from './dto/create-contract.dto';
import { MinimumWagesResponseDto } from './dto/minimum-wage.response.dto';
import { ListContractsQueryDto } from './dto/list-contracts-query.dto';
import { ContractIdPipe } from './contract-id.pipe';
import { ContractsService, type PaperDocument } from './contracts.service';
import {
  BP_FORBIDDEN_DESCRIPTION,
  BP_MISSING_DESCRIPTION,
  BP_NOT_FOUND_DESCRIPTION,
} from './contracts-swagger';

/** 종이 계약 날인본 칸. 근로계약서는 필수(서비스가 본다), 임금계약서는 선택. 칸마다 한 개, 하나에 10MB 까지. */
const PAPER_FIELDS = [
  { name: 'employmentContract', maxCount: 1 },
  { name: 'wageContract', maxCount: 1 },
] as const;
type PaperFiles = Partial<
  Record<
    (typeof PAPER_FIELDS)[number]['name'],
    { buffer: Buffer; size: number; originalname: string }[]
  >
>;

// multipart 의 data 칸(JSON)을 JSON 요청과 같은 규칙(AppModule 의 전역 ValidationPipe)으로 검사한다.
const bodyPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/** multipart 의 data 칸 — 근로계약서 본문 JSON. JSON 이 아니면 400, 칸 검사는 JSON 요청과 같다. */
async function parseContractData(raw: unknown): Promise<CreateContractDto> {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new BadRequestException(
      'data 칸에 근로계약서 내용을 JSON 으로 보내 주세요.',
    );
  return (await bodyPipe.transform(parsed, {
    type: 'body',
    metatype: CreateContractDto,
  })) as CreateContractDto;
}

/** 날인본 파일을 내용으로 검사해(PDF · JPG · PNG, 10MB) 서비스가 받는 모양으로 바꾼다. */
function paperDocuments(files: PaperFiles | undefined): PaperDocument[] {
  const allowed = Object.values(AttachmentFileType);
  const one = (
    kind: PaperDocument['kind'],
    list: PaperFiles[keyof PaperFiles],
  ): PaperDocument[] =>
    (list ?? []).map((f) => ({
      kind,
      fileName: f.originalname,
      buffer: f.buffer,
      fileType: assertUpload(f, allowed),
    }));
  return [
    ...one('PAPER_EMPLOYMENT_CONTRACT', files?.employmentContract),
    ...one('WAGE_CONTRACT', files?.wageContract),
  ];
}

const PAPER_BODY = {
  schema: {
    type: 'object',
    required: ['data', 'employmentContract'],
    properties: {
      data: {
        type: 'string',
        description:
          'CreateContractDto 의 JSON. contractMethod 는 PAPER, isTemporarySave 는 넣지 않는다',
      },
      employmentContract: {
        type: 'string',
        format: 'binary',
        description: '당사자가 모두 날인한 근로계약서(PDF · JPG · PNG, 10MB)',
      },
      wageContract: {
        type: 'string',
        format: 'binary',
        description: '따로 날인한 임금계약서(선택)',
      },
    },
  },
};

// 관리자 웹의 근로계약 관리. 관리자의 업무 범위(BP · 점포) 밖 계약은 없는 것과 같다(404) — ContractsService.
// 권한은 「근로계약 관리」(/contracts) 메뉴 권한을 가드가 먼저 본다(403, WHALEERP-592) — 조회 · 작성 · 수정 · 삭제.
// 임시저장 이어 쓰기(PUT)는 작성의 연장이라 작성 또는 수정 권한이다(관리자 웹 화면과 같다).
// 다루는 계약의 BP 는 가드가 X-Bp-Code-Id 로 정한다(`@TargetBp()`, WHALEERP-618) — BP · 가맹 계정은 소속 BP, 플랫폼 계정은
// 헤더로 고른 고객 BP 의 점포 전부다(헤더가 없으면 서비스가 400, 점포 정보 관리와 같다).
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: `근로계약 관리 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · ${BP_FORBIDDEN_DESCRIPTION}`,
})
// 본문 · 쿼리를 받는 경로는 자기 400 과 함께 다시 적는다 — 메서드의 설명이 클래스의 것을 덮는다.
@ApiBadRequestResponse({ description: BP_MISSING_DESCRIPTION })
@UserTypes('admin')
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @MenuPermission('read')
  @ApiOkResponse({ type: ContractListResponseDto })
  @ApiBadRequestResponse({
    description: `검색 조건 형식 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({ description: BP_NOT_FOUND_DESCRIPTION })
  list(
    @Query() query: ListContractsQueryDto,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<ContractListResponseDto> {
    return this.contracts.list(user.id, query, bp);
  }

  /**
   * 근로계약서 초안 저장 — 직원 레코드와 계약을 만들고 곧바로 보낸다(2026-10-19 재영). 계정이 없는 번호면 가입 초대
   * 알림톡과 발송 대기, 계정이 있는 번호면 소속 추가 확인 요청과 발송 대기(직원이 수락하면 서명 대기, WHALEERP-130). 임시저장은
   * 보내지 않는다.
   */
  @Post()
  @MenuPermission('create')
  @ApiCreatedResponse({ type: CreatedContractResponseDto })
  @ApiForbiddenResponse({
    description: `근로계약 관리 작성 권한 없음 · 대체하는데 권한 없음(진행 중 계약은 수정, 임시저장은 삭제 — 409 로 묻기 전에 403) · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · ${BP_FORBIDDEN_DESCRIPTION}`,
  })
  @ApiBadRequestResponse({
    description: `입력 오류 · 만 19세 미만 · 재계약 시작일이 직전 계약 시작일 다음 날보다 이름 · 종이 계약 등록이 아닌데 잘못 올린 계약 바로잡기 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({
    description: `근무지 점포가 없거나 폐점이거나 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  @ApiConflictResponse({
    description:
      '이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(같은 점포 진행 중 계약 — contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP(다른 점포 근무 시간 겹침, 초안 저장만) · 대체할 계약을 다른 요청이 먼저 고침 · SEND_PHONE_NOT_MOBILE(가입 초대인데 휴대폰 번호가 아님)',
  })
  @ApiServiceUnavailableResponse({
    description:
      '같은 번호의 다른 저장이 길어져 시간 초과(잠시 뒤 다시) · 가입 초대를 보낼 수 없음(직원 앱 주소 STAFF_APP_URL 없음, 대체 문자 발신번호 BIZPPURIO_SMS_FROM 없음, 가입 초대 템플릿 꺼짐 — 저장하지 않음)',
  })
  @ApiBadGatewayResponse({
    description:
      '저장했지만 가입 초대 알림톡이 실패(본문 contractId): SEND_FAILED(나가지 않아 보내기 직전으로 되돌림 — status, 새 계약 · 임시저장에서 넘긴 것은 임시저장) · SEND_UNCONFIRMED(접수 여부 모름 — 상세를 다시 읽을 것)',
  })
  create(
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.create(body, user.id, [], bp);
  }

  /**
   * 종이 계약 등록(CTR-23). 당사자가 모두 날인한 근로계약서(필수) · 임금계약서(선택) 파일과 근로계약서 내용(data,
   * JSON)을 multipart 한 번으로 받아 발송 · 날인 없이 체결 완료로 저장한다. 검사 · 대체 · 겹침 · 초대 유형 판별은
   * 초안 저장과 같다. 저장이 실패하면 올린 파일도 지운다.
   */
  @Post('paper')
  @MenuPermission('create')
  @UseInterceptors(AttachmentFieldsInterceptor(PAPER_FIELDS))
  @ApiConsumes('multipart/form-data')
  @ApiBody(PAPER_BODY)
  @ApiCreatedResponse({ type: CreatedContractResponseDto })
  @ApiForbiddenResponse({
    description: `근로계약 관리 작성 권한 없음 · 대체하는데 권한 없음(진행 중 계약은 수정, 임시저장은 삭제 — 409 로 묻기 전에 403) · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · ${BP_FORBIDDEN_DESCRIPTION}`,
  })
  @ApiBadRequestResponse({
    description: `입력 오류 · 만 19세 미만 · 근로계약서 날인본 없음 · 파일 종류 · 크기 · 개수 · 재계약 시작일이 직전 계약 시작일 다음 날보다 이름 · 잘못 올린 계약 바로잡기를 재계약과 함께 보냄 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({
    description: `근무지 점포가 없거나 폐점이거나 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  @ApiConflictResponse({
    description:
      '이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP · 대체할 계약을 다른 요청이 먼저 고침 · SIGNED_CONTRACT_OVERLAP(종이 계약 — 기간이 겹치는 체결 완료 계약, contracts 목록. 잘못 올린 계약이면 correctSignedContracts 와 그 id 를 모두 replaceContractIds 로) · RENEWAL_SIGNED_OVERLAP(종이 재계약이 직전 계약이 아닌 체결 완료와 겹침 — 바로잡기 없이 막음)',
  })
  @ApiServiceUnavailableResponse({
    description:
      '첨부파일 저장소가 설정되지 않음 · 저장소 오류 · 저장이 몰려 시간 초과(잠시 뒤 다시)',
  })
  async createPaper(
    @Body('data') data: unknown,
    @UploadedFiles() files: PaperFiles | undefined,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.create(
      await parseContractData(data),
      user.id,
      paperDocuments(files),
      bp,
    );
  }

  /**
   * 최저임금(공통코드 MINIMUM_WAGE) — 작성 · 이어 쓰기 화면이 시급 칸 도움말과 수습 중 시급 확인에 쓴다(WHALEERP-595).
   * 저장도 같은 값으로 다시 본다. `:contractId` 보다 먼저 둔다.
   */
  @Get('minimum-wages')
  @MenuPermission(['create', 'update'])
  @ApiOkResponse({ type: MinimumWagesResponseDto })
  async minimumWages(): Promise<MinimumWagesResponseDto> {
    return { items: await this.contracts.minimumWages() };
  }

  /** 작성 화면을 다시 채울 값 — 임시저장 이어 쓰기 */
  @Get(':contractId')
  @MenuPermission('read')
  @ApiOkResponse({ type: ContractDetailDto })
  @ApiNotFoundResponse({
    description: `없는 계약 · 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  findOne(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<ContractDetailDto> {
    return this.contracts.findOne(user.id, contractId, bp);
  }

  /**
   * 임시저장 이어 쓰기. 폼 전체를 다시 보낸다. isTemporarySave 를 빼면 초안 저장으로 넘어가 곧바로 보낸다(POST 와 같다).
   * 직원이 수정을 요청한 계약(수정 요청)도 고친다 — 고쳐 저장하면 곧바로 서명 대기 · 새 기한으로 다시 보내고(번호를 계정이
   * 없는 번호로 고쳤으면 가입 초대 · 발송 대기), 임시저장은 할 수 없다(400).
   */
  @Put(':contractId')
  @MenuPermission(['create', 'update'])
  @ApiOkResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({
    description: `입력 오류 · 만 19세 미만 · 수정 요청인데 임시저장 · 근무지 변경 · 가입한 직원의 번호 변경 · 재계약 시작일이 직전 계약 시작일 다음 날보다 이름 · 종이 계약 등록이 아닌데 잘못 올린 계약 바로잡기 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({
    description: `없는 계약 · 근무지 점포가 없거나 폐점 · 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  @ApiConflictResponse({
    description:
      '임시저장 · 수정 요청이 아님 · 이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP · 다른 요청이 먼저 고침 · SEND_PHONE_NOT_MOBILE(가입 초대인데 휴대폰 번호가 아님)',
  })
  @ApiServiceUnavailableResponse({
    description:
      '같은 번호의 다른 저장이 길어져 시간 초과(잠시 뒤 다시) · 가입 초대를 보낼 수 없음(직원 앱 주소 STAFF_APP_URL 없음, 대체 문자 발신번호 BIZPPURIO_SMS_FROM 없음, 가입 초대 템플릿 꺼짐 — 저장하지 않음)',
  })
  @ApiBadGatewayResponse({
    description:
      '저장했지만 가입 초대 알림톡이 실패(본문 contractId): SEND_FAILED(나가지 않아 보내기 직전으로 되돌림 — status, 새 계약 · 임시저장에서 넘긴 것은 임시저장) · SEND_UNCONFIRMED(접수 여부 모름 — 상세를 다시 읽을 것)',
  })
  @ApiForbiddenResponse({
    description: `근로계약 관리 권한 없음(임시저장 이어 쓰기는 작성, 수정 요청은 수정) · 대체하는데 권한 없음(진행 중 계약은 수정, 임시저장은 삭제 — 409 로 묻기 전에 403) · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 번호를 바꾸는데 점포 직원 관리 권한이 없음(동의로만 보이는 직원) · ${BP_FORBIDDEN_DESCRIPTION}`,
  })
  update(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.update(user.id, contractId, body, [], bp);
  }

  /**
   * 날인 전 당사자 정보 수정(WHALEERP-125 · 126, CTR-28). 발송 대기 · 서명 대기 · 수정 요청 계약의 이름 · 번호 · 생년월일 ·
   * 성별 · 외국인 여부를 고친다. 저장하면 곧바로 새 서명 기한으로 다시 보내고 앞서 나간 링크는 무효다 — 가입 초대면
   * 발송 대기, 앱으로 받는 직원이면 서명 대기.
   */
  @Patch(':contractId/worker')
  @MenuPermission('update')
  @ApiOkResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({
    description: `입력 오류 · 만 19세 미만 · 가입한 직원의 번호 변경 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({
    description: `없는 계약 · 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  @ApiConflictResponse({
    description:
      'CONTRACT_STATUS_CONFLICT(발송 대기 · 서명 대기 · 수정 요청이 아님) · 새 번호로 이 점포에 재직 중 · CONTRACT_IN_PROGRESS(새 번호의 같은 점포 진행 중 계약 — replaceContractIds 로 대체) · WORK_TIME_OVERLAP · 다른 요청이 먼저 고침 · SEND_PHONE_NOT_MOBILE(가입 초대인데 휴대폰 번호가 아님)',
  })
  @ApiForbiddenResponse({
    description: `근로계약 관리 수정 권한 없음 · 새 번호의 같은 점포 임시저장을 대체하는데 삭제 권한 없음(409 로 묻기 전에 403) · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 번호를 바꾸는데 점포 직원 관리 권한이 없음(동의로만 보이는 직원) · ${BP_FORBIDDEN_DESCRIPTION}`,
  })
  @ApiServiceUnavailableResponse({
    description:
      '같은 번호의 다른 저장이 길어져 시간 초과(잠시 뒤 다시) · 가입 초대를 보낼 수 없음(직원 앱 주소 STAFF_APP_URL 없음, 대체 문자 발신번호 BIZPPURIO_SMS_FROM 없음, 가입 초대 템플릿 꺼짐 — 저장하지 않음)',
  })
  @ApiBadGatewayResponse({
    description:
      '저장했지만 가입 초대 알림톡이 실패(본문 contractId): SEND_FAILED(나가지 않아 보내기 직전으로 되돌림 — status, 새 계약 · 임시저장에서 넘긴 것은 임시저장) · SEND_UNCONFIRMED(접수 여부 모름 — 상세를 다시 읽을 것)',
  })
  updateWorker(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() body: UpdateWorkerDto,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.updateWorker(user.id, contractId, body, bp);
  }

  /** 임시저장을 이어 써서 종이 계약으로 등록한다. 받는 것 · 하는 일은 POST /contracts/paper 와 같다 */
  @Put(':contractId/paper')
  @MenuPermission(['create', 'update'])
  @UseInterceptors(AttachmentFieldsInterceptor(PAPER_FIELDS))
  @ApiConsumes('multipart/form-data')
  @ApiBody(PAPER_BODY)
  @ApiOkResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({
    description: `입력 오류 · 만 19세 미만 · 근로계약서 날인본 없음 · 파일 종류 · 크기 · 개수 · 재계약 시작일이 직전 계약 시작일 다음 날보다 이름 · 잘못 올린 계약 바로잡기를 재계약과 함께 보냄 · ${BP_MISSING_DESCRIPTION}`,
  })
  @ApiNotFoundResponse({
    description: `없는 계약 · 근무지 점포가 없거나 폐점 · 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  @ApiConflictResponse({
    description:
      '임시저장이 아님 · 이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP · 다른 요청이 먼저 고침 · SIGNED_CONTRACT_OVERLAP(종이 계약 — 기간이 겹치는 체결 완료 계약, contracts 목록. 잘못 올린 계약이면 correctSignedContracts 와 그 id 를 모두 replaceContractIds 로) · RENEWAL_SIGNED_OVERLAP(종이 재계약이 직전 계약이 아닌 체결 완료와 겹침 — 바로잡기 없이 막음)',
  })
  @ApiServiceUnavailableResponse({
    description:
      '첨부파일 저장소가 설정되지 않음 · 저장소 오류 · 저장이 몰려 시간 초과(잠시 뒤 다시)',
  })
  @ApiForbiddenResponse({
    description: `근로계약 관리 권한 없음(임시저장 이어 쓰기는 작성 — 수정 요청은 종이 계약으로 바꿀 수 없어 400) · 대체하는데 권한 없음(진행 중 계약은 수정, 임시저장은 삭제 — 409 로 묻기 전에 403) · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 번호를 바꾸는데 점포 직원 관리 권한이 없음(동의로만 보이는 직원) · ${BP_FORBIDDEN_DESCRIPTION}`,
  })
  async updatePaper(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body('data') data: unknown,
    @UploadedFiles() files: PaperFiles | undefined,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.update(
      user.id,
      contractId,
      await parseContractData(data),
      paperDocuments(files),
      bp,
    );
  }

  /** 종이 계약 날인본 내려받기 주소(300초). 받으면 원래 파일 이름으로 저장된다 */
  @Get(':contractId/documents/:contractDocumentId/download-url')
  @MenuPermission('read')
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiNotFoundResponse({
    description: `없는 계약 · 파일 · 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소가 설정되지 않음',
  })
  documentDownloadUrl(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Param('contractDocumentId', ContractIdPipe) contractDocumentId: number,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<DownloadUrlResponseDto> {
    return this.contracts.documentDownloadUrl(
      user.id,
      contractId,
      contractDocumentId,
      bp,
    );
  }

  /** 임시저장 삭제. 계약 · 근무 요일 · 당사자 · 이력과 그 계약에만 쓰인 초안 직원 레코드를 지운다 */
  @Delete(':contractId')
  @MenuPermission('delete')
  @HttpCode(204)
  @ApiNoContentResponse({ description: '지웠다' })
  @ApiNotFoundResponse({
    description: `없는 계약 · 업무 범위 밖 · ${BP_NOT_FOUND_DESCRIPTION}`,
  })
  @ApiConflictResponse({ description: '임시저장이 아님' })
  remove(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
  ): Promise<void> {
    return this.contracts.remove(user.id, contractId, bp);
  }
}
