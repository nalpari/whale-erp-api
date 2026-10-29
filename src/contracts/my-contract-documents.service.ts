import {
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ContractStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import {
  STORAGE,
  requireStorage,
  type OptionalStorage,
} from '../storage/storage.module';
import { MY_CONTRACT_NOT_FOUND, myContractWhere } from './my-contract-scope';

/**
 * 직원 앱의 근로계약 파일 내려받기 주소(WHALEERP-146 종이 계약 날인본 · 임금계약서, 149 처리 완료본). 관리자
 * 내려받기(ContractsService.documentDownloadUrl)와 같은 300초 서명 주소다.
 * - 계약은 상세와 같은 「내 계약」이다 — 아니면 상세와 같은 404 본문.
 * - 파일은 그 계약의 것이고 상세 `documents` 에 나오는 것뿐이다(직원 필기 서명 제외) — 아니면 404.
 * - 처리 완료본은 체결된 계약에서만 준다 — 체결 완료(SIGNED)와, 체결 완료에서 닫힌 종료(SIGNED → ENDED 이력). 종료는 날인 전
 *   (임시저장 · 발송 대기 · 서명 대기 · 수정 요청)에서도 들어오므로 상태만으로 보지 않는다(PR 전 리뷰). 그 밖이면 지금 상태를
 *   실은 409(CONTRACT_STATUS_CONFLICT). 체결 완료를 누가 닫았는지(시스템 · 관리자 대체)는 보지 않는다.
 * - 404 · 409 를 먼저 가리고 저장소 설정은 그 뒤에 본다(설정 없으면 503).
 */
@Injectable()
export class MyContractDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  async downloadUrl(
    accountId: number,
    contractId: number,
    contractDocumentId: number,
  ): Promise<DownloadUrlResponseDto> {
    const contract = await this.prisma.contract.findFirst({
      where: { contractId, ...myContractWhere(accountId) },
      select: { status: true },
    });
    // where 가 「내 계약」 상태로 거른다 — 상태가 빈 행은 오지 않지만, 오면 내 계약이 아닌 것과 같다
    if (!contract?.status) throw new NotFoundException(MY_CONTRACT_NOT_FOUND);
    const document = await this.prisma.contractDocument.findFirst({
      // 상세(MyContractViewsService.findOne)의 documents 와 같은 조건 — 필기 서명은 처리 완료본의 재료라 내주지 않는다
      where: { contractDocumentId, contractId, kind: { not: 'SIGNATURE' } },
      select: { kind: true, storageKey: true, fileName: true },
    });
    if (!document) throw new NotFoundException('파일을 찾을 수 없습니다.');
    const { status } = contract;
    if (
      document.kind === 'SIGNED_COPY' &&
      !(await this.executed(contractId, status))
    )
      // 전이 거절(statusConflict)과 같은 code · status 지만, 「새로 고쳐 상태를 확인」은 내려받기에 맞지 않아 문구만 바꾼다
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'CONTRACT_STATUS_CONFLICT',
        message: '처리 완료본은 체결이 끝난 근로계약에서만 받을 수 있습니다.',
        status,
      });
    const storage = requireStorage(this.storage);
    return {
      url: await storage.downloadUrl(document.storageKey, document.fileName),
    };
  }

  /**
   * 체결된 계약인가 — 체결 완료이거나, 체결 완료에서 종료로 닫혔다. 이력이 아예 없는 옛 종료 계약은 체결된 것으로 본다(관리자 상세의
   * 종이 계약 등록일과 같은 기준, ContractsService). 저장소의 다른 「체결」 판정(SIGNED_ONCE · contractCovers)과 기준이 조금 다르다 —
   * 묶는 것은 열린 계약 PR 들과 겹쳐 후속으로 둔다.
   */
  private async executed(
    contractId: number,
    status: ContractStatus,
  ): Promise<boolean> {
    if (status === 'SIGNED') return true;
    if (status !== 'ENDED') return false;
    const history = await this.prisma.contractStatusHistory.findMany({
      where: { contractId },
      select: { fromStatus: true, toStatus: true },
    });
    return (
      history.length === 0 ||
      history.some((h) => h.fromStatus === 'SIGNED' && h.toStatus === 'ENDED')
    );
  }
}
