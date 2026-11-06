# Host-integration layer, isolated: one process, no egress, no host paths.
# Build needs network (magpie CLI + bun). Run MUST use --network none.
#
#   docker build -t magpie-acp-test test/host
#   test/host/run.sh          # driver that builds + runs
FROM debian:bookworm-slim

ARG MAGPIE_VERSION=v0.1.2827
# amd64 | arm64  (docker's TARGETARCH)
ARG TARGETARCH=arm64
ARG BUN_VERSION=1.4.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# magpie CLI: headless build. The GUI build needs WebKitGTK and is not used here.
RUN curl -fsSL -o /usr/local/bin/magpie \
      "https://github.com/yetone/magpie/releases/download/${MAGPIE_VERSION}/magpie-cli-linux-${TARGETARCH}" \
 && chmod +x /usr/local/bin/magpie

# Bun must be preinstalled: with --network none magpie cannot download it, and
# hooks then never load (`magpie plugin --json` reports "loaded": null).
RUN case "$TARGETARCH" in \
      arm64) BUN_ARCH=aarch64 ;; \
      amd64) BUN_ARCH=x86_64 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
 && unzip -q -o /tmp/bun.zip -d /tmp/bunx \
 && mv "/tmp/bunx/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
 && chmod +x /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bunx \
 && bun --version

RUN useradd -m -u 10001 runner
USER runner

ENV HOME=/home/runner \
    XDG_CONFIG_HOME=/home/runner/.config \
    XDG_CACHE_HOME=/home/runner/.cache \
    MAGPIE_BUN=/usr/local/bin/bun \
    MAGPIE_NO_INSTALL=1

WORKDIR /work
ENTRYPOINT ["/bin/sh"]
