# Test image. Deliberately built without apt: the run uses --network none, so there is
# nothing to fetch, and the only HTTP client we need is the Bun binary we mount in.
FROM ubuntu:22.04
RUN mkdir -p /work /out /opt/plugin /z /b
