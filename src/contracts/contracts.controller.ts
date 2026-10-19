import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UploadedFiles,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import {
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
import {
  CreateContractDto,
  CreatedContractResponseDto,
} from './dto/create-contract.dto';
import { ListContractsQueryDto } from './dto/list-contracts-query.dto';
import { ContractIdPipe } from './contract-id.pipe';
import { ContractsService, type PaperDocument } from './contracts.service';

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
      'data 칸에 근로계약서 내용을 JSON 으로 보내 주세요',
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
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님(목록)',
})
@UserTypes('admin')
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @ApiOkResponse({ type: ContractListResponseDto })
  list(
    @Query() query: ListContractsQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ContractListResponseDto> {
    return this.contracts.list(user.id, query);
  }

  /** 근로계약서 초안 저장 — 미가입 직원 레코드와 발송 대기 계약을 만든다 */
  @Post()
  @ApiCreatedResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({ description: '입력 오류 · 만 19세 미만' })
  @ApiNotFoundResponse({
    description: '근무지 점포가 없거나 폐점이거나 업무 범위 밖',
  })
  @ApiConflictResponse({
    description:
      '이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(같은 점포 진행 중 계약 — contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP(다른 점포 근무 시간 겹침, 초안 저장만) · 대체할 계약을 다른 요청이 먼저 고침',
  })
  @ApiServiceUnavailableResponse({
    description: '같은 번호의 다른 저장이 길어져 시간 초과(잠시 뒤 다시)',
  })
  create(
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.create(body, user.id);
  }

  /**
   * 종이 계약 등록(CTR-23). 당사자가 모두 날인한 근로계약서(필수) · 임금계약서(선택) 파일과 근로계약서 내용(data,
   * JSON)을 multipart 한 번으로 받아 발송 · 날인 없이 체결 완료로 저장한다. 검사 · 대체 · 겹침 · 초대 유형 판별은
   * 초안 저장과 같다. 저장이 실패하면 올린 파일도 지운다.
   */
  @Post('paper')
  @UseInterceptors(AttachmentFieldsInterceptor(PAPER_FIELDS))
  @ApiConsumes('multipart/form-data')
  @ApiBody(PAPER_BODY)
  @ApiCreatedResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({
    description:
      '입력 오류 · 만 19세 미만 · 근로계약서 날인본 없음 · 파일 종류 · 크기 · 개수',
  })
  @ApiNotFoundResponse({
    description: '근무지 점포가 없거나 폐점이거나 업무 범위 밖',
  })
  @ApiConflictResponse({
    description:
      '이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP · 대체할 계약을 다른 요청이 먼저 고침',
  })
  @ApiServiceUnavailableResponse({
    description:
      '첨부파일 저장소가 설정되지 않음 · 저장소 오류 · 저장이 몰려 시간 초과(잠시 뒤 다시)',
  })
  async createPaper(
    @Body('data') data: unknown,
    @UploadedFiles() files: PaperFiles | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.create(
      await parseContractData(data),
      user.id,
      paperDocuments(files),
    );
  }

  /** 작성 화면을 다시 채울 값 — 임시저장 이어 쓰기 */
  @Get(':contractId')
  @ApiOkResponse({ type: ContractDetailDto })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  findOne(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<ContractDetailDto> {
    return this.contracts.findOne(user.id, contractId);
  }

  /** 임시저장 이어 쓰기. 폼 전체를 다시 보낸다. isTemporarySave 를 빼면 초안 저장(발송 대기)으로 넘어간다 */
  @Put(':contractId')
  @ApiOkResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({ description: '입력 오류 · 만 19세 미만' })
  @ApiNotFoundResponse({
    description: '없는 계약 · 근무지 점포가 없거나 폐점 · 업무 범위 밖',
  })
  @ApiConflictResponse({
    description:
      '임시저장이 아님 · 이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP · 다른 요청이 먼저 고침',
  })
  @ApiServiceUnavailableResponse({
    description: '같은 번호의 다른 저장이 길어져 시간 초과(잠시 뒤 다시)',
  })
  @ApiForbiddenResponse({
    description:
      '직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 번호를 바꾸는데 점포 직원 관리 권한이 없음(동의로만 보이는 직원)',
  })
  update(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.update(user.id, contractId, body);
  }

  /** 임시저장을 이어 써서 종이 계약으로 등록한다. 받는 것 · 하는 일은 POST /contracts/paper 와 같다 */
  @Put(':contractId/paper')
  @UseInterceptors(AttachmentFieldsInterceptor(PAPER_FIELDS))
  @ApiConsumes('multipart/form-data')
  @ApiBody(PAPER_BODY)
  @ApiOkResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({
    description:
      '입력 오류 · 만 19세 미만 · 근로계약서 날인본 없음 · 파일 종류 · 크기 · 개수',
  })
  @ApiNotFoundResponse({
    description: '없는 계약 · 근무지 점포가 없거나 폐점 · 업무 범위 밖',
  })
  @ApiConflictResponse({
    description:
      '임시저장이 아님 · 이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(contracts 목록: contractId · status · name · startDate · endDate, replaceContractIds 로 대체) · WORK_TIME_OVERLAP · 다른 요청이 먼저 고침',
  })
  @ApiServiceUnavailableResponse({
    description:
      '첨부파일 저장소가 설정되지 않음 · 저장소 오류 · 저장이 몰려 시간 초과(잠시 뒤 다시)',
  })
  @ApiForbiddenResponse({
    description:
      '직원 앱 토큰 · 사용 중인 관리자 계정이 아님 · 번호를 바꾸는데 점포 직원 관리 권한이 없음(동의로만 보이는 직원)',
  })
  async updatePaper(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body('data') data: unknown,
    @UploadedFiles() files: PaperFiles | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.update(
      user.id,
      contractId,
      await parseContractData(data),
      paperDocuments(files),
    );
  }

  /** 종이 계약 날인본 내려받기 주소(300초). 받으면 원래 파일 이름으로 저장된다 */
  @Get(':contractId/documents/:contractDocumentId/download-url')
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiNotFoundResponse({ description: '없는 계약 · 파일 · 업무 범위 밖' })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소가 설정되지 않음',
  })
  documentDownloadUrl(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Param('contractDocumentId', ContractIdPipe) contractDocumentId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<DownloadUrlResponseDto> {
    return this.contracts.documentDownloadUrl(
      user.id,
      contractId,
      contractDocumentId,
    );
  }

  /** 임시저장 삭제. 계약 · 근무 요일 · 당사자 · 이력과 그 계약에만 쓰인 초안 직원 레코드를 지운다 */
  @Delete(':contractId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: '지웠다' })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  @ApiConflictResponse({ description: '임시저장이 아님' })
  remove(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.contracts.remove(user.id, contractId);
  }
}
