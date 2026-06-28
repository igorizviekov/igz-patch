FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.142.3

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

ENTRYPOINT ["codex"]
