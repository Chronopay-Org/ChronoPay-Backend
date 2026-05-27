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

# Start the application
CMD ["node", "dist/index.js"]
