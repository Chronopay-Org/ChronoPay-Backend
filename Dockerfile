# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source code and config
COPY tsconfig.json ./
COPY src ./src

# Build the application
RUN npm run build

# Remove development dependencies
RUN npm prune --production

# Stage 2: Production
FROM node:20-alpine AS runner

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Copy only necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Expose the application port
EXPOSE 3001

# Use a non-root user for security
USER node

# Probe /live rather than /health/ready so external dependencies do not affect liveness
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Start the application
CMD ["node", "dist/index.js"]
