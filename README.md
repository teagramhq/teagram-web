# Teagram Web

Teagram Web is a web client that supports private builds for the Teagram server. Accounts use a username and password only; phone and QR sign-in are not supported. Username/password sign-in is in progress (MAIN-1541), and web sign-in does not work yet.


### Developing
Install dependencies with:
```lang=bash
pnpm install
```
This will install all the needed dependencies.


#### Running web-server
Run `pnpm start` to start the web server and the livereload task. With no private MTProto target configured, it runs the stock Telegram client against Telegram's DCs and emits no private manifest. Only private mode targets the Teagram server.
Open http://localhost:8080/ in your browser.


#### Running in production

Build the reviewed private deployment artifact with `pnpm run build:deployment-artifact`. Production Vite builds without a valid private target fail closed; the verified `dist-private/` output is the only bundle accepted by the Telegram Web serving image.

#### Building a private MTProto artifact

Private artifacts are selected explicitly with these environment variables:

```bash
MTPROTO_TARGET_MODE=private
MTPROTO_PRIVATE_ENDPOINT=wss://mtproto.example.test:2443/apiws
MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE=/path/to/public-key.pem
```

The endpoint must be a normalized `wss://` URL outside `telegram.org` and its subdomains, and must target the Teagram server. The key file must contain exactly one 2048-bit RSA public key with exponent 65537 in either `RSA PUBLIC KEY` (PKCS#1) or `PUBLIC KEY` (SPKI) PEM format. It must not contain private key material.

Build the artifact with the same Vite command used by the project, for example:

```bash
MTPROTO_TARGET_MODE=private \
MTPROTO_PRIVATE_ENDPOINT=wss://mtproto.example.test:2443/apiws \
MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE=/path/to/public-key.pem \
pnpm exec vite build --outDir dist-private
```

The build fails closed when target validation or the production-bundle audit fails. The audit rejects Telegram MTProto hostnames and IPs, HTTP MTProto transports, Telegram or test RSA keys, and additional WSS targets. A successful private artifact contains a restrictive CSP and the `mtproto-target.json` sidecar with only `mode`, normalized `endpoint`, RSA `fingerprint`, `sourceCommit`, and the completed artifact `artifactDigest`. The digest excludes the sidecar itself. Verify an existing output with `MTPROTO_TARGET_MODE=private pnpm run check-bundle -- dist-private`; private mode fails if the sidecar is missing.

Do not edit the sidecar or swap endpoints and keys in an existing output. Build a new artifact with the desired three variables. Production builds fail closed when the private target is missing or invalid. For the deployment artifact, use `pnpm run build:deployment-artifact`; it loads the checked-in reviewed target, verifies its key hash, builds into `dist-private`, and verifies the result.

The `Private MTProto Artifact Request` workflow is the data-only manual entry point. It accepts a target ref as input and records it without checking out code or installing dependencies. The trusted `Private MTProto Artifact Publication` workflow receives only successful requests from the reviewed `master` workflow, resolves `refs/heads/master` or an exact release tag listed with its reviewed commit in `ci/private-artifact-reviewed-release-refs.json`, and rejects every other ref before dependency installation. It snapshots the reviewed target attestation and public key before the build, checks out only the allowlisted commit, and re-verifies the downloaded bundle, sidecar digest, source commit, CSP, and snapshot in an isolated publisher before upload. Changing the workflow definition, target, public-key bytes, or source commit without passing the reviewed request and snapshot checks fails closed.

### Running in docker

#### Developing: 
* Install dependencies `docker-compose up tweb.dependencies`.
* Run develop container `docker-compose up tweb.develop `.
* Open http://localhost:8080/ in your browser. 

#### Production:
* Run `docker-compose up tweb.production -d` nginx image and container to serve the build
* Open http://localhost:80/ in your browser.

You can use `docker build -f ./.docker/Dockerfile_production -t {dockerhub-username}/{imageName}:{latest} .` to build your production ready image.

### Dependencies
* [BigInteger.js](https://github.com/peterolson/BigInteger.js) ([Unlicense](https://github.com/peterolson/BigInteger.js/blob/master/LICENSE))
* [fflate](https://github.com/101arrowz/fflate) ([MIT License](https://github.com/101arrowz/fflate/blob/master/LICENSE))
* [cryptography](https://github.com/spalt08/cryptography) ([Apache License 2.0](https://github.com/spalt08/cryptography/blob/master/LICENSE))
* [emoji-data](https://github.com/iamcal/emoji-data) ([MIT License](https://github.com/iamcal/emoji-data/blob/master/LICENSE))
* [emoji-test-regex-pattern](https://github.com/mathiasbynens/emoji-test-regex-pattern) ([MIT License](https://github.com/mathiasbynens/emoji-test-regex-pattern/blob/main/LICENSE))
* [tlottie](https://github.com/dkaraush/tlottie) (MIT License)
* [fast-png](https://github.com/image-js/fast-png) ([MIT License](https://github.com/image-js/fast-png/blob/master/LICENSE))
* [opus-recorder](https://github.com/chris-rudmin/opus-recorder) ([BSD License](https://github.com/chris-rudmin/opus-recorder/blob/master/LICENSE.md))
* [Prism](https://github.com/PrismJS/prism) ([MIT License](https://github.com/PrismJS/prism/blob/master/LICENSE))
* [Solid](https://github.com/solidjs/solid) ([MIT License](https://github.com/solidjs/solid/blob/main/LICENSE))
* [TinyLD](https://github.com/komodojp/tinyld) ([MIT License](https://github.com/komodojp/tinyld/blob/develop/license))
* [libwebp.js](https://libwebpjs.appspot.com/)
* fastBlur
* [Mediabunny](https://github.com/Vanilagy/mediabunny) ([Mozilla Public License 2.0](https://github.com/Vanilagy/mediabunny/blob/main/LICENSE))
* [Temml](https://github.com/ronkok/Temml) ([MIT License](https://github.com/ronkok/Temml/blob/main/LICENSE))

### Debugging

Source maps are included in production builds. Use `debug=1` for additional logging or `noSharedWorker=1` to disable the Shared Worker while debugging locally.

#### Taking local storage snapshots
You can also take and load snapshots of the local storage and indexed DB using the `./snapshot-server` [mini-app](/snapshot-server/README.md). Check the `README.md` under this folder for more details.

#### Preview all icons
You can see all the available svg icons by calling the `showIconLibrary()` global function in the browser's console.

### Troubleshooting

Report bugs through the [Teagram Web issue tracker](https://github.com/teagramhq/teagram-web/issues).

### Licensing

The source code is licensed under GPL v3. License is available [here](/LICENSE).
