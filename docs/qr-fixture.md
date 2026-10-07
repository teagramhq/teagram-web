# Credential-free QR card fixture

The synthetic browser fixture mounts the existing `SignQRCard` in its own development-only page. It uses a fixed manager proxy and a fresh Chromium context; it does not start the normal application bootstrap or access Telegram authentication services.

## Run it

Install the locked dependencies and Chromium once:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
```

Run the focused browser review:

```sh
corepack pnpm exec playwright test e2e/qrLoginUnsupportedState.spec.ts --config=playwright.qr-fixture.config.ts --project=qr-fixture-chromium
```

Playwright starts the Vite server on `127.0.0.1:8173` with a clean process environment, the pinned `wss://qr-fixture.invalid/` private target and the committed test public key. It stops that server when the command exits; pressing Ctrl+C stops the run and server together. The server refuses to reuse an existing process on that port.

The fixture supports the fixed `input-method-invalid`, `network-bad-response-406` and `token` outcomes. The fixed `suggested-language=1` query flag enables a synthetic language string for keyboard-testing the real suggested-language action. Its control surface accepts only those outcome identifiers, that flag, and a fixed token-completion action. The smoke check verifies both failure states, their accessible retry or username escape, focus order, light and dark theme tokens, narrow layout, token loading, blocked worker creation, blocked service workers, and refusal of off-origin requests and WebSockets.

Run the focused production-artifact guard test with:

```sh
corepack pnpm exec vitest run scripts/qr-fixture-artifact.test.mjs
```

The browser project disables screenshots, video and traces. Its observations are DOM and browser-layout checks; they are not screen-reader output or evidence that QR sign-in works against a supported server.
