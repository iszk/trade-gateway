# このディレクトリではなくてプロジェクトルートから -f api/Dockerfile でビルドするのを想定している

# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./
COPY ui/tsconfig.json ./ui/
COPY ui/package*.json ./ui/
COPY ui/vite.config.ts ./ui/

# update npm
RUN npm install -g npm@latest

# Install dependencies
RUN npm ci

# Copy source code
COPY ui/app ./ui/app

# Build TypeScript
RUN npm run build -w ui

# Runtime stage
FROM node:24-trixie

WORKDIR /app

# Copy package files
# FIXME ぜったい余計なファイルもコピーしちゃってる
COPY package*.json ./
COPY tsconfig*.json ./
COPY ui/tsconfig.json ./ui/
COPY ui/package*.json ./ui/
COPY ui/vite.config.ts ./ui/

# update npm
RUN npm install -g npm@latest

# Install only production dependencies
# RUN npm ci --omit=dev
# FIXME いったん devDependencies も入れる、tsx などを使いたいため
RUN npm ci

# Copy built application from builder
COPY --from=builder /app/ui/dist ./dist

# Set environment variables for Cloud Run
ENV NODE_ENV=production
ENV PORT=5173

# Cloud Run requires the service to listen on 0.0.0.0
EXPOSE 5173

# Start the application
CMD ["node", "dist/index.js"]
