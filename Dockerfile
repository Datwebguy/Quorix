# QuorixASP production image: Express broker + okx-a2a XMTP daemon + onchainos CLI.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

# onchainos CLI (verified checksum install from okx/onchainos-skills releases)
ENV INSTALL_DIR=/root/.local/bin
ENV PATH="/root/.local/bin:${PATH}"
RUN curl -fsSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh -o /tmp/install-onchainos.sh \
  && sh /tmp/install-onchainos.sh \
  && rm /tmp/install-onchainos.sh \
  && onchainos --version

# okx-a2a (XMTP listener) + Codex CLI (AI provider for inbound A2A task dispatch)
# Pin versions to match your working laptop: okx-a2a 0.1.5, codex 0.142.5
RUN npm install -g pm2 @okxweb3/a2a-node@0.1.5 @openai/codex@0.142.5 \
  && okx-a2a --version \
  && codex --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY index.html login.html dashboard.html admin.html favicon.ico ./
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

COPY ecosystem.config.cjs ./
COPY scripts/fly-entrypoint.sh /usr/local/bin/fly-entrypoint.sh
RUN chmod +x /usr/local/bin/fly-entrypoint.sh

ENV NODE_ENV=production
# Fly injects PORT=8080 at runtime; Express reads process.env.PORT (src/config/env.ts).
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/fly-entrypoint.sh"]