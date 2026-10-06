import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { EnumCatalogResponseDto } from './dto/enum.response.dto';
import { EnumsService } from './enums.service';

// 비로그인 홈(도입문의 관심 서비스 등)도 선택지를 그린다. 값과 한글뿐이라 감출 것이 없다.
@Public()
@Controller('enums')
export class EnumsController {
  constructor(private readonly enums: EnumsService) {}

  @Get()
  @ApiOkResponse({ type: EnumCatalogResponseDto })
  findAll(): EnumCatalogResponseDto {
    return this.enums.all();
  }

  @Get(':name')
  @ApiOkResponse({ type: EnumCatalogResponseDto })
  @ApiNotFoundResponse({ description: '그 이름의 enum 이 없다' })
  findOne(@Param('name') name: string): EnumCatalogResponseDto {
    return this.enums.one(name);
  }
}
