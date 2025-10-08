FROM node:18-alpine

WORKDIR /app

# Install wget for health checks
RUN apk add --no-cache wget

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy bot code
COPY bot.js ./

# Create temp directory
RUN mkdir -p temp

# Set environment
ENV NODE_ENV=production

# Run the bot
CMD ["node", "bot.js"]