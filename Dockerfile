FROM node:22-slim AS base

# Install git (needed for update checker) and build essentials (needed for better-sqlite3)
RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
RUN npm config set fetch-retries 5 \
    && npm config set fetch-retry-factor 2 \
    && npm config set fetch-retry-mintimeout 10000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && attempt=1 \
    && until npm ci; do \
      if [ "$attempt" -ge 3 ]; then \
        exit 1; \
      fi; \
      echo "npm ci failed on attempt ${attempt}; retrying..." >&2; \
      sleep $((attempt * 5)); \
      attempt=$((attempt + 1)); \
    done

# Copy source
COPY . .

# Build
RUN SWARMCLAW_BUILD_MODE=1 npm run build:ci

# Build the AI Signal extension's page bundle. The extension ships in the image
# as source plus dist, and is installed into the data directory at run time with
# `node extensions/aisignal/scripts/install.mjs`; nothing in it is needed from
# node_modules after the build, so the tree is dropped before the copy below.
RUN cd /app/extensions/aisignal && npm ci && npm run build && rm -rf node_modules

# The tts and video extensions the same way. Both are installed into the data
# directory at run time with `node extensions/<name>/scripts/install.mjs`; each
# install script prints what is still missing before either module can work.
RUN cd /app/extensions/tts && npm ci && npm run build && rm -rf node_modules
RUN cd /app/extensions/video && npm ci && npm run build && rm -rf node_modules

# Production
FROM node:22-slim AS runner

# ffmpeg carries ffprobe, which the tts extension measures every synthesised
# mp3 with and the video module's narration step needs on a VPS as much as on a
# Mac. The render itself does not run here (it needs the Remotion project, the
# Chrome Headless Shell and the macOS system fonts), and the render tool refuses
# by name on this host rather than producing a differently typeset video.
RUN apt-get update && apt-get install -y git curl unzip ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=base /app/.next/standalone ./
COPY --from=base /app/.next/static ./.next/static
COPY --from=base /app/public ./public
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./
COPY --from=base /app/extensions/aisignal ./extensions/aisignal
COPY --from=base /app/extensions/tts ./extensions/tts
COPY --from=base /app/extensions/video ./extensions/video

# Data directory (mount as volume for persistence)
RUN mkdir -p /app/data

ENV NODE_ENV=production
# The port the server binds, and the port it writes into run/port.json, which is
# how the tts extension's MCP shim finds the host (extensions/tts/mcp/server.mjs).
# Changing this changes both together; the shim reads the file and never assumes
# a port.
ENV PORT=3456
ENV HOSTNAME=0.0.0.0
# One fixed public origin, so Google OAuth uses a "Web application" client with
# that origin's callback registered. See src/lib/server/oauth/google.ts.
ENV SWARMCLAW_DEPLOY_MODE=vps

EXPOSE 3456
EXPOSE 3457

CMD ["node", "server.js"]
