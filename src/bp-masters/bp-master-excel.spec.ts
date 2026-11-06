import ExcelJS from 'exceljs';
import {
  BP_MASTER_EXCEL_COLUMNS,
  type BpMasterExcelRow,
  buildBpMasterWorkbook,
  bpMasterExcelFileName,
} from './bp-master-excel';

const ROW: BpMasterExcelRow = {
  bpCode: 'BP000003',
  tradeName: '모리커피',
  loginId: 'mori',
  name: '김마스터',
  phone: '01012345678',
  email: 'mori@example.com',
  accountStatus: 'ACTIVE',
  bizRegistrationNumber: '1234567890',
  joinPath: 'SIGNUP',
  createdAt: new Date('2026-10-01T15:30:00Z'),
};

async function loadSheet(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook.worksheets[0];
}

async function lineOf(row: BpMasterExcelRow): Promise<Record<string, unknown>> {
  const sheet = await loadSheet(await buildBpMasterWorkbook([row]));
  const values = (sheet.getRow(2).values as unknown[]).slice(1);
  return Object.fromEntries(
    BP_MASTER_EXCEL_COLUMNS.map((c, i) => [c.header, values[i]]),
  );
}

describe('bpMasterExcelFileName', () => {
  it('한국 날짜로 이름을 짓는다', () => {
    expect(bpMasterExcelFileName(new Date('2026-10-14T15:30:00Z'))).toBe(
      'BP목록_20261015.xlsx',
    );
  });
});

describe('buildBpMasterWorkbook', () => {
  it('열은 화면 표와 같은 10개, 같은 순서다', () => {
    expect(BP_MASTER_EXCEL_COLUMNS.map((c) => c.header)).toEqual([
      'BP 코드',
      '상호명',
      '아이디',
      '이름',
      '계정상태',
      '연락처',
      '이메일',
      '사업자등록번호',
      '가입경로',
      '등록',
    ]);
  });

  it('BP 마다 한 줄 — 한글 표기, 연락처는 가운데 자리를 가리고, 등록은 한국 시각', async () => {
    expect(await lineOf(ROW)).toEqual({
      'BP 코드': 'BP000003',
      상호명: '모리커피',
      아이디: 'mori',
      이름: '김마스터',
      계정상태: '사용',
      연락처: '010-****-5678',
      이메일: 'mori@example.com',
      사업자등록번호: '123-45-67890',
      가입경로: '회원가입',
      등록: '2026-10-02 00:30',
    });
  });

  it('탈퇴 BP 는 이름 · 연락처 · 이메일이 「탈퇴로 삭제됨」', async () => {
    const line = await lineOf({
      ...ROW,
      accountStatus: 'WITHDRAWN',
      name: null,
      phone: null,
      email: null,
      joinPath: 'PLATFORM_REGISTERED',
    });
    expect(line).toMatchObject({
      이름: '탈퇴로 삭제됨',
      연락처: '탈퇴로 삭제됨',
      이메일: '탈퇴로 삭제됨',
      계정상태: '탈퇴',
      가입경로: '플랫폼등록',
    });
  });

  it('서식 — 모든 셀 9pt, 머리글은 회색 바탕 · 가운데 정렬 · 굵게, 1행 고정', async () => {
    const sheet = await loadSheet(await buildBpMasterWorkbook([ROW]));
    sheet.getRow(1).eachCell((cell) => {
      expect(cell.font).toMatchObject({ bold: true, size: 9 });
      expect(cell.fill).toMatchObject({
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF2F2F2' },
      });
      expect(cell.alignment).toMatchObject({
        horizontal: 'center',
        vertical: 'middle',
      });
    });
    sheet.getRow(2).eachCell((cell) => {
      expect(cell.font).toMatchObject({ size: 9 });
      // 본문은 칠하지 않는다 — 읽어 오면 pattern 'none' 이다
      expect(
        (cell.fill as ExcelJS.FillPattern | undefined)?.pattern ?? 'none',
      ).toBe('none');
    });
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('= 로 시작하는 값은 수식이 아니라 글자로 들어간다', async () => {
    const line = await lineOf({ ...ROW, tradeName: '=HYPERLINK("x")' });
    expect(line['상호명']).toBe('=HYPERLINK("x")');
  });
});
