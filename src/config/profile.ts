/**
 * 운영 여부 판정. 두 신호 중 하나라도 운영을 가리키면 운영으로 본다.
 *
 * APP_ENV 하나만 보면 값이 비어 있을 때(`APP_ENV=` 로 export 되거나 파일에서
 * 빈 값으로 딸려올 때) `'' !== 'prod'` 가 참이 되어 운영에서도 문서가 열린다.
 * 노출 방향으로 틀리는 편보다 막는 방향으로 틀리는 편이 낫다.
 */
export function isProduction(): boolean {
  return (
    process.env.APP_ENV === 'prod' || process.env.NODE_ENV === 'production'
  );
}
