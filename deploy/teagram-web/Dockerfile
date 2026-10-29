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
# The final serving image remains an Nginx-only runtime.
RUN rm -rf /usr/share/nginx/html \
  && mkdir -p /usr/share/nginx/html \
  && rm -f /etc/nginx/conf.d/default.conf \
  && mkdir -p /var/cache/nginx \
  && chown -R nginx:nginx /var/cache/nginx

COPY deploy/teagram-web/nginx.conf /etc/nginx/nginx.conf
COPY --from=artifact-verification /workspace/dist-private/ /usr/share/nginx/html/

EXPOSE 8080
