# Multi-stage: compile with dev dependencies, ship without them.
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — no TypeScript, no test runner in the image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# server.ts resolves the UI at `dist/../public`, so this must sit beside dist.
COPY public ./public

# Never run as root. If the process is ever compromised, this is the difference
# between "read the app directory" and "own the container".
USER node

EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0

# Secrets come from the platform's environment, never from a build arg or a
# baked-in file — a build arg is visible in the image history.
CMD ["node", "dist/server.js"]
