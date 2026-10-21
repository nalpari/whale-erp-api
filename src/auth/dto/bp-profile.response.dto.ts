/** 내 정보(MY PAGE) 사업자정보 조회 응답 — manyfast F-AMTDCK > S-UOJVUR. BP 마스터만 받는다. */
export class BpProfileResponseDto {
  /** 상호명. */
  tradeName: string;

  /** 사업자등록번호 — 하이픈 없이 숫자 10자리. 인증 결과로만 바뀐다. 미인증이면 빈 문자열. */
  bizRegistrationNumber: string;

  /** 대표자명. 인증 결과로만 바뀐다. 미인증이면 빈 문자열. */
  bizCeoName: string;

  /** 개업일자(YYYY-MM-DD). 인증 결과로만 바뀐다. 미인증이면 null. */
  bizOpenDate: string | null;

  /** 대표자 연락처 — 하이픈 없이 숫자. */
  bizCeoPhone: string;

  /** 대표자 이메일. */
  bizCeoEmail: string;

  /** 사업장 우편번호. */
  bizZipCode: string;

  /** 사업장 기본주소. */
  bizAddress: string;

  /** 사업장 상세주소. */
  bizAddressDetail: string;

  /** 업태. */
  bizCategory: string;

  /** 종목. */
  bizItem: string;

  /** 최종 인증일시 — 인증한 적 없으면 null. */
  bizVerifiedAt: Date | null;

  /** 저장 · 재인증할 때 동시 수정 검사에 그대로 돌려줘야 하는 값. */
  updatedAt: Date;
}
