# Server-track STT: whisper.cpp (+ optional Vulkan for AMD).
# Build: docker build -t stt-whisper-cpp --build-arg WHISPER_VULKAN=1 .
ARG WHISPER_VULKAN=0

FROM debian:bookworm-slim AS build
ARG WHISPER_VULKAN
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates pkg-config \
    && if [ "$WHISPER_VULKAN" = "1" ]; then \
         apt-get install -y --no-install-recommends libvulkan-dev glslc vulkan-tools; \
       fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Pin a recent whisper.cpp; bump when upgrading.
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git \
    && cd whisper.cpp \
    && cmake -B build \
         -DGGML_NATIVE=OFF \
         -DWHISPER_BUILD_TESTS=OFF \
         -DWHISPER_BUILD_EXAMPLES=ON \
         $( [ "$WHISPER_VULKAN" = "1" ] && echo -DGGML_VULKAN=ON || echo -DGGML_VULKAN=OFF ) \
    && cmake --build build -j"$(nproc)" \
    && install -m755 build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && (test -f build/bin/whisper-server && install -m755 build/bin/whisper-server /usr/local/bin/whisper-server || true)

FROM python:3.12-slim-bookworm
ARG WHISPER_VULKAN=0
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates libgomp1 \
    && if [ "$WHISPER_VULKAN" = "1" ]; then \
         apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers; \
       fi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
WORKDIR /app
COPY server.py /app/server.py
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir numpy==2.2.6

ENV PORT=9000 \
    STT_MODEL=small \
    STT_DEVICE=auto \
    STT_MODELS_DIR=/models \
    WHISPER_BIN=whisper-cli \
    STT_EAGER_LOAD=1 \
    STT_BACKEND=whisper-cpp

VOLUME ["/models"]
EXPOSE 9000
CMD ["python3", "-u", "/app/server.py"]
