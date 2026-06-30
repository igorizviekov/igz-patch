FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.142.3

COPY docker/no-dump.c /tmp/no-dump.c

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates gcc git libc6-dev ripgrep \
  && gcc -shared -fPIC -O2 -o /usr/local/lib/libigzpatch-nodump.so /tmp/no-dump.c \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && apt-get purge --yes --auto-remove gcc libc6-dev \
  && rm -f /tmp/no-dump.c \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

ENTRYPOINT ["codex"]
