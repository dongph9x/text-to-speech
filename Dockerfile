# syntax=docker/dockerfile:1

FROM node:20-bullseye AS base
ENV NODE_ENV=production
WORKDIR /app

# Install minimal OS deps (ca-certificates for HTTPS)
# Install build tools for any optional native builds (kept minimal)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Only copy package manifests first for better caching
COPY package.json package-lock.json* ./

# Install production dependencies
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy app source
COPY src ./src
COPY scripts ./scripts
COPY README.md ./

# Optional: copy example configs (real configs mounted at runtime)
COPY configs/allowed_roles.example.json ./configs/allowed_roles.example.json

# Start the bot
CMD ["npm", "start"]


