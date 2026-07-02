FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build
# precompile the server: plain node boots in ~100ms vs tsx's multi-second JIT
RUN npx esbuild server/src/index.ts --bundle --platform=node --format=esm \
    --packages=bundle --outfile=server/dist/index.mjs

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/dist/index.mjs"]
