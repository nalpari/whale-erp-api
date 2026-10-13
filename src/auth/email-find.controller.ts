import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from './auth.decorators';
import { EmailFindDto } from './dto/email-find.dto';
import {
  EmailFindResponseDto,
  EmailFindTooManyRequestsResponseDto,
} from './dto/email-find.response.dto';
import { EmailFindService } from './email-find.service';

// 로그인 전에 닿는 경로다. 로그인과 같은 두 축의 요청 제한을 건다 — IP, 그리고 계정 축은 이메일 대신 넣은
// 휴대전화번호(throttle.ts).
@UseGuards(ThrottlerGuard)
@Controller('auth/account')
export class EmailFindController {
  constructor(private readonly emailFind: EmailFindService) {}

  /**
   * 이름 · 휴대전화번호 · 생년월일로 로그인 이메일을 찾는다(WHALEERP-178). 계정의 본인인증 값과 모두 맞으면
   * 가린 이메일 목록을 준다. 찾은 이메일을 메일이나 문자로 보내지 않는다.
   *
   * 맞는 계정이 없으면 어느 값이 틀렸든 같은 메시지의 404 다. 같은 휴대전화번호로 5번 틀리면 5분 동안 막히고,
   * 막힌 동안은 값이 맞아도 429 와 해제 시각(`lockExpiresAt`)을 준다. 풀리거나 성공하면 횟수는 0 이 된다.
   */
  @ApiBadRequestResponse({
    description:
      '이름이 비었거나 · 휴대전화번호가 숫자 10~11자리가 아니거나(하이픈 · 공백은 지운 뒤) · 생년월일이 YYYY-MM-DD 의 있는 날짜가 아니거나 · 모르는 칸이 있음. 번호 잠금의 실패로는 세지 않는다(요청 제한에는 센다)',
  })
  @ApiNotFoundResponse({
    description:
      '맞는 계정이 없음. 어느 값이 틀렸든 같은 메시지(「일치하는 계정이 없습니다」)이고 실패 1회로 센다',
  })
  @ApiTooManyRequestsResponse({
    description:
      '`lockExpiresAt` 이 있으면 그 번호가 5번 틀려 그때까지 막힘(값이 맞아도), 없으면 요청 제한',
    type: EmailFindTooManyRequestsResponseDto,
  })
  @Public()
  @Post('email-find-attempts')
  @HttpCode(HttpStatus.OK)
  async find(@Body() dto: EmailFindDto): Promise<EmailFindResponseDto> {
    return { emails: await this.emailFind.find(dto) };
  }
}
