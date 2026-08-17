# --- Build stage: compila TypeScript -----------------------------------
FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

# --- Runtime stage -------------------------------------------------------
FROM node:20-bookworm-slim

# Chromium + ambiente gráfico virtual (Xvfb) + VNC + noVNC (acesso via navegador)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    supervisor \
    fonts-liberation \
    dumb-init \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Volume de dados persistentes: perfil do Chrome (sessão) + estado de sync
VOLUME ["/data"]

EXPOSE 6080

ENTRYPOINT ["dumb-init", "--"]
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
