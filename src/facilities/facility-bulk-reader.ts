import { Worker } from 'node:worker_threads';
import { BadRequestException, Logger } from '@nestjs/common';
import type ExcelJS from 'exceljs';

// 올린 xlsx 를 exceljs 로 여는 일은 메모리 · 시간 상한이 걸린 worker 스레드에서만 한다(PR #276 재리뷰, 2026-11-12).
// exceljs 는 읽는 순간 병합 셀 · 데이터 유효성 검사 · 이름 정의 범위의 칸마다, <col max> 의 열마다, 빈 <c/> 마다 객체를
// 만든다 — 몇 KB 파일 하나가 heap 을 다 써 API 프로세스를 죽였고, XML 을 미리 정규식으로 훑는 검사는 항목 이름 ·
// 문자 참조 · 공백 변형으로 우회됐다. 어떤 입력이든 피해를 worker 하나로 가두고 400 으로 끝낸다.
// worker 코드는 파일이 아니라 글자로 둔다 — 빌드 산출물(dist) · ts-jest 어디서나 같은 코드가 돈다. exceljs 는 절대 경로로 부른다.

const logger = new Logger('FacilityBulkReader');

/** worker 한 개의 메모리 상한 — 500줄을 꽉 채운 양식은 heap 5MB 남짓, 점포 수만 곳의 양식도 수십 MB 다 */
const WORKER_OLD_SPACE_MB = 192;
const WORKER_YOUNG_SPACE_MB = 32;
/** worker 한 개의 시간 상한 — exceljs 를 불러오는 데 1초 안팎, 정상 파일 읽기는 그보다 짧다 */
const WORKER_TIMEOUT_MS = 15_000;
/** 동시에 도는 worker 수 — 나머지는 줄을 선다. 서버 전체에서 파일 읽기가 쓰는 메모리를 이 배수 안으로 묶는다 */
const MAX_CONCURRENT_WORKERS = 2;

export const BULK_TOO_COMPLEX =
  '파일을 읽는 데 자원이 너무 많이 듭니다. 셀 병합 · 서식 · 이름 정의 없이 내려받은 양식에 값만 적어 다시 올려 주세요.';
export const BULK_UNREADABLE =
  '파일을 읽지 못했습니다. 표 · 차트 · 그림 없이 내려받은 양식에 값만 적어 다시 올려 주세요.';
export const BULK_NOT_TEMPLATE =
  '내려받은 양식으로 작성한 파일만 올릴 수 있습니다.';

const EXCELJS_PATH = require.resolve('exceljs');

/** worker 코드 — read: 첫 시트의 머리글과 방문한 행의 셀 값, error-file: 첫 시트에 「오류 사유」 열을 더해 다시 쓴 파일 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const ExcelJS = require(workerData.exceljsPath);
(async () => {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(workerData.buffer);
  } catch (e) {
    parentPort.postMessage({ type: 'unreadable', name: e && e.name, message: String((e && e.message) || e) });
    return;
  }
  const sheet = wb.worksheets[0];
  if (!sheet) {
    parentPort.postMessage({ type: 'no-sheet' });
    return;
  }
  const columns = workerData.columns;
  if (workerData.task === 'read') {
    const head = sheet.getRow(1);
    const header = [];
    for (let c = 1; c <= columns + 1; c++) header.push(head.getCell(c).value ?? null);
    const rows = [];
    let overflow = false;
    let visited = 0;
    sheet.eachRow((row, n) => {
      if (n === 1 || overflow) return;
      if (++visited > workerData.maxVisitedRows) {
        overflow = true;
        return;
      }
      const values = [];
      for (let c = 1; c <= columns; c++) values.push(row.getCell(c).value ?? null);
      rows.push({ rowNumber: n, values });
    });
    parentPort.postMessage({ type: 'read', header, rows, overflow });
    return;
  }
  const col = columns + 1;
  const head = sheet.getRow(1);
  head.getCell(col).value = workerData.errorHeader;
  head.eachCell((cell) => {
    cell.font = workerData.headerFont;
    cell.fill = workerData.headerFill;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  sheet.getColumn(col).width = 60;
  const errors = new Map(workerData.errors);
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const cell = row.getCell(col);
    const list = errors.get(n);
    cell.value = list && list.length ? list.join('\\n') : null;
    if (list && list.length) cell.alignment = { wrapText: true, vertical: 'top' };
  });
  const out = await wb.xlsx.writeBuffer();
  parentPort.postMessage({ type: 'file', buffer: new Uint8Array(out) });
})().catch((e) => parentPort.postMessage({ type: 'crash', message: String((e && e.message) || e) }));
`;

/** 첫 시트에서 읽은 것 — 셀 값은 exceljs 값 그대로(글자 · 숫자 · 날짜 · 서식 있는 글자 · 수식 · 오류 값) */
export interface SheetRead {
  header: ExcelJS.CellValue[];
  rows: { rowNumber: number; values: ExcelJS.CellValue[] }[];
  /** 방문한 행이 상한을 넘었다(그 뒤는 읽지 않았다) */
  overflow: boolean;
}

type WorkerReply =
  | ({ type: 'read' } & SheetRead)
  | { type: 'file'; buffer: Uint8Array }
  | { type: 'unreadable'; name?: string; message: string }
  | { type: 'no-sheet' }
  | { type: 'crash'; message: string };

let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_WORKERS) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

/** worker 하나를 돌려 답을 받는다 — 메모리 · 시간 상한을 넘으면 400(자원 초과), worker 자체의 다른 실패는 500 */
async function runWorker(
  buffer: Buffer,
  data: Record<string, unknown>,
): Promise<WorkerReply> {
  await acquire();
  try {
    return await new Promise<WorkerReply>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { ...data, buffer, exceljsPath: EXCELJS_PATH },
        resourceLimits: {
          maxOldGenerationSizeMb: WORKER_OLD_SPACE_MB,
          maxYoungGenerationSizeMb: WORKER_YOUNG_SPACE_MB,
        },
      });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() => {
            logger.warn(
              `일괄 등록 파일 읽기가 ${WORKER_TIMEOUT_MS}ms 를 넘었다 (${buffer.length}바이트)`,
            );
            reject(new BadRequestException(BULK_TOO_COMPLEX));
          }),
        WORKER_TIMEOUT_MS,
      );
      worker.once('message', (reply: WorkerReply) =>
        finish(() => resolve(reply)),
      );
      worker.once('error', (error: Error & { code?: string }) =>
        finish(() => {
          // 코드로 본다 — 테스트 실행 환경(vm)에선 Node 오류에 instanceof 가 맞지 않는다
          if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
            logger.warn(
              `일괄 등록 파일 읽기가 worker 메모리 상한을 넘었다 (${buffer.length}바이트)`,
            );
            reject(new BadRequestException(BULK_TOO_COMPLEX));
          } else reject(error);
        }),
      );
      worker.once('exit', (code) =>
        finish(() =>
          reject(
            new Error(
              `일괄 등록 파일 읽기 worker 가 답 없이 끝났다(exit ${code})`,
            ),
          ),
        ),
      );
    });
  } finally {
    release();
  }
}

/** exceljs 가 못 읽은 것 · 시트가 없는 것 · worker 안의 예외를 사용자 문구나 500 으로 바꾼다 */
function failureOf(reply: WorkerReply, size: number): Error {
  if (reply.type === 'unreadable') {
    logger.warn(
      `일괄 등록 파일을 읽지 못했다 (${size}바이트): ${reply.name ?? 'Error'}: ${reply.message}`,
    );
    return new BadRequestException(BULK_UNREADABLE);
  }
  if (reply.type === 'no-sheet')
    return new BadRequestException(BULK_NOT_TEMPLATE);
  if (reply.type === 'crash')
    return new Error(`일괄 등록 파일 worker 예외: ${reply.message}`);
  return new Error(`일괄 등록 파일 worker 가 뜻밖의 답을 했다: ${reply.type}`);
}

/** 첫 시트의 머리글(columns + 1 칸)과 방문한 행의 앞 columns 칸 값을 worker 에서 읽는다 */
export async function readSheetInWorker(
  buffer: Buffer,
  columns: number,
  maxVisitedRows: number,
): Promise<SheetRead> {
  const reply = await runWorker(buffer, {
    task: 'read',
    columns,
    maxVisitedRows,
  });
  if (reply.type !== 'read') throw failureOf(reply, buffer.length);
  return { header: reply.header, rows: reply.rows, overflow: reply.overflow };
}

/** 첫 시트 끝(columns + 1 열)에 「오류 사유」 열을 더해 다시 쓴 파일을 worker 에서 만든다 */
export async function writeErrorColumnInWorker(
  buffer: Buffer,
  columns: number,
  errorsByRow: ReadonlyMap<number, readonly string[]>,
  style: {
    header: string;
    font: Partial<ExcelJS.Font>;
    fill: ExcelJS.Fill;
  },
): Promise<Buffer> {
  const reply = await runWorker(buffer, {
    task: 'error-file',
    columns,
    errors: [...errorsByRow.entries()],
    errorHeader: style.header,
    headerFont: style.font,
    headerFill: style.fill,
  });
  if (reply.type !== 'file') throw failureOf(reply, buffer.length);
  return Buffer.from(reply.buffer);
}
