/** 내 정보(MY PAGE) 조회 응답 — manyfast F-AMTDCK > S-JXKHCM. */
export class AdminProfileResponseDto {
  /** 아이디. 바꿀 수 없다. */
  loginId: string;

  /** 이름. */
  name: string;

  /** 연락처 — 하이픈 없이 숫자 10~11자리. */
  phone: string;

  /** 이메일. */
  email: string;

  /** 권한 유형 코드 — 공통코드 `ROLE_TYPE`. 한글은 화면이 `GET /enums`로 받는다(네이밍 규칙). */
  roleTypeCode: string;

  /** 가입일시. */
  createdAt: Date;

  /** 최근 로그인 일시 — 로그인한 적 없으면 null. */
  lastLoginAt: Date | null;
}
