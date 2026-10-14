import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { CodesService } from './codes.service';
import {
  CodeItemsQueryDto,
  PublicBpCodeParamDto,
} from './dto/code-items.query.dto';
import { CodeItemsResponseDto } from './dto/code-items.response.dto';

// 로그인 전 화면(BP 회원가입 · 도입문의 등)도 선택지를 그린다. 코드와 이름뿐이라 감출 것이 없다.
// 운영과 개발의 bpCodeId 가 달라 BP 코드로 받는다. 로그인 뒤 다른 BP 는 GET /bp-codes/{bpCodeId}/code-items,
// 로그인한 관리자 자기 BP 는 GET /auth/admin/login-info 에 담긴다.
@Public()
@Controller('public-bp-codes')
export class CodesController {
  constructor(private readonly codes: CodesService) {}

  /**
   * 그 BP 가 보는 공통코드. `groups` 를 주면 그 그룹만, 없으면 전체. 사용 중인 그룹 · 상세만, 표시 순서대로.
   * 부를 때의 현재 값이다 — 화면이 열릴 때 불러 쓴다.
   */
  @Get(':bpCode/code-items')
  @ApiOkResponse({ type: CodeItemsResponseDto })
  @ApiNotFoundResponse({ description: '없거나 삭제 · 탈퇴한 BP' })
  async findAll(
    @Param() { bpCode }: PublicBpCodeParamDto,
    @Query() { groups }: CodeItemsQueryDto,
  ): Promise<CodeItemsResponseDto> {
    return { codes: await this.codes.forLiveBp(bpCode, groups) };
  }
}
