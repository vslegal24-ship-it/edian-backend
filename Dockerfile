FROM node:20-slim

RUN apt-get update && apt-get install -y \
    wget ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    libxtst6 xdg-utils --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

ENV PLAYWRIGHT_BROWSERS_PATH=/app/pw-browsers
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

COPY . .

EXPOSE 3001

CMD ["node", "src/index.js"]
