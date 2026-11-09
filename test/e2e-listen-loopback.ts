import { NestApplication } from '@nestjs/core';

// listen 하지 않은 앱에는 supertest 가 요청마다 임의 포트를 열고 닫는다. 그 포트를 다른 로컬 프로그램이 127.0.0.1 에
// 잡고 있으면 요청이 그 프로그램으로 가고(엉뚱한 501 · 404 · socket hang up), 동시 요청은 먼저 끝난 쪽이 서버를 닫아
// ECONNREFUSED 가 된다. init 직후 127.0.0.1 에 한 번만 열어 두면 운영체제가 쓰는 포트를 주지 않고 닫히지도 않는다.
/* eslint-disable @typescript-eslint/unbound-method -- 아래에서 원래 인스턴스로 call 한다 */
const { init, listen } = NestApplication.prototype;
/* eslint-enable @typescript-eslint/unbound-method */
const listening = new WeakSet<NestApplication>();

NestApplication.prototype.init = async function (this: NestApplication) {
  await init.call(this);
  if (!listening.has(this)) {
    listening.add(this);
    await listen.call(this, 0, '127.0.0.1');
  }
  return this;
};

// 시험이 직접 부르는 app.listen(0) 은 이미 연 서버를 그대로 쓴다.
NestApplication.prototype.listen = async function (this: NestApplication) {
  if (!listening.has(this)) await this.init();
  return this.getHttpServer() as unknown;
};
