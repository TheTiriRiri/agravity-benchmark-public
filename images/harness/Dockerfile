# agrav-bench harness image
#
# Ships the Antigravity CLI (`agy`) plus the `run-attempt` orchestrator. Each
# benchmark attempt runs one `docker run` of this image against /workspace.
#
# Build — the tag is the one benchmark/runner.yaml's `image:` pins, and
# images/harness/IMAGE.md records what was built under it:
#   docker build -t agrav-bench/harness:2026-10-04 images/harness
# A new build under a new tag needs a new IMAGE.md entry, runner.yaml's
# `image:`, and a gate 3a run.
#
# Pin the exact agy release via build args so the resulting tag is fully
# reproducible. Bump deliberately, and re-verify the tarball's internal
# layout when you do — see images/harness/IMAGE.md.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl ca-certificates git jq \
      python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Pin the exact release. Values come from
#   https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json
# install.sh cannot pin (always "latest"), so fetch the tarball directly.
ARG AGY_VERSION=1.2.7
ARG AGY_BUILD=6731160148115456
ARG AGY_SHA512=fec769d611c4afdf0ae72d38bdb2652c8e2c8e71e4f6de97a27b80dda3c50429160d9e03776a36a59b8857c20e76783c4a49cb0feb8b2f5c3bf925b0cc03bb77
RUN curl -fsSL -o /tmp/agy.tgz \
      "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}-${AGY_BUILD}/linux-x64/cli_linux_x64.tar.gz" \
 && echo "${AGY_SHA512}  /tmp/agy.tgz" | sha512sum -c - \
 && tar -xzf /tmp/agy.tgz -C /usr/local/bin antigravity \
 && mv /usr/local/bin/antigravity /usr/local/bin/agy \
 && chmod 755 /usr/local/bin/agy && rm /tmp/agy.tgz
# Binary is root-owned; the container runs as the host uid, so the
# background updater has nowhere to write. Verified by the smoke test.

COPY run-attempt /usr/local/bin/run-attempt
RUN chmod +x /usr/local/bin/run-attempt
RUN mkdir -p /home/agy && chmod 777 /home/agy

# No USER directive: the runner passes --user $(id -u):$(id -g) at `docker
# run` time so eval-attempts/ stays host-owned while the agy binary itself
# stays root-owned and unwritable by the self-updater.

WORKDIR /workspace
ENTRYPOINT ["run-attempt"]
