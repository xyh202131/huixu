FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN VITE_HUIXU_STUDIO=1 npm run build

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu libgl1 libglib2.0-0 p7zip-full python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY web/server/requirements.txt /tmp/huixu-requirements.txt
RUN python3 -m venv /opt/huixu-python \
    && /opt/huixu-python/bin/pip install --no-cache-dir -r /tmp/huixu-requirements.txt
ENV NODE_ENV=production HUIXU_MEMORY_PYTHON=/opt/huixu-python/bin/python HUIXU_DATA_DIR=/mnt/workspace/huixu
COPY web/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY web/server ./server
COPY web/src ./src
COPY --from=build /app/dist ./dist
COPY deploy/studio-entrypoint.sh /usr/local/bin/huixu-studio
RUN chmod 0755 /usr/local/bin/huixu-studio
EXPOSE 7860
ENTRYPOINT ["/usr/local/bin/huixu-studio"]
CMD ["node", "server/studio.js"]
