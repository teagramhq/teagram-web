FROM golang:1.27.2-alpine AS failover-monitor-build

WORKDIR /monitor

COPY deploy/k8s/failover-monitor/ ./

RUN mkdir -p /out \
  && GO111MODULE=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags='-s -w' -o /out/web-failover-monitor .

FROM node:24.18.0-alpine AS artifact-verification

WORKDIR /workspace

COPY ci/private-mtproto-target.json ci/private-mtproto-server-public.pem ci/
COPY CHANGELOG*.md ./
COPY scripts/mtproto-target.mjs scripts/private-artifact-csp.mjs scripts/private-artifact.mjs scripts/private-artifact-release.mjs scripts/verify-deployment-artifact.mjs scripts/
COPY src/lib/lottie/lottieLoader.ts src/lib/lottie/lottieLoader.ts
COPY src/config/emoji.ts src/config/emoji.ts
COPY dist-private/ dist-private/

ARG PRIVATE_ARTIFACT_COMMIT
RUN node scripts/verify-deployment-artifact.mjs --dist dist-private --commit "$PRIVATE_ARTIFACT_COMMIT"

FROM nginx:stable-alpine3.20

# Only the audited static artifact crosses from the Node verification stage.
# Nginx remains the web runtime; the failover binary is idle unless a pod overrides the command.
RUN rm -rf /usr/share/nginx/html \
  && mkdir -p /usr/share/nginx/html \
  && rm -f /etc/nginx/conf.d/default.conf \
  && mkdir -p /var/cache/nginx \
  && chown -R nginx:nginx /var/cache/nginx

COPY deploy/teagram-web/nginx.conf /etc/nginx/nginx.conf
COPY deploy/teagram-web/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=artifact-verification /workspace/dist-private/ /usr/share/nginx/html/
COPY --from=failover-monitor-build /out/web-failover-monitor /usr/local/bin/web-failover-monitor

EXPOSE 8080
