FROM node:22-slim

RUN apt-get update && apt-get install -y git openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app
COPY . .

# --ignore-scripts avoids lefthook (needs .git); rebuild native deps explicitly
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm rebuild better-sqlite3 esbuild
RUN pnpm build

# Use a temp data dir inside the container
ENV PANOPTICON_DATA_DIR=/tmp/panopticon-test
ENV PANOPTICON_PORT=4318
ENV NODE_NO_WARNINGS=1
# Accept self-signed cert from mock upstream
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

CMD ["node", "test/integration/run.mjs"]
