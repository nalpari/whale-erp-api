import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { CodesService } from './codes.service';
import { CodeItemsQueryDto } from './dto/code-items.query.dto';
import { CodeItemsResponseDto } from './dto/code-items.response.dto';

// 로그인 전 화면(BP 회원가입 · 도입문의 등)도 선택지를 그린다. BP 는 서버가 플랫폼 BP 로 정한다 —
// BP 를 받으면 누구나 BP 코드를 바꿔 가며 다른 BP 의 BP전용 코드를 볼 수 있다. 로그인 뒤 다른 BP 는
// GET /bp-codes/{bpCodeId}/code-items, 로그인한 관리자 자기 BP 는 GET /auth/admin/login-info 에 담긴다.
@Public()
@Controller('public-code-items')
export class CodesController {
  constructor(private readonly codes: CodesService) {}

  /**
   * 플랫폼 BP 의 공통코드. `groups` 를 주면 그 그룹만, 없으면 전체. 사용 중인 그룹 · 상세만, 표시 순서대로.
   * 부를 때의 현재 값이다 — 화면이 열릴 때 불러 쓴다.
   */
  @Get()
  @ApiOkResponse({ type: CodeItemsResponseDto })
  async findAll(
    @Query() { groups }: CodeItemsQueryDto,
  ): Promise<CodeItemsResponseDto> {
    return { codes: await this.codes.forPlatform(groups) };
  }
}
