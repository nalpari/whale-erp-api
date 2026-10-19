export class AdminLoginIdFindResponseDto {
  /** 앞 2자와 뒤 1자만 보이고 나머지는 길이만큼 `*` 다. 전체 아이디는 오지 않는다. 예: ha******1 */
  maskedLoginId: string;
}
