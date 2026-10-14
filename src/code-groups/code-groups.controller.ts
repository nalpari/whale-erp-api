import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { CODE_PATTERN, toUpperCode } from './code-format';
import { CodeGroupsService } from './code-groups.service';
import {
  BpApplicationResponseDto,
  CodeGroupListResponseDto,
  CodeItemListResponseDto,
} from './dto/code-group.response.dto';
import { ListCodeGroupsDto } from './dto/list-code-groups.dto';
import { SaveCodeGroupsDto } from './dto/save-code-groups.dto';
import { SaveCodeItemsDto } from './dto/save-code-items.dto';

/**
 * 플랫폼 공통코드 관리 (S-UQPNIH). 관리자 웹의 플랫폼 관리자(PM · PA)만 쓴다.
 * 관리자 웹 로그인은 1팀이 만들 예정이라, 그 전까지는 이 경로를 부를 토큰이 없다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '플랫폼 관리자가 아님' })
@UserTypes('admin')
@Controller('code-groups')
export class CodeGroupsController {
  constructor(private readonly codes: CodeGroupsService) {}

  /** 공통코드 그룹 목록. 플랫폼고정 · 플랫폼제공 그룹을 표시 순서대로. */
  @Get()
  async listGroups(
    @CurrentUser() user: AuthUser,
    @Query() query: ListCodeGroupsDto,
  ): Promise<CodeGroupListResponseDto> {
    await this.codes.assertPlatformAdmin(user.id);
    return this.codes.listGroups(query);
  }

  /** 그룹 목록 패널 저장. 기존 그룹 수정(`updates`)과 새 그룹(`creates`)을 한 번에. */
  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '고칠 그룹이 없음' })
  @ApiConflictResponse({ description: '이미 있는 그룹 코드' })
  async saveGroups(
    @CurrentUser() user: AuthUser,
    @Body() body: SaveCodeGroupsDto,
  ): Promise<void> {
    await this.codes.assertPlatformAdmin(user.id);
    await this.codes.saveGroups(user.id, body);
  }

  /** 고른 그룹의 상세 코드(플랫폼 원본). BP전용 코드는 나오지 않는다. */
  @Get(':groupCode/items')
  @ApiNotFoundResponse({ description: '없는 그룹' })
  async listItems(
    @CurrentUser() user: AuthUser,
    @Param('groupCode') groupCode: string,
  ): Promise<CodeItemListResponseDto> {
    await this.codes.assertPlatformAdmin(user.id);
    return this.codes.listItems(groupCodeOf(groupCode));
  }

  /** 상세 코드 목록 패널 저장. 기존 코드 수정(`updates`)과 새 코드(`creates`)를 한 번에. */
  @Put(':groupCode/items')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 그룹 · 고칠 상세 코드가 없음' })
  @ApiConflictResponse({ description: '이 그룹에 이미 있는 상세 코드' })
  async saveItems(
    @CurrentUser() user: AuthUser,
    @Param('groupCode') groupCode: string,
    @Body() body: SaveCodeItemsDto,
  ): Promise<void> {
    await this.codes.assertPlatformAdmin(user.id);
    await this.codes.saveItems(user.id, groupCodeOf(groupCode), body);
  }

  /** BP에 적용. 플랫폼제공 그룹만. 각 BP 에 아직 없는 행만 넣는다 — 다시 눌러도 된다. */
  @Post(':groupCode/bp-application')
  @HttpCode(HttpStatus.OK)
  @ApiNotFoundResponse({ description: '없는 그룹' })
  @ApiConflictResponse({
    description:
      '플랫폼제공 그룹이 아님 · 상세 코드가 없음 · 사용 중인 고객 BP 가 없음',
  })
  async applyToBps(
    @CurrentUser() user: AuthUser,
    @Param('groupCode') groupCode: string,
  ): Promise<BpApplicationResponseDto> {
    await this.codes.assertPlatformAdmin(user.id);
    return this.codes.applyToBps(user.id, groupCodeOf(groupCode));
  }
}

/**
 * 경로의 그룹 코드도 본문과 같이 앞뒤 공백을 지우고 대문자로 받는다. 그래도 형식이 틀리면 있을 수 없는
 * 그룹이다 — DB 에 묻지 않고 404.
 */
function groupCodeOf(raw: string): string {
  const code = toUpperCode({ value: raw }) as string;
  if (!CODE_PATTERN.test(code))
    throw new NotFoundException('공통코드 그룹을 찾을 수 없습니다');
  return code;
}
