FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/assets /app/data

ENV PORT=8000

EXPOSE 8000

CMD ["node", "src/index.js"]