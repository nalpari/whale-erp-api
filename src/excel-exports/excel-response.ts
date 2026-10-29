import { HttpStatus, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { contentDisposition } from '../storage/storage.service';
import type { ExcelScheduledResponseDto } from './dto/excel-export.response.dto';
import type { ExcelRequestResult } from './excel-exports.service';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const EXCEL_SCHEDULED_MESSAGE =
  '1만 건 이상이라 파일을 만든 뒤 알려 드립니다. 다 만들어지면 등록한 이메일로 내려받기 링크를 보냅니다. 링크는 다 만들어진 뒤 24시간 동안 요청한 본인만 쓸 수 있습니다.';

/**
 * 엑셀 요청 결과를 응답으로 — 파일이면 200 xlsx, 예약 생성이면 202 JSON. 화면 컨트롤러가 `@Res({ passthrough: true })` 로
 * 받은 응답 객체를 넘긴다(상태 코드만 바꾼다).
 */
export function excelResponse(
  result: ExcelRequestResult,
  res: Pick<Response, 'status'>,
): StreamableFile | ExcelScheduledResponseDto {
  if (result.kind === 'scheduled') {
    res.status(HttpStatus.ACCEPTED);
    return {
      excelDownloadId: result.excelDownloadId,
      rowCount: result.rowCount,
      message: EXCEL_SCHEDULED_MESSAGE,
    };
  }
  return new StreamableFile(result.buffer, {
    type: XLSX_CONTENT_TYPE,
    disposition: contentDisposition(result.fileName),
    length: result.buffer.length,
  });
}
