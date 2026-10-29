import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import {
  TermsVersionDetailResponseDto,
  TermsVersionListResponseDto,
} from './dto/terms-version.response.dto';
import { TermsVersionsService } from './terms-versions.service';

// 회원가입 전에도, 로그인 화면 아래 약관 링크에서도 본다.
@Public()
@Controller('public-terms-versions')
export class TermsVersionsController {
  constructor(private readonly terms: TermsVersionsService) {}

  /** 지금 시행 중인 약관 유형마다 한 건, 공통코드 `TERMS_TYPE` 순서대로. 본문은 없다. */
  @Get()
  @ApiOkResponse({ type: TermsVersionListResponseDto })
  findAll(): Promise<TermsVersionListResponseDto> {
    return this.terms.findAll();
  }

  /** 그 유형의 지금 시행 중인 약관과 본문(Markdown). */
  @Get(':termsTypeCode')
  @ApiOkResponse({ type: TermsVersionDetailResponseDto })
  @ApiNotFoundResponse({
    description: '없거나 사용하지 않는 유형, 시행 중인 버전 없음',
  })
  async findOne(
    @Param('termsTypeCode') termsTypeCode: string,
  ): Promise<TermsVersionDetailResponseDto> {
    const terms = await this.terms.findOne(termsTypeCode);
    if (!terms) throw new NotFoundException('약관을 찾을 수 없습니다.');
    return terms;
  }
}
