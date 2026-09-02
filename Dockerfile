FROM node:24-slim

ARG TARGETARCH

WORKDIR /app

# Create data directory for SQLite database
RUN mkdir -p /app/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg dbus ca-certificates && \
    # Install Cloudflare WARP client
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" > /etc/apt/sources.list.d/cloudflare-client.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends cloudflare-warp && \
    # Install gost (SOCKS5 proxy)
    GOST_ARCH="${TARGETARCH:-amd64}" && \
    curl -fsSL "https://github.com/ginuerzh/gost/releases/download/v2.12.0/gost_2.12.0_linux_${GOST_ARCH}.tar.gz" | tar xz -C /usr/local/bin/ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

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

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]
