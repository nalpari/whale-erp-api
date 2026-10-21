/**
 * 메일을 보낼 수 있는 주소 하나. MailService 가 보내기 전에 이것으로 막는다. 직원 앱 이메일 변경 핀 요청 DTO 도
 * `IsSendableEmail`(길이를 먼저 본다)로 같은 규칙을 건다 — `@IsEmail` 은 RFC 상 맞는 따옴표 로컬 파트
 * (`"a"@example.com`)를 받지만 여기서는 막혀, 입력은 통과하고 발송만 실패하는 일(400 이어야 할 것이 500)이 생긴다
 * (api #85 리뷰). 받은 이메일로 나중에 메일을 보내는 다른 DTO(관리자 회원가입 · 플랫폼 관리자 저장 · 도입문의)는
 * 아직 이 규칙을 걸지 않는다.
 *
 * 쉼표·세미콜론이 있으면 nodemailer 가 받는 사람을 여럿으로 나누고, 꺾쇠·따옴표는 표시 이름으로 읽고, 콜론·괄호·
 * 역슬래시는 그룹·주석 문법이라 검사한 주소와 실제 받는 주소가 달라진다.
 */
export const SENDABLE_EMAIL =
  /^[^\s@,;<>"():\\]+@[^\s@,;<>"():\\]+\.[^\s@,;<>"():\\]+$/;

/**
 * RFC 5321 경로 상한 256 에서 꺾쇠 둘을 뺀 값(UTF-16 글자 수로 센다). SENDABLE_EMAIL 은 도메인 쪽 `.` 위치를 하나하나
 * 다시 맞춰 보느라, 끝이 맞지 않는 입력에서 길이의 제곱만큼 일한다(10만 자에 수 초, 그동안 이벤트 루프가 멈춘다).
 * 그래서 정규식보다 먼저 길이로 거부한다.
 */
export const MAX_EMAIL_LENGTH = 254;

export function isSendableEmail(address: string): boolean {
  return address.length <= MAX_EMAIL_LENGTH && SENDABLE_EMAIL.test(address);
}
