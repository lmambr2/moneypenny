# Server-track STT: whisper.cpp (+ optional Vulkan for AMD).
# Build: docker build -t stt-whisper-cpp --build-arg WHISPER_VULKAN=1 .
#
# Ubuntu 24.04 for Vulkan: Debian bookworm's Vulkan headers lack
# vk::LayerSettingEXT required by current ggml-vulkan.
ARG WHISPER_VULKAN=0

FROM ubuntu:24.04 AS build
ARG WHISPER_VULKAN
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates pkg-config \
    && if [ "$WHISPER_VULKAN" = "1" ]; then \
         apt-get install -y --no-install-recommends \
           libvulkan-dev glslc vulkan-tools \
           spirv-headers glslang-dev glslang-tools \
           spirv-tools libshaderc-dev; \
       fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Pin for reproducible builds; bump intentionally when upgrading.
ARG WHISPER_CPP_REF=master
RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" https://github.com/ggml-org/whisper.cpp.git \
    && cd whisper.cpp \
    && cmake -B build \
         -DGGML_NATIVE=OFF \
         -DGGML_CCACHE=OFF \
         -DWHISPER_BUILD_TESTS=OFF \
         -DWHISPER_BUILD_EXAMPLES=ON \
         $( [ "$WHISPER_VULKAN" = "1" ] && echo -DGGML_VULKAN=ON || echo -DGGML_VULKAN=OFF ) \
    && cmake --build build -j"$(nproc)" \
    && install -m755 build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && (test -f build/bin/whisper-server && install -m755 build/bin/whisper-server /usr/local/bin/whisper-server || true) \
    # Shared libs (libwhisper / libggml / libggml-*) — required at runtime
    && mkdir -p /opt/whisper/lib \
    && find build -name 'libwhisper.so*' -o -name 'libggml*.so*' 2>/dev/null \
       | while read -r f; do cp -a "$f" /opt/whisper/lib/; done \
    && ls -la /opt/whisper/lib/

FROM ubuntu:24.04
ARG WHISPER_VULKAN=0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg ca-certificates libgomp1 \
    && if [ "$WHISPER_VULKAN" = "1" ]; then \
         apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers; \
       fi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=build /opt/whisper/lib/ /usr/local/lib/
RUN echo "/usr/local/lib" > /etc/ld.so.conf.d/whisper.conf && ldconfig
WORKDIR /app
COPY server.py /app/server.py
# system site packages / break-system-packages: slim container, no venv needed
RUN pip3 install --no-cache-dir --break-system-packages numpy==2.2.6

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
