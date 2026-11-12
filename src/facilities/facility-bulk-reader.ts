import { Worker } from 'node:worker_threads';
import {
  BadRequestException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type ExcelJS from 'exceljs';

// 올린 xlsx 를 exceljs 로 여는 일은 메모리 · 시간 상한이 걸린 worker 스레드에서만 한다(PR #276 재리뷰, 2026-11-12).
// exceljs 는 읽는 순간 병합 셀 · 데이터 유효성 검사 · 이름 정의 범위의 칸마다, <col max> 의 열마다, 빈 <c/> 마다 객체를
// 만든다 — 몇 KB 파일 하나가 heap 을 다 써 API 프로세스를 죽였고, XML 을 미리 정규식으로 훑는 검사는 우회되면서 그 자체로
// 메인 스레드를 수십 초 멈췄다(이차 시간). 어떤 입력이든 피해를 worker 하나로 가두고 400 으로 끝낸다.
// worker 가 메인으로 보내는 것도 묶는다 — 같은 공유 문자열을 여러 칸이 가리키면 worker 안에선 하나지만 structured clone 은
// 칸마다 복사해(11KB 파일에 메인 heap 2.4GB, 3차 리뷰) worker 의 메모리 상한 밖에서 메인이 터진다. 그래서 worker 가 셀 값을
// 단순한 꼴로 바꾸며 칸마다 글자 수 · 전체 글자 수에 상한을 두고, 행이 너무 많으면 행은 보내지 않는다.
// worker 코드는 파일이 아니라 글자로 둔다 — 빌드 산출물(dist) · ts-jest 어디서나 같은 코드가 돈다. exceljs 는 절대 경로로 부른다.

const logger = new Logger('FacilityBulkReader');

/** worker 한 개의 메모리 상한 — 500줄을 꽉 채운 양식은 heap 5MB 남짓, 점포 수만 곳의 양식도 수십 MB 다 */
const WORKER_OLD_SPACE_MB = 192;
const WORKER_YOUNG_SPACE_MB = 32;
/** worker 한 개의 시간 상한 — exceljs 를 불러오는 데 1초 안팎, 정상 파일 읽기는 그보다 짧다 */
const WORKER_TIMEOUT_MS = 15_000;
/** 동시에 도는 worker 수 · 줄 설 수 있는 요청 수 · 줄에서 기다리는 시간 — 넘으면 503 */
const MAX_CONCURRENT_WORKERS = 2;
const MAX_WAITING = 8;
const MAX_WAIT_MS = 30_000;

export const BULK_TOO_COMPLEX =
  '파일을 읽는 데 자원이 너무 많이 듭니다. 셀 병합 · 열 전체 유효성 검사 · 서식 · 이름 정의 없이 내려받은 양식에 값만 적어 다시 올려 주세요.';
export const BULK_UNREADABLE =
  '파일을 읽지 못했습니다. 표 · 차트 · 그림 없이 내려받은 양식에 값만 적어 다시 올려 주세요.';
export const BULK_NOT_TEMPLATE =
  '내려받은 양식으로 작성한 파일만 올릴 수 있습니다.';
export const BULK_BUSY =
  '일괄 등록 파일을 읽는 요청이 몰려 있습니다. 잠시 뒤 다시 시도해 주세요.';
/**
 * 「요청 몰림」 503 의 식별 code. front 는 이 code 가 있는 503 만 「저장 안 됨」으로 보고 다시 등록하게
 * 한다 — 코드 없는 503 은 앞단 게이트웨이 · 로드밸런서가 낸 것일 수 있다(저장이 끝난 뒤일 수도).
 * 다른 자원의 일괄 등록도 같은 값을 쓴다.
 */
export const BULK_BUSY_CODE = 'BULK_BUSY';

function busy(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    code: BULK_BUSY_CODE,
    message: BULK_BUSY,
  });
}

const EXCELJS_PATH = require.resolve('exceljs');

/**
 * worker 코드.
 * - read: 첫 시트의 머리글과 방문한 행의 앞 columns 칸. 셀 값은 글자 · 숫자 · 참거짓 · 날짜 · { error } · { formula, result }
 *   로 바꾸고, 서식 있는 글자 · 하이퍼링크는 글자로 잇는다. 칸 글자가 maxCellText 를 넘으면 { tooLong }, 모르는 꼴은
 *   { unknown }. 보낼 글자가 모두 maxTotalText 를 넘으면 { type: 'too-large' }. 방문 행이 상한을 넘으면 행 없이 overflow.
 * - error-file: 첫 시트 끝에 「오류 사유」 열을 더해 다시 쓴 파일.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const ExcelJS = require(workerData.exceljsPath);
const OVER = {};
(async () => {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(workerData.buffer);
  } catch (e) {
    parentPort.postMessage({ type: 'unreadable', name: String((e && e.name) || 'Error').slice(0, 100), message: String((e && e.message) || e).slice(0, 500) });
    return;
  }
  const sheet = wb.worksheets[0];
  if (!sheet) {
    parentPort.postMessage({ type: 'no-sheet' });
    return;
  }
  const columns = workerData.columns;
  if (workerData.task === 'read') {
    const maxCell = workerData.maxCellText;
    let left = workerData.maxTotalText;
    const cap = (s) => {
      if (s.length > maxCell) return { tooLong: true };
      left -= s.length;
      if (left < 0) throw OVER;
      return s;
    };
    const norm = (v, depth) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string') return cap(v);
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      if (Object.prototype.toString.call(v) === '[object Date]') return v;
      if (typeof v !== 'object' || depth > 2) return { unknown: true };
      if (Array.isArray(v.richText)) {
        let s = '';
        for (const r of v.richText) {
          if (r && typeof r.text === 'string') s += r.text;
          if (s.length > maxCell) return { tooLong: true };
        }
        return cap(s);
      }
      if ('error' in v) return { error: String(v.error).slice(0, 20) };
      if ('formula' in v || 'sharedFormula' in v)
        return v.result === undefined ? { formula: true } : { formula: true, result: norm(v.result, depth + 1) };
      if ('text' in v) return norm(v.text, depth + 1);
      return { unknown: true };
    };
    try {
      const head = sheet.getRow(1);
      const header = [];
      for (let c = 1; c <= columns + 1; c++) header.push(norm(head.getCell(c).value, 0));
      let rows = [];
      let overflow = false;
      let visited = 0;
      sheet.eachRow((row, n) => {
        if (n === 1 || overflow) return;
        if (++visited > workerData.maxVisitedRows) {
          overflow = true;
          return;
        }
        const values = [];
        for (let c = 1; c <= columns; c++) values.push(norm(row.getCell(c).value, 0));
        rows.push({ rowNumber: n, values });
      });
      if (overflow) rows = [];
      parentPort.postMessage({ type: 'read', header, rows, overflow });
    } catch (e) {
      if (e === OVER) parentPort.postMessage({ type: 'too-large' });
      else throw e;
    }
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
})().catch((e) => parentPort.postMessage({ type: 'crash', message: String((e && e.message) || e).slice(0, 500) }));
`;

/**
 * worker 가 돌려준 셀 값 — exceljs 값을 단순하게 바꾼 꼴. tooLong 은 칸 글자가 상한을 넘은 것, unknown 은 모르는 꼴.
 * formula 의 result 가 없으면 저장된 계산 결과가 없는 수식이다.
 */
export type WorkerCellValue =
  | null
  | string
  | number
  | boolean
  | Date
  | { error: string }
  | { formula: true; result?: WorkerCellValue }
  | { tooLong: true }
  | { unknown: true };

/** 첫 시트에서 읽은 것 */
export interface SheetRead {
  header: WorkerCellValue[];
  rows: { rowNumber: number; values: WorkerCellValue[] }[];
  /** 방문한 행이 상한을 넘었다 — 행은 보내지 않았다 */
  overflow: boolean;
  /** 보낼 글자가 모두 합해 상한을 넘었다 — 머리글 · 행은 비어 있다 */
  tooLarge: boolean;
}

type WorkerReply =
  | {
      type: 'read';
      header: WorkerCellValue[];
      rows: SheetRead['rows'];
      overflow: boolean;
    }
  | { type: 'too-large' }
  | { type: 'file'; buffer: Uint8Array }
  | { type: 'unreadable'; name?: string; message: string }
  | { type: 'no-sheet' }
  | { type: 'crash'; message: string };

/**
 * worker 자리 — 동시에 max 개까지, 나머지는 maxWaiting 개까지 줄을 서고 waitMs 안에 자리를 얻지 못하면 503. 줄이 가득
 * 차도 503 — 기다리는 요청마다 올린 파일(최대 5MB)을 메인 메모리에 쥐고 있어서다(3차 리뷰). 반납은 worker 가 실제로
 * 끝난 뒤(exit)에 한다 — 끝나기 전에 다음 worker 를 띄우면 상한보다 많은 worker 가 메모리를 쥔다.
 */
export class WorkerSlots {
  private active = 0;
  private readonly waiting: { grant: () => void }[] = [];

  constructor(
    private readonly max: number,
    private readonly maxWaiting: number,
    private readonly waitMs: number,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(busy());
    return new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(timer);
          this.active++;
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(busy());
      }, this.waitMs);
      this.waiting.push(entry);
    });
  }

  release(): void {
    this.active--;
    this.waiting.shift()?.grant();
  }
}

const slots = new WorkerSlots(MAX_CONCURRENT_WORKERS, MAX_WAITING, MAX_WAIT_MS);

/** worker 하나를 돌려 답을 받는다 — 메모리 · 시간 상한을 넘으면 400(자원 초과), 자리가 없으면 503, 그 밖의 실패는 500 */
async function runWorker(
  buffer: Buffer,
  data: Record<string, unknown>,
): Promise<WorkerReply> {
  await slots.acquire();
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { ...data, buffer, exceljsPath: EXCELJS_PATH },
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_OLD_SPACE_MB,
        maxYoungGenerationSizeMb: WORKER_YOUNG_SPACE_MB,
      },
    });
  } catch (error) {
    slots.release();
    throw error;
  }
  // 자리는 스레드가 실제로 끝난 뒤에 돌려준다
  worker.once('exit', () => slots.release());
  return new Promise<WorkerReply>((resolve, reject) => {
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

/**
 * 첫 시트의 머리글(columns + 1 칸)과 방문한 행의 앞 columns 칸 값을 worker 에서 읽는다. 칸 글자는 maxCellText,
 * 보낼 글자 전체는 maxTotalText 까지다.
 */
export async function readSheetInWorker(
  buffer: Buffer,
  limits: {
    columns: number;
    maxVisitedRows: number;
    maxCellText: number;
    maxTotalText: number;
  },
): Promise<SheetRead> {
  const reply = await runWorker(buffer, { task: 'read', ...limits });
  if (reply.type === 'too-large')
    return { header: [], rows: [], overflow: false, tooLarge: true };
  if (reply.type !== 'read') throw failureOf(reply, buffer.length);
  return {
    header: reply.header,
    rows: reply.rows,
    overflow: reply.overflow,
    tooLarge: false,
  };
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
