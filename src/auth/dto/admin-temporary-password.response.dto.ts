export class AdminTemporaryPasswordResponseDto {
  /** 메일을 보낸 뒤에만 오는 응답이다. 맞는 계정이 없으면 404, 메일을 못 보내면 503 이다. */
  message: string;
}
