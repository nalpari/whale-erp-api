// core.hooksPath 를 .githooks 로 맞춘다.
// git 저장소가 아니거나(예: tarball 설치) git 이 없는 CI 에서도 install 이
// 실패하면 안 되므로 어떤 오류도 삼킨다.
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    stdio: 'ignore',
  });
} catch {
  // 무시: 훅은 편의 기능이고, 없다고 빌드가 막히면 안 된다.
}
