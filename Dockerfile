FROM node:22-bookworm-slim

WORKDIR /app

# better-sqlite3 собирается нативно — инструменты нужны только на время установки
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
# Сборки нет: TypeScript исполняется через tsx, как в tg-analytics.
# Миграции базы применяются при старте, отдельного шага не нужно.
CMD ["npx", "tsx", "src/index.ts"]
