FROM node:26-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl ca-certificates xz-utils \
    libegl1 libgles2 libgl1 libgl1-mesa-dri libvulkan1 mesa-vulkan-drivers \
    libx11-6 libxi6 libxrender1 libxfixes3 libxkbcommon0 libsm6 libice6 libxxf86vm1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
ARG BLENDER_VERSION=4.5.3
ARG BLENDER_SHA256=975c58fcb244273838534bba771e64ad87739216b0f9b39a888531a49a72d845
RUN curl -fsSL "https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz" -o /tmp/blender.tar.xz \
    && echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - \
    && mkdir /opt/blender && tar -xJf /tmp/blender.tar.xz --strip-components=1 -C /opt/blender \
    && rm /tmp/blender.tar.xz
ENV BLENDER_EXECUTABLE=/opt/blender/blender \
    FIDELITY_SOFTWARE_RENDERING=1 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe \
    LP_NUM_THREADS=8 OMP_NUM_THREADS=8 XDG_RUNTIME_DIR=/tmp \
    HUSKY=0 CI=true
WORKDIR /app
COPY . .
RUN npm install --global pnpm@11.0.8 \
    && pnpm install --frozen-lockfile && pnpm build \
    && node docker/scene-list.mjs > docker/scenes.json \
    && python3 docker/dockergrid.py --describe > /tmp/description.json
# Debian may change the architecture suffix of the ICD file; discover it once.
RUN find /usr/share/vulkan/icd.d -name '*lvp*.json' -print -quit > /app/docker/lavapipe-icd
ENTRYPOINT ["/app/docker/entrypoint.sh"]
