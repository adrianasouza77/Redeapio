FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/src ./src
COPY backend/migrations ./migrations
COPY backend/scripts ./scripts
COPY frontend /frontend

ENV NODE_ENV=production
ENV FRONTEND_DIR=/frontend
EXPOSE 3000

CMD ["node", "src/server.js"]
