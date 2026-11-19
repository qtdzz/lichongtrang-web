# The image a self-hosted server pulls.
#
# Two stages: Node 22 builds and verifies the static PWA with Vite and Vitest, and nginx:alpine
# serves the resulting dist/ directory.
#
#   make docker-build        # build the image locally
#   make docker-publish      # build and push :latest

# ---------- build & verify the site ----------
FROM node:22-bookworm-slim AS build

WORKDIR /src
COPY package.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund
COPY . /src
# Builds dist/ (minified JS/CSS + build-info.json + sw.js) and runs Vitest unit, 132-answer JVM
# corpus, offline precache audit, and service worker tests. Any failure stops the image build.
RUN npm run check

# ---------- serve it ----------
FROM nginx:alpine

# Nothing is configured at runtime and nothing is persisted: the site is static and the offline story
# lives in the service worker, not on the server. dist/ includes /LICENSE.txt and /NOTICE.txt.
COPY --from=build /src/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

EXPOSE 80
