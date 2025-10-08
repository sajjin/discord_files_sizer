FROM node:18-alpine

WORKDIR /app

# Install wget for health checks
RUN apk add --no-cache wget

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY server.js ./

# Create uploads directory
RUN mkdir -p uploads

# Expose port
EXPOSE 51242

# Set environment variables (override with docker-compose)
ENV PORT=51242
ENV NODE_ENV=production

# Run the application
CMD ["node", "server.js"]