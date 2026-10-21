import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import { signedInUserTracker } from '../auth/throttle';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { AttachmentFieldsInterceptor } from '../storage/upload-check';
import { ContractIdPipe } from './contract-id.pipe';
import {
  MyContractActionResponseDto,
  RejectMyContractDto,
  SignedMyContractResponseDto,
  SignMyContractDto,
} from './dto/my-contract-action.dto';
import {
  MyContractsService,
  SIGNATURE_MAX_BYTES,
} from './my-contracts.service';

type SignatureFiles = Partial<
  Record<'signature', { buffer: Buffer; size: number }[]>
>;

const NOT_MINE =
  '내 계약이 아님 — 없는 id · 남의 계약 · 임시저장 · 소속 추가 확인을 기다리는 계약(후보 계정만). 모두 같은 본문';
const STATE_CONFLICT =
  'CONTRACT_STATUS_CONFLICT(서명 대기가 아님 — 본문 status 에 지금 상태, 이미 처리했으면 그 결과) · SIGN_DEADLINE_PASSED(날인 기한이 지남)';

// 직원 앱의 근로계약 날인 · 거부 · 수정 요청(WHALEERP-145). 계약을 보여 주는 조회는 WHALEERP-610.
// 같은 계약을 여러 번 눌러도 두 번째는 409(지금 상태)라 앱은 status 로 결과를 안다.
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@ApiNotFoundResponse({ description: NOT_MINE })
@ApiTooManyRequestsResponse({ description: '계정마다 10분에 20번' })
@UseGuards(ThrottlerGuard)
@Throttle({
  account: { limit: 20, ttl: 600_000, getTracker: signedInUserTracker },
})
@UserTypes('account')
@Controller('me/contracts')
export class MyContractsController {
  constructor(private readonly contracts: MyContractsService) {}

  /**
   * 날인 — 서명 PNG(파일 칸 `signature`, 1MB)와 직원이 본 계약의 발송 일시(`sentAt`, 시간대 표기 필수). 날인 전에 계약서의 직원
   * 정보(이름 · 휴대전화번호 · 생년월일 · 성별 · 외국인 여부)를 가입 정보와 대조해, 다르면 409 IDENTITY_MISMATCH(mismatches)
   * — 직원은 수정 요청을 낸다. 계정 성별이 비어 있으면 성별은 보지 않는다.
   */
  @Post(':contractId/sign')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    AttachmentFieldsInterceptor(
      [{ name: 'signature', maxCount: 1 }],
      SIGNATURE_MAX_BYTES,
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['signature', 'sentAt'],
      properties: {
        signature: {
          type: 'string',
          format: 'binary',
          description: '필기 서명 이미지(PNG, 1MB)',
        },
        sentAt: {
          type: 'string',
          format: 'date-time',
          description:
            '직원이 본 계약의 발송 일시(시간대 표기 필수) — 다르면 409 CONTRACT_RESENT',
        },
      },
    },
  })
  @ApiOkResponse({ type: SignedMyContractResponseDto })
  @ApiBadRequestResponse({
    description:
      '서명 이미지 없음 · PNG 가 아님 · 1MB 넘음 · 읽을 수 없는 이미지 · 발송 일시 없음 · 형식 · 시간대 없음',
  })
  @ApiConflictResponse({
    description: `${STATE_CONFLICT} · IDENTITY_MISMATCH(mismatches: name · phone · birthDate · gender · isForeigner) · CONTRACT_RESENT(그사이 다시 발송됨)`,
  })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소가 설정되지 않음 · 저장소 오류',
  })
  sign(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() body: SignMyContractDto,
    @UploadedFiles() files: SignatureFiles | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SignedMyContractResponseDto> {
    return this.contracts.sign(
      user.id,
      contractId,
      files?.signature?.[0],
      body.sentAt,
    );
  }

  /** 거부 — 사유는 선택(500자) */
  @Post(':contractId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: MyContractActionResponseDto })
  @ApiBadRequestResponse({ description: '사유 500자 넘음 · null' })
  @ApiConflictResponse({ description: STATE_CONFLICT })
  reject(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() body: RejectMyContractDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MyContractActionResponseDto> {
    return this.contracts.reject(user.id, contractId, body.reason);
  }

  /** 수정 요청 — 계약서가 틀렸을 때(대조 결과와 상관없이). 따로 받는 내용은 없다 */
  @Post(':contractId/correction-request')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: MyContractActionResponseDto })
  @ApiConflictResponse({ description: STATE_CONFLICT })
  requestCorrection(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<MyContractActionResponseDto> {
    return this.contracts.requestCorrection(user.id, contractId);
  }
}
