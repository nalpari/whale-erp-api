import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * BP 회원가입. 형식 검사는 front 회원가입 화면(`validators.ts`)과 같은 규칙이다. 비밀번호 규칙은
 * 메시지를 화면 문구와 맞추려고 서비스(`validateAdminPassword`)에서 본다.
 */
export class SignupDto {
  /**
   * 영문 또는 영문·숫자 4~20자. 소문자로 정규화해 저장한다 — 대소문자만 다른 아이디 둘이 생기지
   * 않게. 관리자 웹 로그인도 같은 정규화로 조회해야 한다.
   */
  @Transform(trimLower)
  @Matches(/^(?=.*[a-z])[a-z0-9]{4,20}$/, {
    message: '영문·숫자 조합으로 4~20자로 입력해 주세요.',
  })
  loginId: string;

  /** 영문·숫자·특수문자(!@#$%^&*()-_=+[]{}?)를 모두 포함해 8~20자 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  /** 한글 또는 영문 2~20자 */
  @Transform(trim)
  @Matches(/^[A-Za-z가-힣]{2,20}$/, {
    message: '한글 또는 영문 2~20자로 입력해 주세요.',
  })
  name: string;

  /** 숫자만 10~11자리. 화면의 세 칸을 이어 붙인 값이다 */
  @Matches(/^[0-9]{10,11}$/, {
    message: '숫자만, 세 칸을 합쳐 10~11자리로 입력해 주세요.',
  })
  phone: string;

  /** 아이디 찾기·임시 비밀번호가 이 주소로 간다. 소문자로 정규화한다(admin_accounts_email_lower) */
  @Transform(trimLower)
  @IsEmail({}, { message: '이메일 형식으로 입력해 주세요.' })
  @MaxLength(254)
  email: string;

  /** 상호명 1~50자. 사업자 인증 결과로 채우지 않고 직접 입력한다 */
  @Transform(trim)
  @IsString()
  @Length(1, 50, { message: '상호명은 1~50자로 입력해 주세요.' })
  tradeName: string;

  /** 이용약관(TERMS_SERVICE) 동의. 필수라 true 여야 가입된다 */
  @IsBoolean()
  agreeTermsOfUse: boolean;

  /** 개인정보 수집·이용(PRIVACY_COLLECT) 동의. 필수라 true 여야 가입된다 */
  @IsBoolean()
  agreePrivacy: boolean;
}
