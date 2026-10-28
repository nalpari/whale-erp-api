import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ContractStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import {
  STORAGE,
  requireStorage,
  type OptionalStorage,
} from '../storage/storage.module';
import { statusConflict } from './contract-status';
import { MY_CONTRACT_NOT_FOUND, myContractWhere } from './my-contract-scope';

/** 처리 완료본(SIGNED_COPY)을 내주는 상태 — 체결 완료와, 체결 뒤 닫힌 종료. 서명 대기 · 수정 요청 · 거부 · 만료는 체결 전이다 */
const FINAL_COPY_STATUSES: readonly ContractStatus[] = ['SIGNED', 'ENDED'];

/**
 * 직원 앱의 근로계약 파일 내려받기 주소(WHALEERP-146 종이 계약 날인본 · 임금계약서, 149 처리 완료본). 관리자
 * 내려받기(ContractsService.documentDownloadUrl)와 같은 300초 서명 주소다.
 * - 계약은 상세와 같은 「내 계약」이다 — 아니면 상세와 같은 404 본문.
 * - 파일은 그 계약의 것이고 상세 `documents` 에 나오는 것뿐이다(직원 필기 서명 제외) — 아니면 404.
 * - 처리 완료본은 체결된 계약에서만 준다 — 그 밖의 상태면 지금 상태를 실은 409(CONTRACT_STATUS_CONFLICT).
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
    if (!contract) throw new NotFoundException(MY_CONTRACT_NOT_FOUND);
    const document = await this.prisma.contractDocument.findFirst({
      // 상세(MyContractViewsService.findOne)의 documents 와 같은 조건 — 필기 서명은 처리 완료본의 재료라 내주지 않는다
      where: { contractDocumentId, contractId, kind: { not: 'SIGNATURE' } },
      select: { kind: true, storageKey: true, fileName: true },
    });
    if (!document) throw new NotFoundException('파일을 찾을 수 없습니다');
    // where 가 「내 계약」 상태로 거른다 — status 가 비어 있는 행은 오지 않는다
    const status = contract.status!;
    if (
      document.kind === 'SIGNED_COPY' &&
      !FINAL_COPY_STATUSES.includes(status)
    )
      throw statusConflict(status);
    const storage = requireStorage(this.storage);
    return {
      url: await storage.downloadUrl(document.storageKey, document.fileName),
    };
  }
}
