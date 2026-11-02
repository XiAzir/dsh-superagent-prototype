FROM node:24-bookworm

ENV LANG=C.UTF-8
ENV LANGUAGE=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git openssh-server python3 tmux procps ripgrep ffmpeg make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
    --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
    pnpm@11.7.0 @deepseek-ai/dsh@0.2.1-rc.5

WORKDIR /workspace
