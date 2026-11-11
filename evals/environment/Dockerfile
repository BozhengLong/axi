FROM oven/bun:1.3.14-debian
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates ripgrep iptables iproute2 util-linux procps \
    && rm -rf /var/lib/apt/lists/*
# 两个被测工具使用同一镜像。只在构建时下载固定版本。
ENV BUN_INSTALL=/opt/claude
RUN bun install -g @anthropic-ai/claude-code@2.1.322 \
    && chmod -R a+rX /opt/claude \
    && claude --version
COPY src /opt/axi/src
COPY scripts/eval/container /opt/eval
COPY evals/environment/entrypoint.sh /usr/local/bin/eval-entrypoint
RUN chmod 755 /usr/local/bin/eval-entrypoint \
    && mkdir -p /task /home/eval && chown -R 1000:1000 /task /home/eval
ENV HOME=/home/eval TERM=xterm-256color LANG=C.UTF-8 TZ=Asia/Shanghai NO_COLOR=1
WORKDIR /task
ENTRYPOINT ["/usr/local/bin/eval-entrypoint"]
CMD ["sleep", "infinity"]
