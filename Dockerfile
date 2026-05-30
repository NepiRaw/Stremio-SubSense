FROM node:20-slim

WORKDIR /app

# Create data directory for SQLite database
RUN mkdir -p /app/data

RUN apt-get update && apt-get install -y python3 make g++ bzip2 liblzma-dev && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application files
COPY . .

# Set environment variables
ENV PORT=3100
ENV HOST=0.0.0.0

# Expose the port
EXPOSE 3100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "const port = process.env.PORT || 3100; require('http').get('http://localhost:' + port + '/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

# Start the application
CMD ["npm", "start"]
