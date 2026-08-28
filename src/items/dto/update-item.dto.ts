import { PartialType } from '@nestjs/swagger';
import { CreateItemDto } from './create-item.dto';

// 생성 DTO 의 검증(공백 거부, 길이, unit enum)을 그대로 물려받고 전부 선택으로
// 만든다. 규칙을 복사하면 두 곳이 어긋난다.
export class UpdateItemDto extends PartialType(CreateItemDto) {}
