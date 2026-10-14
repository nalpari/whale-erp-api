import { Transform } from 'class-transformer';
import {
  Equals,
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
 *
 * 아이디 · 이메일 규칙은 중복 확인 DTO 두 개에도 그대로 적혀 있다. Swagger 플러그인이 데코레이터에 바로 쓴
 * 정규식만 스키마로 옮기므로 상수나 묶은 데코레이터로 빼지 않는다 — 어긋나지 않는 것은
 * `availability.dto.spec.ts` 가 지킨다.
 */
export class SignupDto {
  /**
   * 영문 또는 영문·숫자 4~20자. 소문자로 정규화해 저장한다. 플랫폼 관리자 등록은 대소문자를 그대로 두므로,
   * 관리자 웹 로그인은 아이디를 대소문자 무시로 조회해야 한다(`isLoginIdAvailable` 참고).
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

  /** 이용약관(TERMS_SERVICE) 동의. 필수라 true 만 받는다 */
  @Equals(true, { message: '필수 약관에 모두 동의해 주세요.' })
  agreeTermsOfUse: boolean;

  /** 개인정보 수집·이용(PRIVACY_COLLECT) 동의. 필수라 true 만 받는다 */
  @Equals(true, { message: '필수 약관에 모두 동의해 주세요.' })
  agreePrivacy: boolean;
}
