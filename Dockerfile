FROM node:20-alpine AS builder

WORKDIR /app

# sharp requires native binaries — ensure alpine/musl compatible build
RUN apk add --no-cache python3 make g++ vips-dev

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Runtime deps for sharp (vips)
RUN apk add --no-cache vips

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
