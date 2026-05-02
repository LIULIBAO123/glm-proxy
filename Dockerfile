FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /app/data

EXPOSE 3003

ENV PORT=3003
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

CMD ["node", "src/index.js"]
