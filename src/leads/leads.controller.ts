import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadsService } from './leads.service';

/**
 * 홈의 도입문의 (S-SDMDKC). 로그인 없이 받으므로 같은 IP 는 시간당 5건까지다(Plane #295).
 * 검증보다 가드가 먼저 돌아 형식이 틀린 요청도 한 건으로 센다. 계정 축은 로그인용 한도라
 * 뺀다 — 같은 이메일 · 전화번호의 10분 제한은 서비스가 DB 로 본다.
 */
@Public()
@UseGuards(ThrottlerGuard)
@Throttle({ ip: { limit: 5, ttl: 3_600_000 } })
@SkipThrottle({ account: true })
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  /** 도입문의 접수. 본문 없이 201 을 돌려준다 — 문의자가 상태를 조회하는 화면은 없다. */
  @Post()
  @ApiTooManyRequestsResponse({
    description:
      '같은 IP 의 시간당 한도, 또는 같은 전화번호·이메일로 10분 안에 다시 접수',
  })
  create(@Body() dto: CreateLeadDto): Promise<void> {
    return this.leads.create(dto);
  }
}
