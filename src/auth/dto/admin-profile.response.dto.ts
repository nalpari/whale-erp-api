/** 내 정보(MY PAGE) 조회 응답 — manyfast F-AMTDCK > S-JXKHCM. */
export class AdminProfileResponseDto {
  /** 아이디. 바꿀 수 없다. */
  loginId: string;

  /** 이름. */
  name: string;

  /** 연락처 — 하이픈 없이 숫자 9~12자리. */
  phone: string;

  /** 이메일. */
  email: string;

  /** 권한 유형 — 공통코드 `ROLE_TYPE`(PM · PA · BM · BA · FM · FA). 한글은 enum 이 아니라
   * 공통코드라 `GET /enums`로 못 받는다(아직 공통코드 조회 API 가 없다, naming.md) — 틀린
   * 주석을 바로잡는다(코드 리뷰로 찾음, 2026-10-21). */
  roleTypeCode: string;

  /** 가입일시. */
  createdAt: Date;

  /** 최근 로그인 일시 — 로그인한 적 없으면 null. */
  lastLoginAt: Date | null;

  /** 저장할 때 동시 수정 검사에 그대로 돌려줘야 하는 값(PATCH 의 updatedAt). */
  updatedAt: Date;
}
