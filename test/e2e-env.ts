// e2e 공통 환경. AppModule 이 근로계약 발송 때문에 AlimtalkModule 을 import 해(2026-10-16) BIZPPURIO_* 가 비면 앱이
// 뜨지 않는다. 테스트는 실제로 보내지 않으므로(바깥 발송은 fake-alimtalk.ts 로 갈아 끼운다) 비어 있을 때만 형식만 맞는
// 값을 넣는다 — 이미 있는 값(로컬 .env · CI)은 그대로 둔다. 대체 문자 발신번호가 없으면 가입 초대 발송이 503 이라 함께 넣는다.
const DUMMY = {
  BIZPPURIO_BASE_URL: 'https://bizppurio.invalid',
  BIZPPURIO_ACCOUNT: 'e2e',
  BIZPPURIO_PASSWORD: 'e2e',
  BIZPPURIO_SENDER_KEY: 'e2e',
  BIZPPURIO_SMS_FROM: '0212345678',
};
for (const [key, value] of Object.entries(DUMMY)) process.env[key] ||= value;

// 직원 앱 주소 — 근로계약 발송이 초대 링크를 만들 때 없으면 503 이다. 계약을 쓰는 스위트마다 따로 넣지 않게 여기서 비어 있을 때만
// 채운다(WHALEERP-616). 주소를 시험하는 스위트(비밀번호 재설정 링크 · 직원 가입)는 자기 값을 직접 넣는다.
process.env.STAFF_APP_URL ||= 'https://staff.e2e.test';
