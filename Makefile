# Convenience targets wrapping standard package.json scripts and Docker image publishing.

IMAGE ?= lichongtrang-web
TAG ?= latest
GIT_SHA ?= $(shell git rev-parse --short=7 HEAD 2>/dev/null || true)

.PHONY: check verify-browser docker-build docker-publish

## Build the production PWA (dist/) and run Vitest unit, corpus, and offline build checks.
check:
	./node_modules/.bin/vite build && ./node_modules/.bin/vitest run

## Build the site and run Playwright E2E and visual regression tests in Chromium.
verify-browser:
	./node_modules/.bin/playwright test --project=chromium

## Build the Docker image locally without pushing it.
docker-build:
	docker build --build-arg GIT_SHA=$(GIT_SHA) -t $(IMAGE):$(TAG) .

## Build and push the Docker image. On a self-hosted server afterwards:
##   docker compose pull && docker compose up -d
docker-publish: docker-build
	docker push $(IMAGE):$(TAG)
	@echo "published $(IMAGE):$(TAG)"
