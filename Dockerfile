# ── build: 개발 의존성까지 설치해 빌드한다 ──
FROM node:24.22.1-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.18.0

# 의존성 파일만 먼저 복사해, prisma/ 만 바뀐 빌드는 install 층을 캐시에서 쓴다.
# postinstall(scripts/setup-hooks.mjs)의 prisma generate 는 schema 가 없어 경고만 남기고 넘어가므로,
# 소스를 복사한 뒤 직접 생성한다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/setup-hooks.mjs ./scripts/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm exec prisma generate && pnpm build

# ── prod-deps: 운영 의존성만 남긴다(생성된 Prisma 클라이언트는 남는다) ──
FROM build AS prod-deps
RUN pnpm prune --prod

# ── runtime ──
FROM node:24.22.1-slim
# 프로파일은 빌드 인자로 받아 이미지에 굳힌다. 값(비밀)은 굳히지 않는다.
# NODE_ENV 를 build 단계에 두지 않는 이유: production 이면 pnpm 이 개발 의존성을 빼고 설치해 nest build 가 깨진다.
ARG APP_ENV=dev
ARG NODE_ENV=development
# process.env 가 .env 파일보다 우선하므로, 파일에 APP_ENV · NODE_ENV · PORT 가 있어도 이 값이 이긴다.
# PORT 는 컨테이너 안에서 고정하고, 밖의 포트는 docker run -p 로 프로파일마다 정한다.
ENV APP_ENV=$APP_ENV \
    NODE_ENV=$NODE_ENV \
    PORT=8000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8000
# ConfigModule 이 /app/.env.$APP_ENV 를 읽는다 — 배포 때 그 경로에 읽기 전용으로 마운트한다.
CMD ["node", "dist/main"]
