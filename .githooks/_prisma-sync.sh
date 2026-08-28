#!/bin/sh
# 두 훅이 공유하는 본체. $1=이전 ref, $2=이후 ref
# pnpm 은 의존성에 변화가 없으면 "Already up to date" 로 조기 종료하며
# 루트 postinstall 까지 건너뛴다. 그래서 스키마만 바뀐 pull 에서는
# prisma generate 가 돌지 않는다. 이 훅이 그 구멍을 메운다.
set -e
changed=$(git diff --name-only "$1" "$2" 2>/dev/null || true)

if printf '%s\n' "$changed" | grep -q '^prisma/schema\.prisma$'; then
  echo "[githook] prisma/schema.prisma 변경 감지 → prisma generate"
  pnpm exec prisma generate >/dev/null 2>&1 \
    && echo "[githook] Prisma 클라이언트 재생성 완료" \
    || echo "[githook] 재생성 실패. 'pnpm db:generate' 를 직접 실행하세요." >&2
fi

if printf '%s\n' "$changed" | grep -q '^prisma/migrations/'; then
  echo "[githook] 새 마이그레이션이 있습니다. 로컬 DB 를 쓴다면 'pnpm db:deploy' 를 실행하세요."
fi
