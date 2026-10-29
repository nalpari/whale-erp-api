import { unzipSync } from 'fflate';
import {
  archivePlan,
  toCsv,
  zipArchive,
  type ArchiveInput,
} from './bulk-export-archive';

const BOM = '﻿';
const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');

const input = (): ArchiveInput => ({
  storeNames: new Map([
    [1, '판교점'],
    [2, '강남/역삼점'],
  ]),
  staff: [
    { staffMemberId: 10, storeId: 1, name: '유하람', phone: '01012345678' },
    { staffMemberId: 11, storeId: 2, name: '김, "철수"', phone: '01099998888' },
  ],
  contracts: [
    {
      contractId: 100,
      staffMemberId: 10,
      status: 'SIGNED',
      contractMethod: 'PAPER',
      employmentType: 'PART_TIME',
      jobTitle: '바리스타',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: null,
      wageAmount: 10_030,
      sentAt: null,
      documents: [
        {
          kind: 'PAPER_EMPLOYMENT_CONTRACT',
          storageKey: 'contracts/100/a.pdf',
        },
        { kind: 'WAGE_CONTRACT', storageKey: 'contracts/100/b.jpg' },
      ],
    },
  ],
  attendance: [
    {
      attendanceRecordId: 500,
      staffMemberId: 10,
      kind: 'CHECK_IN',
      recordedAt: new Date('2026-10-01T00:02:00.000Z'),
      entryMethod: 'PROXY',
      proxyBy: 7,
      proxyReason: '위치 동의 철회',
      reviewReason: 'OUT_OF_RADIUS_CHECKIN',
      corrections: [
        {
          beforeValue: {
            checkInAt: '2026-10-01T00:02:00.000Z',
            checkOutAt: null,
          },
          afterValue: {
            checkInAt: '2026-10-01T00:00:00.000Z',
            checkOutAt: '2026-10-01T09:00:00.000Z',
          },
          reason: '지각 아님',
          correctedBy: 8,
          correctedAt: new Date('2026-10-02T01:00:00.000Z'),
        },
      ],
    },
  ],
  schedules: [
    {
      staffMemberId: 11,
      startAt: new Date('2026-10-03T00:00:00.000Z'),
      endAt: new Date('2026-10-03T08:00:00.000Z'),
      breakMinutes: 60,
    },
  ],
  payslips: [
    {
      payslipId: 900,
      staffMemberId: 10,
      periodStartDate: '2026-09-01',
      periodEndDate: '2026-09-30',
      employmentType: 'PART_TIME',
      grossPayAmount: 1_000_000,
      totalDeductionAmount: 33_000,
      netPayAmount: 967_000,
      sentAt: new Date('2026-10-10T01:00:00.000Z'),
    },
  ],
  adminName: (id) => (id === 7 ? '점장' : id === 8 ? 'bm01' : '-'),
});

describe('toCsv', () => {
  it('UTF-8 BOM · CRLF, 쉼표 · 따옴표 · 줄바꿈이 든 칸은 따옴표로 감싸고 따옴표는 두 번', () => {
    const csv = text(
      toCsv(
        ['이름', '메모'],
        [
          ['김, "철수"', '줄\n바꿈'],
          ['a', null],
        ],
      ),
    );
    expect(csv).toBe(`${BOM}이름,메모\r\n"김, ""철수""","줄\n바꿈"\r\na,\r\n`);
  });

  it('엑셀이 수식으로 읽는 첫 글자(= + - @)는 작은따옴표를 붙인다', () => {
    expect(text(toCsv(['a'], [['=1+1'], ['-3']]))).toBe(
      `${BOM}a\r\n'=1+1\r\n'-3\r\n`,
    );
  });
});

describe('archivePlan — zip 구성', () => {
  const plan = archivePlan(input());
  const csv = (name: string) => text(plan.csv.get(name)!);

  it('맨 위에 CSV 다섯, 직원 폴더는 {점포명}/{이름}_{직원 레코드 ID}', () => {
    expect([...plan.csv.keys()]).toEqual([
      '근로계약_목록.csv',
      '출퇴근_기록.csv',
      '출퇴근_보정_이력.csv',
      '급여명세서_목록.csv',
      '근무스케줄.csv',
    ]);
    expect(plan.files).toEqual([
      {
        path: '판교점/유하람_10/근로계약서/100_종이 계약 근로계약서.pdf',
        storageKey: 'contracts/100/a.pdf',
      },
      {
        path: '판교점/유하람_10/근로계약서/100_임금계약서.jpg',
        storageKey: 'contracts/100/b.jpg',
      },
    ]);
    expect(plan.payslips).toEqual([
      {
        path: '판교점/유하람_10/급여명세서/급여명세서_2026-09_유하람.pdf',
        payslipId: 900,
        staffName: '유하람',
      },
    ]);
  });

  it('CSV 마다 BOM 과 한글 머리줄, 직원은 이름 · 휴대전화번호까지만', () => {
    for (const content of plan.csv.values())
      expect(text(content).startsWith(BOM)).toBe(true);
    expect(csv('근로계약_목록.csv')).toContain(
      '판교점,10,유하람,01012345678,100,체결 완료,종이 계약,파트타이머,바리스타,2026-01-01,,10030,',
    );
    expect(csv('근무스케줄.csv')).toContain(
      '강남/역삼점,11,"김, ""철수""",01099998888,2026-10-03 09:00,2026-10-03 17:00,60',
    );
  });

  it('출퇴근 기록 — 한국 시각, 대신 등록(등록자 · 사유), 확인 필요 사유', () => {
    expect(csv('출퇴근_기록.csv')).toContain(
      '판교점,10,유하람,01012345678,500,출근,2026-10-01 09:02,대신 등록,점장,위치 동의 철회,반경 밖 출근',
    );
  });

  it('보정 이력 — 전 · 후 값, 사유, 보정자, 시각', () => {
    expect(csv('출퇴근_보정_이력.csv')).toContain(
      '500,출근,출근 2026-10-01 09:02 · 퇴근 없음,출근 2026-10-01 09:00 · 퇴근 2026-10-01 18:00,지각 아님,bm01,2026-10-02 10:00',
    );
  });

  it('급여명세서 목록', () => {
    expect(csv('급여명세서_목록.csv')).toContain(
      '판교점,10,유하람,01012345678,900,2026-09-01,2026-09-30,파트타이머,1000000,33000,967000,2026-10-10 10:00',
    );
  });

  it('점포명의 경로 글자는 밑줄로, 같은 경로는 뒤에 번호를 붙인다', () => {
    const i = input();
    i.staff = [{ ...i.staff[1], staffMemberId: 11 }];
    i.attendance = [];
    i.payslips = [];
    i.contracts = [
      {
        ...i.contracts[0],
        staffMemberId: 11,
        documents: [
          { kind: 'SIGNED_COPY', storageKey: 'contracts/100/a.pdf' },
          { kind: 'SIGNED_COPY', storageKey: 'contracts/100/b.pdf' },
        ],
      },
    ];
    expect(archivePlan(i).files.map((f) => f.path)).toEqual([
      '강남_역삼점/김, _철수__11/근로계약서/100_날인 완료본.pdf',
      '강남_역삼점/김, _철수__11/근로계약서/100_날인 완료본 (2).pdf',
    ]);
  });
});

describe('zipArchive', () => {
  it('묶은 것을 그대로 풀 수 있다 — PDF · 이미지는 압축하지 않고, CSV 는 압축한다', () => {
    const csv = toCsv(
      ['a'],
      Array.from({ length: 200 }, () => ['같은 줄']),
    );
    const pdf = Buffer.from('%PDF-1.7 '.repeat(200));
    const zip = zipArchive([
      { path: '근로계약_목록.csv', data: csv },
      { path: '판교점/유하람_10/근로계약서/100_a.pdf', data: pdf },
    ]);

    const files = unzipSync(zip);
    expect(Buffer.from(files['근로계약_목록.csv'])).toEqual(Buffer.from(csv));
    expect(Buffer.from(files['판교점/유하람_10/근로계약서/100_a.pdf'])).toEqual(
      pdf,
    );
    // 로컬 헤더의 압축 방식(오프셋 8) — 0 저장 · 8 deflate
    const methods: number[] = [];
    for (let i = 0; i + 30 < zip.length; i++)
      if (zip.readUInt32LE(i) === 0x04034b50)
        methods.push(zip.readUInt16LE(i + 8));
    expect(methods).toEqual([8, 0]);
  });
});
