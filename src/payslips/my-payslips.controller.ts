import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProduces,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
import {
  MyPayslipDetailResponseDto,
  MyPayslipListResponseDto,
} from './dto/my-payslip.response.dto';
import { MyPayslipListQueryDto } from './dto/my-payslip-list.query.dto';
import { MyPayslipsService } from './my-payslips.service';
import { PAYSLIP_NOT_FOUND_MESSAGE } from './payslip-menu';
import {
  contentDisposition,
  payslipPdfFileName,
  payslipPdfModel,
  renderPayslipPdf,
} from './payslip-pdf';

/**
 * 직원 근무 앱의 내 급여명세서 (WHALEERP-330). 로그인한 직원에게 발송된 명세서만, 만든 날부터 3년 동안 —
 * 퇴직한 뒤에도(PAY-4). 관리자 토큰은 403.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '직원 근무 앱 토큰이 아님' })
@UserTypes('account')
@Controller('me/payslips')
export class MyPayslipsController {
  constructor(private readonly payslips: MyPayslipsService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: MyPayslipListQueryDto,
  ): Promise<MyPayslipListResponseDto> {
    return this.payslips.list(user.id, query);
  }

  @Get(':id')
  @ApiNotFoundResponse({
    description:
      '없는 명세서 · 남의 명세서 · 발송 전 · 보존 기간(3년) 지남 · ID 형식 오류',
  })
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<MyPayslipDetailResponseDto> {
    const id = parseRouteId(rawId);
    const item = id && (await this.payslips.findOne(user.id, id));
    if (!item) throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
    return item;
  }

  /**
   * 명세서 내보내기(PAY-2) — 상세와 같은 조건(본인 · 발송 완료 · 3년)의 명세서를 A4 PDF 로 내려준다. 파일 이름은
   * `급여명세서_YYYY-MM_이름.pdf`(filename*), 한글을 못 읽는 곳에는 `payslip_YYYY-MM_id.pdf`(filename).
   */
  @Get(':id/pdf')
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: '급여명세서 PDF(attachment)',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiNotFoundResponse({
    description:
      '없는 명세서 · 남의 명세서 · 발송 전 · 보존 기간(3년) 지남 · ID 형식 오류',
  })
  // 급여가 담긴 파일이다 — 공유 캐시 · 브라우저 캐시에 남기지 않는다
  @Header('Cache-Control', 'private, no-store')
  async pdf(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<StreamableFile> {
    const id = parseRouteId(rawId);
    const found = id && (await this.payslips.document(user.id, id));
    if (!found) throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
    const pdf = await renderPayslipPdf(
      payslipPdfModel(found.detail, found.staffName),
    );
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      length: pdf.length,
      disposition: contentDisposition(
        payslipPdfFileName(found.detail, found.staffName),
      ),
    });
  }
}
