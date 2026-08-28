// install 후처리. 어떤 실패도 install 을 막지 않는다.
//
// 1) prisma generate — prisma 는 devDependency 라 `pnpm install --prod` 나
//    NODE_ENV=production 설치에는 존재하지 않는다. 그 경우 생성은 건너뛴다.
//    (운영 이미지는 빌드 단계에서 이미 생성된 산출물을 갖고 온다.)
// 2) core.hooksPath — git 이 없거나 저장소가 아니어도 무시한다.
//
// 두 작업은 독립이다. 하나가 실패해도 다른 하나는 실행한다.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const run = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (existsSync('node_modules/prisma') || existsSync('node_modules/.bin/prisma')) {
  if (!run('node_modules/.bin/prisma', ['generate'])) {
    console.warn('[setup] prisma generate 실패. 필요하면 `pnpm db:generate` 를 실행하세요.');
  }
} else {
  console.warn('[setup] prisma 없음(운영 설치로 보임). 클라이언트 생성을 건너뜁니다.');
}

run('git', ['config', 'core.hooksPath', '.githooks']);
