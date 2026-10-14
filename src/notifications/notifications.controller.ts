import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { NotificationDeleteQueryDto } from './dto/notification-delete.query.dto';
import {
  NotificationItemDto,
  NotificationListResponseDto,
  NotificationReadAllResponseDto,
} from './dto/notification-item.response.dto';
import { NotificationListQueryDto } from './dto/notification-list.query.dto';
import { NotificationIdPipe } from './notification-id.pipe';
import { NotificationsService } from './notifications.service';

/**
 * 관리자 웹 운영 알림함(WHALEERP-251 · 252). 직원 앱 토큰은 403. 늘 로그인한 관리자가 받은 알림만 다룬다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
})
@UserTypes('admin')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** 목록과 미확인 건수. 종 팝오버는 pageSize=5 로 부른다. */
  @ApiBadRequestResponse({ description: '쿼리 형식 오류' })
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationListQueryDto,
  ): Promise<NotificationListResponseDto> {
    return this.notifications.list(user.id, query);
  }

  /** 모두 읽음 */
  @Post('read-all')
  @HttpCode(200)
  readAll(
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationReadAllResponseDto> {
    return this.notifications.readAll(user.id);
  }

  /** 알림을 눌러 이동할 때 읽음으로 바꾸고, 갈 곳(관련 업무)을 담은 그 한 줄을 준다. */
  @ApiNotFoundResponse({ description: '내 알림이 아니거나 지운 알림' })
  @Post(':id/read')
  @HttpCode(200)
  read(
    @CurrentUser() user: AuthUser,
    @Param('id', NotificationIdPipe) id: number,
  ): Promise<NotificationItemDto> {
    return this.notifications.read(user.id, id);
  }

  /** 선택 삭제. 내 것이 아닌 ID 는 조용히 빠진다. */
  @ApiBadRequestResponse({ description: 'ids 형식 오류' })
  @ApiNoContentResponse()
  @Delete()
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationDeleteQueryDto,
  ): Promise<void> {
    return this.notifications.remove(user.id, query.ids);
  }
}
