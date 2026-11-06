import type ExcelJS from 'exceljs';

/** 목록 엑셀 공통 서식의 글자 크기 — 엑셀 글자 크기 단위는 pt 다(사용자가 말한 「9px」를 9pt 로 본다, 2026-11-06). */
export const EXCEL_FONT_SIZE = 9;
/** 글꼴 이름도 적는다 — 크기만 주면 styles.xml 의 글꼴에 이름이 없어 LibreOffice · Numbers 가 다른 글꼴로 보일 수 있다 */
export const EXCEL_FONT_NAME = 'Calibri';
/** 머리글 바탕 — 엑셀의 「흰색, 배경 1, 5% 더 어둡게」 */
export const EXCEL_HEADER_FILL = 'FFF2F2F2';

/**
 * 목록 엑셀의 공통 서식 — 모든 셀 9pt, 머리글(1행)은 굵게 · 회색 바탕 · 가로세로 가운데. 본문 정렬은 그대로 둔다.
 * 행을 다 넣은 뒤 부른다. 1행 고정은 시트를 만들 때(views) 따로 한다.
 */
export function styleListSheet(sheet: ExcelJS.Worksheet): void {
  sheet.eachRow((row, rowNumber) => {
    const isHeader = rowNumber === 1;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = {
        ...cell.font,
        name: EXCEL_FONT_NAME,
        size: EXCEL_FONT_SIZE,
        bold: isHeader,
      };
      if (!isHeader) return;
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: EXCEL_HEADER_FILL },
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  });
}
