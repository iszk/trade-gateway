# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# update npm
RUN npm install -g npm@latest

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Runtime stage
FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Set environment variables for Cloud Run
ENV NODE_ENV=production
ENV PORT=8080

# Cloud Run requires the service to listen on 0.0.0.0
EXPOSE 8080

# Start the application
CMD ["npm", "start"]
