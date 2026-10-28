FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DB_PATH=/data/botkin.db PORT=3000
# Mount a volume at /data (docker run -v ..., or a Railway volume).
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
