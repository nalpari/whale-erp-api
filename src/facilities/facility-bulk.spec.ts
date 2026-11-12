import { dirname } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  BULK_EMPTY,
  BULK_HEADERS,
  BULK_MAX_ROWS,
  BULK_PREVIEW_COLUMNS,
  BULK_TEMPLATE_ONLY,
  BULK_CELL_TOO_LONG,
  BULK_TOO_COMPLEX,
  BULK_TOO_LARGE,
  BULK_TOO_MANY,
  BULK_UNREADABLE,
  assertZipWithinLimit,
  bulkErrorFileName,
  type BulkLookups,
  type BulkRawRow,
  buildBulkErrorFile,
  buildBulkTemplate,
  cellText,
  checkBulkRow,
  readBulkFile,
} from './facility-bulk';

const LOOKUPS: BulkLookups = {
  stores: new Map([
    [
      'ST000001',
      { storeId: 1, storeCode: 'ST000001', name: '강남점', isClosed: false },
    ],
    [
      'ST000002',
      { storeId: 2, storeCode: 'ST000002', name: '닫은점', isClosed: true },
    ],
  ]),
  statuses: [
    { code: 'OPERATING', label: '운영' },
    { code: 'STORED', label: '보관' },
    { code: 'DISPOSED', label: '폐기' },
  ],
  groups: [
    { code: 'STORE_FACILITY', label: '점포 시설물' },
    { code: 'STORE_EQUIPMENT', label: '점포 장비' },
  ],
  categories: {
    STORE_FACILITY: [{ code: 'HVAC', label: '냉난방' }],
    STORE_EQUIPMENT: [
      { code: 'GRINDER', label: '그라인더' },
      { code: 'ICE_MAKER', label: '제빙기' },
    ],
  },
  cycles: [
    { code: 'DAILY', label: '매일' },
    { code: 'MONTHLY', label: '매월' },
  ],
};

const LABELS: string[] = BULK_HEADERS.map((h) => h.label);

/** 양식 머리글 + 줄들로 xlsx 를 만든다. 줄은 칸 이름 → 값(엑셀 셀 값 그대로) */
async function xlsx(
  rows: Record<string, ExcelJS.CellValue>[],
  header: string[] = LABELS,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('시설물·장비');
  ws.addRow(header);
  for (const r of rows) ws.addRow(header.map((label) => r[label] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function raw(
  cells: Partial<Record<string, string>>,
  rowNumber = 2,
): BulkRawRow {
  const all = Object.fromEntries(
    BULK_HEADERS.map((h) => [h.key, cells[h.key] ?? '']),
  ) as BulkRawRow['cells'];
  return { rowNumber, cells: all };
}

const VALID = {
  store: 'ST000001',
  name: '제빙기 1호',
  status: '운영',
  group: '점포 장비',
  category: '제빙기',
};

/** 손으로 만드는 zip — 항목마다 deflate(8) · 저장(0) 등 압축 방식을 고른다 */
function zipOf(
  entries: { name: string; data: Buffer | string; method?: number }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** exceljs 가 쓰는 JSZip — 만든 xlsx 의 XML 을 고쳐 다시 묶는다(테스트 전용) */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const JSZip = require(
  require.resolve('jszip', { paths: [dirname(require.resolve('exceljs'))] }),
) as {
  loadAsync(data: Buffer): Promise<{
    file(name: string): { async(type: 'string'): Promise<string> } | null;
    file(name: string, data: string): unknown;
    remove(name: string): unknown;
    generateAsync(o: {
      type: 'nodebuffer';
      compression: 'DEFLATE';
    }): Promise<Buffer>;
  }>;
};

/** 정상 양식 xlsx 의 항목 하나를 고친다. rename 을 주면 그 이름으로 옮긴다 */
async function patched(
  entry: string,
  edit: (xml: string) => string,
  rename?: string,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await xlsx([VALIDCELLS()]));
  const xml = await zip.file(entry)!.async('string');
  if (rename) zip.remove(entry);
  zip.file(rename ?? entry, edit(xml));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).message;
  }
  throw new Error('거절되지 않았다');
}

// 올린 파일은 worker 스레드에서 읽는다(facility-bulk-reader) — 띄우는 데 1초 안팎이고 전체 테스트를 병렬로 돌리면 더 걸린다
jest.setTimeout(60_000);

describe('facility-bulk', () => {
  describe('양식 칸', () => {
    it('정책서 PL-7 의 24칸을 그 순서로 둔다(필수는 *, 첫 칸은 「점포*」 — 2026-11-12 사용자 결정)', () => {
      expect(LABELS).toEqual([
        '점포*',
        '시설물/장비명*',
        '운영상태*',
        '그룹*',
        '분류*',
        '브랜드',
        '제조사',
        'Serial number',
        '설치 위치',
        '구매처',
        '구매처 전화번호',
        '영업사원',
        '영업사원 전화번호',
        '단가',
        '수량',
        '부가세 포함(Y/N)',
        '구매일',
        '설치일',
        '메모',
        '사용 유효기한',
        '품질 보증기한',
        '점검 주기',
        '점검 비고',
        'A/S센터 전화번호',
      ]);
    });

    it('미리보기 열은 점포 · 그룹 · 분류 · 시설물/장비명 · 구매일 · 설치일', () => {
      expect(BULK_PREVIEW_COLUMNS.map((c) => c.label)).toEqual([
        '점포',
        '그룹',
        '분류',
        '시설물/장비명',
        '구매일',
        '설치일',
      ]);
    });
  });

  describe('cellText — 셀 값을 글자로', () => {
    it.each<[ExcelJS.CellValue, string]>([
      [null, ''],
      [undefined, ''],
      ['  가나 ', '  가나 '],
      [1500000, '1500000'],
      [true, 'TRUE'],
      [new Date(Date.UTC(2026, 10, 12)), '2026-11-12'],
      [{ richText: [{ text: '제빙' }, { text: '기' }] }, '제빙기'],
      [{ formula: 'A1', result: 3 }, '3'],
      [{ text: '링크', hyperlink: 'https://x' }, '링크'],
      [{ error: '#N/A' }, ''],
    ])('%p → %p', (value, text) => {
      expect(cellText(value)).toBe(text);
    });
  });

  describe('readBulkFile — 파일 검사', () => {
    it('xlsx 가 아니면 양식 문구로 400', async () => {
      expect(await rejection(readBulkFile(Buffer.from('a,b,c')))).toBe(
        BULK_TEMPLATE_ONLY,
      );
      // zip 서명만 있고 xlsx 가 아닌 것
      expect(
        await rejection(
          readBulkFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])),
        ),
      ).toBe(BULK_TEMPLATE_ONLY);
    });

    it('머리글이 양식과 다르면 400', async () => {
      const wrong = [...LABELS];
      wrong[1] = '이름';
      expect(await rejection(readBulkFile(await xlsx([VALID], wrong)))).toBe(
        BULK_TEMPLATE_ONLY,
      );
      expect(
        await rejection(readBulkFile(await xlsx([], LABELS.slice(0, 23)))),
      ).toBe(BULK_TEMPLATE_ONLY);
    });

    it('내용이 한 줄도 없으면 400 — 빈 줄 · 공백만 있는 줄은 세지 않는다', async () => {
      expect(await rejection(readBulkFile(await xlsx([])))).toBe(BULK_EMPTY);
      expect(
        await rejection(readBulkFile(await xlsx([{}, { '점포*': '   ' }, {}]))),
      ).toBe(BULK_EMPTY);
    });

    it('공백만 있는 줄도 방문한 행 수에 상한이 있다 — 1,000행을 넘으면 칸을 만들기 전에 500건 문구', async () => {
      // 빈 줄은 500줄에 세지 않지만 eachRow 는 방문한다 — 상한이 없으면 수만 줄 × 24칸 셀이 만들어진다(리뷰 실측 6만 줄 321MB)
      const blank = { '점포*': ' ' };
      expect(
        await rejection(
          readBulkFile(await xlsx(Array.from({ length: 1001 }, () => blank))),
        ),
      ).toBe(BULK_TOO_MANY);
      // 1,000행까지는 빈 줄로 넘긴다
      expect(
        await rejection(
          readBulkFile(await xlsx(Array.from({ length: 1000 }, () => blank))),
        ),
      ).toBe(BULK_EMPTY);
    });

    it(`${BULK_MAX_ROWS}줄까지 받고 넘으면 400`, async () => {
      const row = { '점포*': 'ST000001', '시설물/장비명*': 'a' };
      const ok = await readBulkFile(
        await xlsx(Array.from({ length: BULK_MAX_ROWS }, () => row)),
      );
      expect(ok.rows).toHaveLength(BULK_MAX_ROWS);
      expect(
        await rejection(
          readBulkFile(
            await xlsx(Array.from({ length: BULK_MAX_ROWS + 1 }, () => row)),
          ),
        ),
      ).toBe(BULK_TOO_MANY);
    });

    it('줄마다 엑셀 행 번호와 칸 글자를 준다 — 빈 줄은 건너뛰고 번호는 엑셀 그대로', async () => {
      const { rows } = await readBulkFile(
        await xlsx([
          { '점포*': ' ST000001 ', '시설물/장비명*': '제빙기' },
          {},
          { '점포*': 'ST000002', 단가: 1500000 },
        ]),
      );
      expect(rows.map((r) => r.rowNumber)).toEqual([2, 4]);
      expect(rows[0].cells.store).toBe(' ST000001 ');
      expect(rows[0].cells.name).toBe('제빙기');
      expect(rows[1].cells.unitPrice).toBe('1500000');
      expect(rows[1].cells.memo).toBe('');
    });

    it('숫자로 들어온 전화번호는 엑셀이 지운 앞 0 을 되살린다 — 0 을 붙여 국내 번호 꼴이 될 때만', async () => {
      const { rows } = await readBulkFile(
        await xlsx([
          {
            '점포*': 'ST000001',
            '구매처 전화번호': 1012345678,
            '영업사원 전화번호': '010-1234-5678',
            'A/S센터 전화번호': 21234567,
          },
          {
            '점포*': 'ST000001',
            // 대표번호 1588-1234 를 숫자로 — 0 을 붙이면 9자리가 돼 틀린 번호로 통과하므로 그대로 둔다
            '구매처 전화번호': 15881234,
            'A/S센터 전화번호': 212345678,
          },
        ]),
      );
      expect(rows[0].cells.vendorPhone).toBe('01012345678');
      expect(rows[0].cells.salesRepresentativePhone).toBe('010-1234-5678');
      expect(rows[0].cells.serviceCenterPhone).toBe('021234567');
      expect(rows[1].cells.vendorPhone).toBe('15881234');
      expect(rows[1].cells.serviceCenterPhone).toBe('0212345678');
    });

    it('먼 행에 공백 한 칸만 있는 작은 파일 — 빈 행을 만들며 돌지 않고 바로 「내용 없음」', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('시설물·장비');
      ws.addRow(LABELS);
      ws.getCell(1_048_576, 1).value = ' ';
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      expect(buffer.length).toBeLessThan(50_000);
      expect(await rejection(readBulkFile(buffer))).toBe(BULK_EMPTY);
    });

    it('압축을 푼 크기가 상한을 넘으면 읽기 전에 400', async () => {
      const buffer = await xlsx([VALIDCELLS()]);
      expect(
        await rejection(readBulkFile(buffer, { maxUncompressedBytes: 1_000 })),
      ).toBe(BULK_TOO_LARGE);
      await expect(
        readBulkFile(buffer, { maxUncompressedBytes: 10_000_000 }),
      ).resolves.toBeDefined();
    });

    it('오류 값 · 결과 없는 수식 · 값이 바뀐 Serial number 는 빈 칸이 아니라 그 칸의 사유가 된다', async () => {
      const { rows } = await readBulkFile(
        await xlsx([
          {
            ...VALIDCELLS(),
            단가: { error: '#N/A' },
            '시설물/장비명*': { formula: 'A1' },
            'Serial number': 123456789012345680,
          },
        ]),
      );
      expect(rows[0].problems).toEqual({
        unitPrice: '셀 값이 오류(#N/A)입니다. 값을 직접 적어 주세요.',
        name: '수식의 결과가 저장되지 않았습니다. 값으로 붙여 넣어 주세요.',
        serialNumber:
          '숫자로 저장돼 값이 바뀌었을 수 있습니다. 셀 서식을 텍스트로 바꿔 다시 적어 주세요.',
      });
      const r = checkBulkRow(rows[0], LOOKUPS);
      expect(r.isValid).toBe(false);
      // 필수 칸(이름)도 「입력해 주세요」를 더하지 않고 사유 하나, 칸 순서대로
      expect(r.errors).toEqual([
        '시설물/장비명: 수식의 결과가 저장되지 않았습니다. 값으로 붙여 넣어 주세요.',
        'Serial number: 숫자로 저장돼 값이 바뀌었을 수 있습니다. 셀 서식을 텍스트로 바꿔 다시 적어 주세요.',
        '단가: 셀 값이 오류(#N/A)입니다. 값을 직접 적어 주세요.',
      ]);
    });

    it('오류 값만 있는 줄도 빈 줄로 넘기지 않는다', async () => {
      const { rows } = await readBulkFile(
        await xlsx([{ 메모: { error: '#REF!' } }]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].problems?.memo).toBe(
        '셀 값이 오류(#REF!)입니다. 값을 직접 적어 주세요.',
      );
    });

    it('글자 서식을 덮어써 날짜 셀로 들어온 날짜도 그 날짜로 저장한다', async () => {
      const { rows } = await readBulkFile(
        await xlsx([
          {
            ...VALIDCELLS(),
            구매일: new Date(Date.UTC(2026, 0, 31)),
            설치일: new Date(Date.UTC(2026, 1, 1)),
          },
        ]),
      );
      const r = checkBulkRow(rows[0], LOOKUPS);
      expect(r.data?.purchaseDate).toEqual(new Date(Date.UTC(2026, 0, 31)));
      expect(r.data?.installationDate).toEqual(new Date(Date.UTC(2026, 1, 1)));
      expect(r.values.purchaseDate).toBe('2026-01-31');
    });

    it('수식 결과로 들어온 숫자 전화번호도 앞 0 을 되살린다', async () => {
      const { rows } = await readBulkFile(
        await xlsx([
          {
            ...VALIDCELLS(),
            '구매처 전화번호': {
              formula: 'B2',
              result: 1012345678,
            },
          },
        ]),
      );
      expect(rows[0].cells.vendorPhone).toBe('01012345678');
    });

    it('안전한 정수 안의 숫자 Serial number 는 그대로 받는다', async () => {
      const { rows } = await readBulkFile(
        await xlsx([{ ...VALIDCELLS(), 'Serial number': 20261112 }]),
      );
      expect(rows[0].problems).toBeUndefined();
      expect(checkBulkRow(rows[0], LOOKUPS).data?.serialNumber).toBe(
        '20261112',
      );
    });

    // Excel 은 숫자를 유효숫자 15자리까지만 저장한다 — 16자리부터는 2^53 안이어도 끝자리가 이미 바뀌었을 수 있다(PR #276 4차 리뷰)
    it('15자리 숫자 Serial number 는 받고, 16자리부터는 2^53 안이어도 사유가 된다', async () => {
      const { rows } = await readBulkFile(
        await xlsx([
          { ...VALIDCELLS(), 'Serial number': 999999999999999 },
          { ...VALIDCELLS(), 'Serial number': 1234567890123450 },
        ]),
      );
      expect(rows[0].problems).toBeUndefined();
      expect(checkBulkRow(rows[0], LOOKUPS).data?.serialNumber).toBe(
        '999999999999999',
      );
      expect(rows[1].problems).toEqual({
        serialNumber:
          '숫자로 저장돼 값이 바뀌었을 수 있습니다. 셀 서식을 텍스트로 바꿔 다시 적어 주세요.',
      });
    });

    it('첫 시트가 양식이 아니면(시트 순서를 바꿈) 양식 문구', async () => {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('점포 목록').addRow(['점포', '점포코드', '점포명']);
      const main = wb.addWorksheet('시설물·장비');
      main.addRow(LABELS);
      main.addRow(LABELS.map((l) => VALIDCELLS()[l] ?? null));
      expect(
        await rejection(readBulkFile(Buffer.from(await wb.xlsx.writeBuffer()))),
      ).toBe(BULK_TEMPLATE_ONLY);
    });

    it('zip 은 맞는데 exceljs 가 읽지 못하면 읽기 실패 문구(양식 문구가 아니다)', async () => {
      const buffer = zipOf([
        {
          name: '[Content_Types].xml',
          data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        },
        { name: 'xl/workbook.xml', data: '<workbook><<<깨진 XML' },
      ]);
      expect(await rejection(readBulkFile(buffer))).toBe(BULK_UNREADABLE);
    });

    it('오류 파일(끝에 「오류 사유」 열)을 고쳐 다시 올려도 받는다', async () => {
      const { rows } = await readBulkFile(
        await xlsx(
          [{ '점포*': 'ST000001', '오류 사유': '점포: …' }],
          [...LABELS, '오류 사유'],
        ),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('파싱 격리 — exceljs 는 메모리 · 시간 상한이 걸린 worker 에서 읽는다', () => {
    // 몇 KB 파일 하나로 exceljs 가 객체를 수천만 개 만들던 경로들(PR #276 재리뷰 재현). 프로세스는 살아 있고 400 이다
    const SHEET = 'xl/worksheets/sheet1.xml';
    const bombs: [string, () => Promise<Buffer>][] = [
      [
        '열 범위(<col max>) 폭탄',
        () =>
          patched(SHEET, (x) =>
            x.replace(
              '<sheetData>',
              '<cols><col min="1" max="30000000" width="9"/></cols><sheetData>',
            ),
          ),
      ],
      [
        '이름 정의(definedName) 범위 폭탄',
        () =>
          patched('xl/workbook.xml', (x) =>
            x.replace(
              '</workbook>',
              '<definedNames><definedName name="boom">\'시설물·장비\'!$A$1:$J$3000000</definedName></definedNames></workbook>',
            ),
          ),
      ],
      [
        '문자 참조로 정규식을 피한 병합 셀',
        () =>
          patched(SHEET, (x) =>
            x.replace(
              '</sheetData>',
              '</sheetData><mergeCells count="1"><mergeCell ref="A3&#58;X1048576"/></mergeCells>',
            ),
          ),
      ],
      [
        '= 앞뒤 공백으로 정규식을 피한 병합 셀',
        () =>
          patched(SHEET, (x) =>
            x.replace(
              '</sheetData>',
              '</sheetData><mergeCells count="1"><mergeCell ref = "A3:X1048576"/></mergeCells>',
            ),
          ),
      ],
    ];
    it.each(bombs)('%s → 400(자원 초과 문구)', async (_, make) => {
      expect(await rejection(readBulkFile(await make()))).toBe(
        BULK_TOO_COMPLEX,
      );
    });

    it('항목 이름 앞에 경로를 붙여 범위 검사를 피해도 400', async () => {
      const buffer = await patched(
        SHEET,
        (x) =>
          x.replace(
            '</sheetData>',
            '</sheetData><mergeCells count="1"><mergeCell ref="A3:X1048576"/></mergeCells>',
          ),
        'a/xl/worksheets/sheet1.xml',
      );
      const message = await rejection(readBulkFile(buffer));
      expect([BULK_TOO_COMPLEX, BULK_TEMPLATE_ONLY]).toContain(message);
    });

    it('빈 셀로 채운 시트(값이 없어 방문 상한에도 안 걸림)도 worker 의 메모리 상한에서 끝난다', async () => {
      const cells = '<c/>'.repeat(1000);
      const rows = Array.from(
        { length: 3500 },
        (_, i) => `<row r="${i + 3}">${cells}</row>`,
      ).join('');
      const buffer = await patched(SHEET, (x) =>
        x.replace('</sheetData>', `${rows}</sheetData>`),
      );
      const message = await rejection(readBulkFile(buffer));
      expect([BULK_TOO_COMPLEX, BULK_EMPTY]).toContain(message);
    });

    it('칸 글자가 1,000자를 넘으면 worker 는 내용 대신 표시만 보내고 그 칸의 사유가 된다', async () => {
      // 같은 공유 문자열을 여러 칸이 가리켜도 worker 안에선 하나지만, 메인으로 보내면 칸마다 복사된다(11KB 파일에 메인 heap 2.4GB)
      const long = '가'.repeat(5_000);
      const { rows } = await readBulkFile(
        await xlsx([
          { ...VALIDCELLS(), '시설물/장비명*': long, 메모: long },
          {
            ...VALIDCELLS(),
            브랜드: { richText: [{ text: long }] },
          },
        ]),
      );
      expect(rows[0].problems).toEqual({
        name: BULK_CELL_TOO_LONG,
        memo: BULK_CELL_TOO_LONG,
      });
      expect(rows[0].cells.name).toBe('');
      expect(rows[1].problems).toEqual({ brand: BULK_CELL_TOO_LONG });
      expect(checkBulkRow(rows[0], LOOKUPS).errors).toEqual([
        `시설물/장비명: ${BULK_CELL_TOO_LONG}`,
        `메모: ${BULK_CELL_TOO_LONG}`,
      ]);
    });

    it('칸마다는 1,000자 안이어도 보낼 글자가 모두 합해 너무 많으면 내용 과대로 400', async () => {
      const cell = 'a'.repeat(900);
      const row = Object.fromEntries(LABELS.map((l) => [l, cell]));
      const buffer = await xlsx(Array.from({ length: 480 }, () => row));
      expect(await rejection(readBulkFile(buffer))).toBe(BULK_TOO_LARGE);
    });

    it('정상 파일은 worker 에서 읽어 행을 돌려주고, 오류 파일도 worker 에서 만든다', async () => {
      const parsed = await readBulkFile(await xlsx([VALIDCELLS()]));
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].cells.store).toBe('ST000001');
      const out = await buildBulkErrorFile(parsed, new Map([[2, ['a: b']]]));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(out as unknown as ArrayBuffer);
      expect(wb.worksheets[0].getCell(2, 25).value).toBe('a: b');
    });
  });

  describe('assertZipWithinLimit — 압축 해제 상한', () => {
    it('실제로 풀리는 양을 센다 — 중앙 디렉터리의 크기를 속여도 걸린다', async () => {
      const buffer = await xlsx([VALIDCELLS()]);
      expect(() => assertZipWithinLimit(buffer, 10_000_000)).not.toThrow();
      expect(() => assertZipWithinLimit(buffer, 1_000)).toThrow(BULK_TOO_LARGE);
      // 중앙 디렉터리의 압축 해제 크기를 모두 1 로 바꾼다
      const forged = Buffer.from(buffer);
      for (let i = 0; i + 46 <= forged.length; i++)
        if (forged.readUInt32LE(i) === 0x02014b50)
          forged.writeUInt32LE(1, i + 24);
      expect(() => assertZipWithinLimit(forged, 1_000)).toThrow(BULK_TOO_LARGE);
    });

    it('앞에 바이트를 덧붙여 중앙 디렉터리 위치가 끝 레코드와 어긋나면 양식 문구(JSZip 이 옮겨 읽는 틈)', async () => {
      const buffer = await xlsx([VALIDCELLS()]);
      const shifted = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.alloc(64),
        buffer,
      ]);
      expect(() => assertZipWithinLimit(shifted, 10_000_000)).toThrow(
        BULK_TEMPLATE_ONLY,
      );
      // 중앙 디렉터리 뒤 끝 레코드 앞에 바이트가 끼어도
      const eocd = buffer.length - 22;
      const padded = Buffer.concat([
        buffer.subarray(0, eocd),
        Buffer.alloc(16),
        buffer.subarray(eocd),
      ]);
      expect(() => assertZipWithinLimit(padded, 10_000_000)).toThrow(
        BULK_TEMPLATE_ONLY,
      );
    });

    it('항목마다는 한도 안이어도 합이 넘으면 내용 과대 — 저장(0) · deflate(8) 모두 센다', () => {
      const part = Buffer.alloc(600, 0x41);
      expect(() =>
        assertZipWithinLimit(
          zipOf([
            { name: 'a', data: part },
            { name: 'b', data: part },
          ]),
          1_000,
        ),
      ).toThrow(BULK_TOO_LARGE);
      expect(() =>
        assertZipWithinLimit(
          zipOf([
            { name: 'a', data: part, method: 0 },
            { name: 'b', data: part, method: 0 },
          ]),
          1_000,
        ),
      ).toThrow(BULK_TOO_LARGE);
      expect(() =>
        assertZipWithinLimit(
          zipOf([{ name: 'a', data: part, method: 0 }]),
          1_000,
        ),
      ).not.toThrow();
    });

    it('저장 · deflate 밖의 압축 방식 · 항목 1,000개 초과 · zip64 표시는 양식 문구', () => {
      expect(() =>
        assertZipWithinLimit(
          zipOf([{ name: 'a', data: 'x', method: 12 }]),
          1_000,
        ),
      ).toThrow(BULK_TEMPLATE_ONLY);
      const many = zipOf(
        Array.from({ length: 1001 }, (_, i) => ({
          name: `f${i}`,
          data: '',
          method: 0,
        })),
      );
      expect(() => assertZipWithinLimit(many, 10_000_000)).toThrow(
        BULK_TEMPLATE_ONLY,
      );
      const zip64 = zipOf([{ name: 'a', data: 'x' }]);
      zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
      expect(() => assertZipWithinLimit(zip64, 1_000)).toThrow(
        BULK_TEMPLATE_ONLY,
      );
    });

    it('deflate 데이터가 깨졌으면 양식 문구', () => {
      const zip = zipOf([{ name: 'a', data: Buffer.alloc(200, 0x41) }]);
      // 첫 항목 데이터(로컬 헤더 30 + 이름 1 뒤)를 망가뜨린다
      zip.fill(0xff, 31, 40);
      expect(() => assertZipWithinLimit(zip, 10_000)).toThrow(
        BULK_TEMPLATE_ONLY,
      );
    });

    it('워크시트 XML 을 메인 스레드에서 정규식으로 훑지 않는다 — 닫히지 않은 태그 반복도 풀어 세기만 하고 바로 끝난다', () => {
      // 이전의 범위 사전 검사 정규식은 이 입력에서 이차 시간이었다(2.4KB 업로드에 이벤트 루프 16.5초, PR #276 3차 리뷰)
      const zip = zipOf([
        {
          name: 'xl/worksheets/sheet1.xml',
          data: '<mergeCell '.repeat(100_000),
        },
      ]);
      const started = Date.now();
      expect(() => assertZipWithinLimit(zip, 16_000_000)).not.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('zip 이 아니거나 깨졌으면 양식 문구', () => {
      expect(() => assertZipWithinLimit(Buffer.from('abc'), 1_000)).toThrow(
        BULK_TEMPLATE_ONLY,
      );
      expect(() =>
        assertZipWithinLimit(
          Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
          1_000,
        ),
      ).toThrow(BULK_TEMPLATE_ONLY);
    });
  });

  describe('checkBulkRow — 줄 검사', () => {
    it('필수 다섯 칸이 맞으면 오류 없이 저장할 값을 준다(처음 값: 수량 1 · 부가세 포함 · 점검 주기 없음)', () => {
      const r = checkBulkRow(raw(VALID), LOOKUPS);
      expect(r.errors).toEqual([]);
      expect(r.data).toEqual({
        storeId: 1,
        name: '제빙기 1호',
        facilityStatusCode: 'OPERATING',
        facilityGroupCode: 'STORE_EQUIPMENT',
        facilityCategoryCode: 'ICE_MAKER',
        memo: null,
        brand: null,
        manufacturer: null,
        serialNumber: null,
        installationLocation: null,
        vendorName: null,
        vendorPhone: null,
        salesRepresentativeName: null,
        salesRepresentativePhone: null,
        unitPriceAmount: null,
        quantity: 1,
        totalAmount: null,
        isVatIncluded: true,
        purchaseDate: null,
        installationDate: null,
        usageExpiryDate: null,
        warrantyExpiryDate: null,
        inspectionCycleCode: null,
        inspectionNote: null,
        serviceCenterPhone: null,
      });
      expect(r.values).toEqual({
        storeName: '강남점',
        group: '점포 장비',
        category: '제빙기',
        name: '제빙기 1호',
        purchaseDate: '',
        installationDate: '',
      });
    });

    it('모든 칸을 채우면 코드 · 숫자 · 날짜로 바꾸고 총금액을 계산한다', () => {
      const r = checkBulkRow(
        raw({
          ...VALID,
          store: ' ST000001 ',
          status: 'STORED',
          group: 'STORE_EQUIPMENT',
          category: 'GRINDER',
          brand: ' 브랜드 ',
          manufacturer: '제조사',
          serialNumber: 'SN-1',
          installationLocation: '주방',
          vendorName: '상사',
          vendorPhone: '02-123-4567',
          salesRepresentativeName: '김영업',
          salesRepresentativePhone: '010 1234 5678',
          unitPrice: '1,500,000',
          quantity: '3',
          vatIncluded: 'n',
          purchaseDate: '2026-11-10',
          installationDate: '2026-11-10',
          memo: ' 메모\n둘째 줄 ',
          usageExpiryDate: '2030-12-31',
          warrantyExpiryDate: '2028-11-11',
          inspectionCycle: '매월',
          inspectionNote: '필터 교체',
          serviceCenterPhone: '0311234567',
        }),
        LOOKUPS,
      );
      expect(r.errors).toEqual([]);
      expect(r.data).toMatchObject({
        storeId: 1,
        facilityStatusCode: 'STORED',
        facilityCategoryCode: 'GRINDER',
        brand: '브랜드',
        vendorPhone: '021234567',
        salesRepresentativePhone: '01012345678',
        unitPriceAmount: 1_500_000,
        quantity: 3,
        totalAmount: 4_500_000,
        isVatIncluded: false,
        purchaseDate: new Date(Date.UTC(2026, 10, 10)),
        installationDate: new Date(Date.UTC(2026, 10, 10)),
        memo: ' 메모\n둘째 줄 ',
        inspectionCycleCode: 'MONTHLY',
        serviceCenterPhone: '0311234567',
      });
      expect(r.values.category).toBe('그라인더');
      expect(r.values.group).toBe('점포 장비');
    });

    it('정상 줄은 isValid true · 저장할 값, 오류 줄은 isValid false · 값 없음', () => {
      const ok = checkBulkRow(raw(VALID), LOOKUPS);
      expect(ok.isValid).toBe(true);
      expect(ok.errors).toEqual([]);
      const bad = checkBulkRow(raw({ ...VALID, name: '' }), LOOKUPS);
      expect(bad.isValid).toBe(false);
      expect(bad.data).toBeNull();
    });

    it('필수 칸이 비면 칸마다 「칸 이름: 사유」', () => {
      const r = checkBulkRow(raw({}), LOOKUPS);
      expect(r.data).toBeNull();
      expect(r.errors).toEqual([
        '점포: 입력해 주세요.',
        '시설물/장비명: 입력해 주세요.',
        '운영상태: 선택해 주세요.',
        '그룹: 선택해 주세요.',
        '분류: 선택해 주세요.',
      ]);
    });

    it('점포 — 범위에 없으면 · 폐점이면 오류, 미리보기에는 적은 코드를 보인다', () => {
      const none = checkBulkRow(raw({ ...VALID, store: 'ST999999' }), LOOKUPS);
      expect(none.errors).toEqual(['점포: 관리하는 점포가 아닙니다.']);
      expect(none.values.storeName).toBe('ST999999');
      const closed = checkBulkRow(
        raw({ ...VALID, store: 'ST000002' }),
        LOOKUPS,
      );
      expect(closed.errors).toEqual([
        '점포: 폐점 점포에는 등록할 수 없습니다.',
      ]);
      expect(closed.values.storeName).toBe('닫은점');
    });

    it('점포 — 드롭다운 값 「점포명 [점포코드]」는 괄호 안 코드로 찾는다(이름을 고쳐 적어도 코드가 먼저)', () => {
      expect(
        checkBulkRow(raw({ ...VALID, store: '강남점 [ST000001]' }), LOOKUPS)
          .data?.storeId,
      ).toBe(1);
      expect(
        checkBulkRow(raw({ ...VALID, store: '아무 이름 [ST000001] ' }), LOOKUPS)
          .data?.storeId,
      ).toBe(1);
      const none = checkBulkRow(
        raw({ ...VALID, store: '강남점 [ST999999]' }),
        LOOKUPS,
      );
      expect(none.errors).toEqual(['점포: 관리하는 점포가 아닙니다.']);
      expect(none.values.storeName).toBe('강남점 [ST999999]');
    });

    it('점포 — 점포명만 적어도 범위 안에 그 이름이 하나면 받고, 여럿이면 목록에서 고르게 한다', () => {
      const r = checkBulkRow(raw({ ...VALID, store: ' 강남점 ' }), LOOKUPS);
      expect(r.errors).toEqual([]);
      expect(r.data?.storeId).toBe(1);
      expect(r.values.storeName).toBe('강남점');
      const twins: BulkLookups = {
        ...LOOKUPS,
        stores: new Map([
          ...LOOKUPS.stores,
          [
            'ST000003',
            {
              storeId: 3,
              storeCode: 'ST000003',
              name: '강남점',
              isClosed: false,
            },
          ],
        ]),
      };
      expect(
        checkBulkRow(raw({ ...VALID, store: '강남점' }), twins).errors,
      ).toEqual([
        '점포: 이름이 같은 점포가 여럿입니다. 목록에서 「점포명 [점포코드]」로 골라 주세요.',
      ]);
      // 코드로 적으면 이름이 겹쳐도 된다
      expect(
        checkBulkRow(raw({ ...VALID, store: '강남점 [ST000003]' }), twins).data
          ?.storeId,
      ).toBe(3);
    });

    it('점포 — 같은 이름의 열린 점포와 폐점 점포면 열린 점포, 폐점 점포만 그 이름이면 폐점 사유', () => {
      const lookups: BulkLookups = {
        ...LOOKUPS,
        stores: new Map([
          ...LOOKUPS.stores,
          [
            'ST000004',
            {
              storeId: 4,
              storeCode: 'ST000004',
              name: '강남점',
              isClosed: true,
            },
          ],
        ]),
      };
      expect(
        checkBulkRow(raw({ ...VALID, store: '강남점' }), lookups).data?.storeId,
      ).toBe(1);
      expect(
        checkBulkRow(raw({ ...VALID, store: '닫은점' }), lookups).errors,
      ).toEqual(['점포: 폐점 점포에는 등록할 수 없습니다.']);
      expect(
        checkBulkRow(raw({ ...VALID, store: '닫은점 [ST000002]' }), lookups)
          .errors,
      ).toEqual(['점포: 폐점 점포에는 등록할 수 없습니다.']);
    });

    it('점포 — 이름에 대괄호가 든 점포는 이름 전체로도 찾고, 점포코드는 같은 글자의 점포명보다 먼저다', () => {
      const lookups: BulkLookups = {
        ...LOOKUPS,
        stores: new Map([
          ...LOOKUPS.stores,
          [
            'ST000005',
            {
              storeId: 5,
              storeCode: 'ST000005',
              name: '본점 [2층]',
              isClosed: false,
            },
          ],
          [
            'ST000006',
            {
              storeId: 6,
              storeCode: 'ST000006',
              name: 'ST000001',
              isClosed: false,
            },
          ],
        ]),
      };
      expect(
        checkBulkRow(raw({ ...VALID, store: '본점 [2층]' }), lookups).data
          ?.storeId,
      ).toBe(5);
      expect(
        checkBulkRow(raw({ ...VALID, store: 'ST000001' }), lookups).data
          ?.storeId,
      ).toBe(1);
    });

    it('공통코드 — 목록에 없는 값 · 그룹에 없는 분류', () => {
      expect(
        checkBulkRow(raw({ ...VALID, status: '수리중' }), LOOKUPS).errors,
      ).toEqual(['운영상태: 목록에 있는 값을 골라 주세요.']);
      expect(
        checkBulkRow(raw({ ...VALID, group: '기타' }), LOOKUPS).errors,
      ).toEqual(['그룹: 목록에 있는 값을 골라 주세요.']);
      expect(
        checkBulkRow(raw({ ...VALID, category: '냉난방' }), LOOKUPS).errors,
      ).toEqual(['분류: 「점포 장비」에 없는 분류입니다.']);
      expect(
        checkBulkRow(raw({ ...VALID, inspectionCycle: '매년' }), LOOKUPS)
          .errors,
      ).toEqual(['점검 주기: 목록에 있는 값을 골라 주세요.']);
    });

    it('그룹이 틀리면 적힌 분류가 그룹에 맞는지는 보지 않는다(그룹 문구 하나)', () => {
      expect(
        checkBulkRow(
          raw({ ...VALID, group: '기타', category: '아무거나' }),
          LOOKUPS,
        ).errors,
      ).toEqual(['그룹: 목록에 있는 값을 골라 주세요.']);
    });

    it('글자 수 · 쓸 수 없는 문자', () => {
      expect(
        checkBulkRow(raw({ ...VALID, name: 'a'.repeat(101) }), LOOKUPS).errors,
      ).toEqual(['시설물/장비명: 100자까지 입력할 수 있습니다.']);
      expect(
        checkBulkRow(
          raw({ ...VALID, salesRepresentativeName: 'a'.repeat(51) }),
          LOOKUPS,
        ).errors,
      ).toEqual(['영업사원: 50자까지 입력할 수 있습니다.']);
      expect(
        checkBulkRow(raw({ ...VALID, memo: 'a'.repeat(201) }), LOOKUPS).errors,
      ).toEqual(['메모: 200자까지 입력할 수 있습니다.']);
      expect(
        checkBulkRow(
          raw({ ...VALID, inspectionNote: 'a'.repeat(201) }),
          LOOKUPS,
        ).errors,
      ).toEqual(['점검 비고: 200자까지 입력할 수 있습니다.']);
      expect(
        checkBulkRow(raw({ ...VALID, brand: 'a\u0000b' }), LOOKUPS).errors,
      ).toEqual(['브랜드: 쓸 수 없는 문자가 있습니다.']);
    });

    it('글자 수는 등록 화면 · DB 처럼 코드 포인트로 센다(이모지 하나 = 1자)', () => {
      expect(
        checkBulkRow(raw({ ...VALID, name: '🧊'.repeat(100) }), LOOKUPS).errors,
      ).toEqual([]);
      expect(
        checkBulkRow(raw({ ...VALID, name: '🧊'.repeat(101) }), LOOKUPS).errors,
      ).toEqual(['시설물/장비명: 100자까지 입력할 수 있습니다.']);
      expect(
        checkBulkRow(raw({ ...VALID, memo: '🧊'.repeat(200) }), LOOKUPS).errors,
      ).toEqual([]);
    });

    it('수량도 단가처럼 천 단위 쉼표를 받는다', () => {
      expect(
        checkBulkRow(raw({ ...VALID, quantity: '1,000' }), LOOKUPS).data
          ?.quantity,
      ).toBe(1000);
    });

    it('한글 이름이 다른 항목의 코드와 같으면 이름이 먼저다', () => {
      const lookups: BulkLookups = {
        ...LOOKUPS,
        cycles: [
          { code: 'DAILY', label: 'MONTHLY' },
          { code: 'MONTHLY', label: '매월' },
        ],
      };
      expect(
        checkBulkRow(raw({ ...VALID, inspectionCycle: 'MONTHLY' }), lookups)
          .data?.inspectionCycleCode,
      ).toBe('DAILY');
    });

    it('메모는 공백만이면 비운 것으로 본다', () => {
      expect(
        checkBulkRow(raw({ ...VALID, memo: '   ' }), LOOKUPS).data?.memo,
      ).toBeNull();
    });

    it('전화번호 — 하이픈 · 공백을 떼고 숫자 9~12자리', () => {
      expect(
        checkBulkRow(raw({ ...VALID, vendorPhone: '1588-1234' }), LOOKUPS)
          .errors,
      ).toEqual(['구매처 전화번호: 숫자 9~12자리로 적어 주세요.']);
      expect(
        checkBulkRow(
          raw({ ...VALID, serviceCenterPhone: '02-12a-4567' }),
          LOOKUPS,
        ).errors,
      ).toEqual(['A/S센터 전화번호: 숫자 9~12자리로 적어 주세요.']);
      expect(
        checkBulkRow(
          raw({ ...VALID, salesRepresentativePhone: '0505-1234-5678' }),
          LOOKUPS,
        ).errors,
      ).toEqual([]);
    });

    it.each(['-1', '1.5', '12345678901', '만원', '1,5'])(
      '단가 %p 는 오류',
      (unitPrice) => {
        expect(
          checkBulkRow(raw({ ...VALID, unitPrice }), LOOKUPS).errors,
        ).toEqual(['단가: 0 이상 숫자 10자리까지 적어 주세요.']);
      },
    );

    it('단가 0 · 10자리는 받는다', () => {
      expect(
        checkBulkRow(raw({ ...VALID, unitPrice: '0' }), LOOKUPS).data
          ?.totalAmount,
      ).toBe(0);
      expect(
        checkBulkRow(
          raw({ ...VALID, unitPrice: '9999999999', quantity: '9999' }),
          LOOKUPS,
        ).data?.totalAmount,
      ).toBe(9_999_999_999 * 9_999);
    });

    it.each(['0', '10000', '1.5', '-1', '하나'])(
      '수량 %p 는 오류',
      (quantity) => {
        expect(
          checkBulkRow(raw({ ...VALID, quantity }), LOOKUPS).errors,
        ).toEqual(['수량: 1 ~ 9,999 사이로 적어 주세요.']);
      },
    );

    it('부가세 포함 — Y · N(대소문자 무관), 그 밖은 오류', () => {
      expect(
        checkBulkRow(raw({ ...VALID, vatIncluded: 'y' }), LOOKUPS).data
          ?.isVatIncluded,
      ).toBe(true);
      expect(
        checkBulkRow(raw({ ...VALID, vatIncluded: '예' }), LOOKUPS).errors,
      ).toEqual(['부가세 포함: Y 또는 N 으로 적어 주세요.']);
    });

    it('날짜 — YYYY-MM-DD 이고 있는 날짜, 설치일 ≥ 구매일', () => {
      expect(
        checkBulkRow(raw({ ...VALID, purchaseDate: '2026/11/10' }), LOOKUPS)
          .errors,
      ).toEqual(['구매일: YYYY-MM-DD 로 적어 주세요.']);
      expect(
        checkBulkRow(
          raw({ ...VALID, warrantyExpiryDate: '2026-02-30' }),
          LOOKUPS,
        ).errors,
      ).toEqual(['품질 보증기한: YYYY-MM-DD 로 적어 주세요.']);
      expect(
        checkBulkRow(
          raw({
            ...VALID,
            purchaseDate: '2026-11-10',
            installationDate: '2026-11-01',
          }),
          LOOKUPS,
        ).errors,
      ).toEqual(['설치일: 구매일보다 앞설 수 없습니다.']);
    });

    it('한 줄의 오류는 모두 적는다(칸 순서)', () => {
      const r = checkBulkRow(
        raw({ ...VALID, name: '', quantity: '0', installationDate: '어제' }),
        LOOKUPS,
      );
      expect(r.errors).toEqual([
        '시설물/장비명: 입력해 주세요.',
        '수량: 1 ~ 9,999 사이로 적어 주세요.',
        '설치일: YYYY-MM-DD 로 적어 주세요.',
      ]);
    });
  });

  describe('buildBulkTemplate — 양식', () => {
    async function load(buffer: Buffer) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      return wb;
    }

    it('첫 시트 머리글 · 둘째 시트 점포 목록(폐점 제외) · 숨긴 선택값 시트', async () => {
      const wb = await load(await buildBulkTemplate(LOOKUPS));
      const [main, stores, choices] = wb.worksheets;
      expect(main.name).toBe('시설물·장비');
      expect((main.getRow(1).values as unknown[]).slice(1)).toEqual(LABELS);
      expect(stores.name).toBe('점포 목록');
      // 첫 열이 점포 드롭다운 값 「점포명 [점포코드]」
      expect((stores.getRow(1).values as unknown[]).slice(1)).toEqual([
        '점포',
        '점포코드',
        '점포명',
      ]);
      expect((stores.getRow(2).values as unknown[]).slice(1)).toEqual([
        '강남점 [ST000001]',
        'ST000001',
        '강남점',
      ]);
      expect(stores.rowCount).toBe(2);
      expect(choices.state).toBe('hidden');
    });

    it('점포 드롭다운은 점포 목록 시트의 「점포명 [점포코드]」 열을 가리킨다', async () => {
      const wb = await load(await buildBulkTemplate(LOOKUPS));
      const v = wb.worksheets[0].getCell(2, 1).dataValidation;
      expect(v?.formulae).toEqual(["'점포 목록'!$A$2:$A$2"]);
    });

    it('글자 서식 · 드롭다운(운영상태 · 그룹 · 분류 · 점검 주기 · 부가세 · 점포)', async () => {
      const wb = await load(await buildBulkTemplate(LOOKUPS));
      const main = wb.worksheets[0];
      const col = (label: string) => LABELS.indexOf(label) + 1;
      expect(main.getCell(2, col('구매처 전화번호')).numFmt).toBe('@');
      expect(main.getCell(501, col('구매일')).numFmt).toBe('@');
      for (const label of [
        '운영상태*',
        '그룹*',
        '분류*',
        '점검 주기',
        '부가세 포함(Y/N)',
        '점포*',
      ]) {
        const v = main.getCell(2, col(label)).dataValidation;
        expect(v?.type).toBe('list');
        expect(main.getCell(501, col(label)).dataValidation?.type).toBe('list');
      }
      expect(
        main.getCell(502, col('운영상태*')).dataValidation,
      ).toBeUndefined();
    });

    it('목록이 비면 그 칸에는 드롭다운을 걸지 않는다(빈 범위 수식은 엑셀이 복구 모드로 연다)', async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(
        (await buildBulkTemplate({
          ...LOOKUPS,
          stores: new Map([['ST000002', LOOKUPS.stores.get('ST000002')!]]),
          cycles: [],
        })) as unknown as ArrayBuffer,
      );
      const main = wb.worksheets[0];
      const col = (label: string) => LABELS.indexOf(label) + 1;
      expect(main.getCell(2, col('점포*')).dataValidation).toBeUndefined();
      expect(main.getCell(2, col('점검 주기')).dataValidation).toBeUndefined();
      expect(main.getCell(2, col('운영상태*')).dataValidation?.type).toBe(
        'list',
      );
      expect(wb.worksheets[1].rowCount).toBe(1);
    });

    it('만든 양식을 그대로 올리면 「등록할 시설물·장비가 없습니다」(양식 검사는 통과)', async () => {
      expect(
        await rejection(readBulkFile(await buildBulkTemplate(LOOKUPS))),
      ).toBe(BULK_EMPTY);
    });
  });

  describe('bulkErrorFileName — 오류 파일 이름', () => {
    it.each([
      ['시설물.xlsx', '시설물_오류.xlsx'],
      ['시설물.XLSX', '시설물_오류.xlsx'],
      ['시설물', '시설물_오류.xlsx'],
      ['', '시설물장비_일괄등록_오류.xlsx'],
      ['.xlsx', '시설물장비_일괄등록_오류.xlsx'],
    ])('%p → %p', (name, expected) => {
      expect(bulkErrorFileName(name)).toBe(expected);
    });
  });

  describe('buildBulkErrorFile — 오류 파일', () => {
    it('올린 파일 끝에 「오류 사유」 열을 더하고 오류 줄에만 사유를 적는다', async () => {
      const buffer = await xlsx([VALIDCELLS(), { '점포*': 'ST9' }]);
      const out = await buildBulkErrorFile(
        await readBulkFile(buffer),
        new Map([
          [
            3,
            [
              '점포: 관리하는 점포가 아닙니다.',
              '시설물/장비명: 입력해 주세요.',
            ],
          ],
        ]),
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(out as unknown as ArrayBuffer);
      const ws = wb.worksheets[0];
      expect(ws.getCell(1, 25).value).toBe('오류 사유');
      expect(ws.getCell(2, 25).value ?? null).toBeNull();
      expect(ws.getCell(3, 25).value).toBe(
        '점포: 관리하는 점포가 아닙니다.\n시설물/장비명: 입력해 주세요.',
      );
      expect(ws.getCell(3, 1).value).toBe('ST9');
    });

    it('오류 파일을 다시 넣으면 옛 사유를 지우고 새로 적는다', async () => {
      const buffer = await xlsx(
        [{ '점포*': 'ST000001', '오류 사유': '옛 사유' }],
        [...LABELS, '오류 사유'],
      );
      const out = await buildBulkErrorFile(
        await readBulkFile(buffer),
        new Map(),
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(out as unknown as ArrayBuffer);
      expect(wb.worksheets[0].getCell(2, 25).value ?? null).toBeNull();
    });

    it('먼 행이 있어도 실제 있는 행에만 쓴다(빈 행을 만들지 않는다)', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('시설물·장비');
      ws.addRow(LABELS);
      ws.addRow(LABELS.map((l) => VALIDCELLS()[l] ?? null));
      ws.getCell(1_048_576, 1).value = ' ';
      const parsed = await readBulkFile(
        Buffer.from(await wb.xlsx.writeBuffer()),
      );
      const out = await buildBulkErrorFile(parsed, new Map([[2, ['a: b']]]));
      expect(out.length).toBeLessThan(100_000);
    });
  });
});

function VALIDCELLS(): Record<string, string> {
  return {
    '점포*': 'ST000001',
    '시설물/장비명*': '제빙기',
    '운영상태*': '운영',
    '그룹*': '점포 장비',
    '분류*': '제빙기',
  };
}
