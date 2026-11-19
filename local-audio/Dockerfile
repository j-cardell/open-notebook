FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates libvulkan-dev glslc spirv-headers glslang-tools pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --recurse-submodules https://github.com/ServeurpersoCom/qwentts.cpp.git .
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON \
    && cmake --build build --target tts-server qwen-tts -j"$(nproc)" \
    && mkdir -p /out/lib \
    && find build -name '*.so*' -exec cp -P {} /out/lib/ \;

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg libvulkan1 mesa-vulkan-drivers \
    python3 python3-venv python3-dev git build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY --from=builder /src/build/tts-server /src/build/qwen-tts /app/bin/
COPY --from=builder /out/lib/ /usr/local/lib/
RUN ldconfig

RUN uv venv /app/.venv --python python3 \
    && uv pip install --python /app/.venv/bin/python --index-url https://download.pytorch.org/whl/rocm6.3 \
       torch torchaudio torchvision \
    && uv pip install --python /app/.venv/bin/python --extra-index-url https://download.pytorch.org/whl/rocm6.3 \
       "numpy<2" "git+https://github.com/R3gm/infer_rvc_python.git"

COPY tts_proxy.py /app/tts_proxy.py

RUN mkdir -p /app/models /app/voices /app/rvc_models \
    && curl -fsSL -o /app/rnnoise_sh.rnnn \
       https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn

EXPOSE 8083
CMD ["/app/.venv/bin/python", "/app/tts_proxy.py"]
