# このディレクトリではなくプロジェクトルートから -f ui/Dockerfile でビルドするのを想定している

# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./
COPY api/tsconfig.json ./api/
COPY api/package*.json ./api/
COPY ui/tsconfig.json ./ui/
COPY ui/package*.json ./ui/
COPY ui/vite.config.ts ./ui/

# Install dependencies
RUN npm ci

# Copy source code
COPY api/src ./api/src
COPY ui/app ./ui/app
COPY ui/public ./ui/public

# Build client assets and server bundle
RUN npm run build -w ui

# Runtime stage
FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY api/package*.json ./api/
COPY ui/package*.json ./ui/

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built application from builder
COPY --from=builder /app/ui/dist ./ui/dist

ENV NODE_ENV=production
ENV PORT=5173

WORKDIR /app/ui

EXPOSE 5173

# Start the application
CMD ["node", "dist/server/server.js"]
