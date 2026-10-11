# L1 pre-key diagnostic contract

This harness is a test-tree-only diagnostic for the first Web MTProto exchange stages. It is not a product repair or a CI live probe. The separate DevOps work owns provenance checks and any approved live invocation. No real account or credential is used.

## Runtime boundary

The runner is `pnpm run test:l1-prekey`. It reads one UTF-8 JSON object from stdin and writes one sanitized JSON report to stdout. It does not read Vite env files or accept environment variables as target inputs. Supply values from the public served bundle only, without saving the object to a file:

| Input | Meaning |
| --- | --- |
| `endpoint` | Public shipped WSS endpoint |
| `origin` | Served web Origin |
| `subprotocol` | Must be `binary` |
| `dc_id` | Integer from 1 through 5 |
| `fingerprint` | Pinned lower-case 16 digit RSA fingerprint |
| `public_key` | Public RSA PEM, never a private key |
| `source_ref`, `deploy_ref`, `run_ref` | Safe bounded references; invalid or missing values become `unknown` |

Unknown input properties are discarded. The target is validated by the shipped `validateMtprotoTarget` code before a socket is opened. Endpoint, Origin and public-key values remain in process memory and never enter reports or the temporary rate-control state.

Each invocation makes at most one fresh WebSocket connection. The runner uses the shipped `TcpObfuscated`, obfuscation, abridged packet stream and codec, TL serialization, RSA-key selection and `Authorizer.sendReqPQ` path. It sends one `req_pq_multi`; after a valid `resPQ`, it sends one `req_DH_params` containing `p_q_inner_data_dc`. The authorizer validates the nonce, pinned fingerprint, PQ bounds, DH response, decrypted inner data, DH parameters and SHA1 before the harness stops at the `set_client_DH_params` boundary. The boundary throws before any `set_client_DH_params` request can be sent. No auth key is computed, saved or persisted.

The Node WebSocket client caps each reassembled message at the same 64 KiB pre-auth limit used by the abridged transport. An additional callback guard drops any oversized binary message before concatenation, copying or dispatch to the MTProto transport.

The harness temporarily registers the existing `server_DH_params_fail` constructor in the in-memory MTProto schema because the shipped authorizer has a refusal-validation branch but its generated schema omits that constructor. It removes this descriptor when the attempt ends. This does not change the app's schema or weaken any validation.

The runner enforces one active invocation per local user, at least five seconds between starts and at most three starts in any rolling ten-minute window. A `dh_inner_valid` result or an `unknown` result stops further attempts for the rest of that window. A new invocation is a new connection and there are no same-connection retries. The hard deadline is twenty seconds from supervision start; the child gets an earlier internal deadline so it can request cleanup before the supervisor terminates it. A local WebSocket 1000 close request is not proof of peer receipt.

The private OS temp directory stores attempt timestamps and a stop timestamp. `active.lock` contains a local owner socket and a zero-byte owner marker while the attempt is active; neither carries request data, process id, token or handshake material. The open marker handle pins the lock's filesystem identity. `maintenance.lock` is an empty directory held only while creating, releasing or reclaiming the active lock and updating rate state. A reachable owner socket proves that a lock is active. Reclamation runs under the maintenance lock, keeps the observed owner marker open, checks both the marker and directory identity again and probes the same owner socket before removal. Only `ECONNREFUSED` proves that the owner socket is stale; probe timeouts and all other errors fail closed as `concurrency_limited`. The runner never treats age alone as evidence that an owner is inactive. Locks with no verifiable owner socket fail closed as `concurrency_limited`; an abandoned maintenance lock also fails closed and needs operator verification before removal. No endpoint, Origin, reference, frame, nonce, DH value, error text or key is written to temporary state.

Child stdout and stderr are discarded, including Vite, WebSocket and crash diagnostics. The parent emits exactly one JSON object. If input parsing, a child process or the deadline fails, the report is `unknown` or `invalid_input` and contains only safe references. The source/deploy/run references are the only caller-provided strings that may appear in output.

## Output fields

Only these optional observation fields, `result`, and the three safe references are emitted. A field is omitted until the relevant stage is observed.

| Field | Values or meaning |
| --- | --- |
| `upgrade` | `101`, `403`, `other_4xx`, `5xx`, `network_error` |
| `respq` | `complete`, `proto_error`, `closed`, `timeout`, `malformed` |
| `respq_nonce_match` | Present only after a parsed `resPQ`; indicates whether its nonce matches the request |
| `fingerprint_in_pinned_set` | Present only after nonce and PQ checks reach pinned-key selection |
| `pq_valid` | Present only after the resPQ nonce check; true means the shipped PQ bounds checks passed |
| `dh_reply` | `ok`, `fail`, `proto_error`, `closed`, `timeout`, `malformed` |
| `proto_error_code` | `404`, `429`, `444`, `other`; raw messages are discarded |
| `dh_inner_valid` | Present only after a decrypted inner object is parsed. True means the shipped nonce, DH parameter and SHA1 checks passed. False means the client parsed the inner object and rejected its validation. |
| `close_1000_sent` | True only when the harness requested close code 1000 on an established open socket; false when it could not make that request |

`respq=complete` means a valid `resPQ` TL object was decoded. `dh_reply=ok` means `server_DH_params_ok` was decoded. `dh_reply=fail` means `server_DH_params_fail` was decoded and its nonce and `new_nonce_hash` checks passed, after which the server's refusal ended the exchange. An invalid refusal hash is reported as malformed. A stage that was never reached is omitted rather than reported as false or malformed.

## Closed `result` enum

| Result | Meaning |
| --- | --- |
| `invalid_input` | Runtime input did not meet the fixed target contract |
| `concurrency_limited` | Another invocation holds the local attempt lock |
| `interval_limited` | The last attempt started less than five seconds ago |
| `rate_limited` | Three attempts already started in the rolling ten-minute window |
| `already_stopped` | A prior attempt reached `dh_inner_valid` or stopped as `unknown` in the current window |
| `origin_rejected` | The WS upgrade returned 403 |
| `upgrade_refused` | The WS upgrade returned another 4xx |
| `server_error` | The WS upgrade returned a 5xx |
| `respq_protocol_error` | The first exchange stage returned a protocol error |
| `respq_closed` | The peer closed before a usable `resPQ` |
| `respq_malformed` | The first-stage frame or object could not be decoded |
| `respq_nonce_mismatch` | The decoded `resPQ` nonce did not match |
| `fingerprint_mismatch` | No pinned RSA key matched the server's fingerprints |
| `pq_invalid` | The shipped PQ bounds checks rejected `pq` |
| `dh_protocol_error` | The DH reply stage returned a protocol error |
| `dh_reply_closed` | The peer closed before a usable DH reply |
| `dh_reply_malformed` | The DH reply frame or object could not be decoded |
| `dh_reply_refused` | The server returned a DH refusal that passed the shipped nonce/hash checks |
| `dh_reply_nonce_mismatch` | The DH reply nonce did not match |
| `dh_inner_malformed` | The encrypted server DH inner object could not be decoded |
| `dh_inner_invalid` | The shipped DH inner validation rejected the response |
| `dh_inner_valid` | The shipped DH inner validation passed and the harness stopped before key creation |
| `unknown` | Network failure, timeout or child failure gave no discriminating signal; no further attempt is allowed in this window |

A 429 remains `proto_error` with `proto_error_code=429`, not malformed framing or a DH refusal. A network error or timeout without another signal yields `unknown`. No raw exception, host name, key, identifier, frame or handshake value is included in any result.

## Synthetic verification

The exact bounded synthetic command is:

```sh
pnpm exec vitest run src/tests/l1PrekeyAttempt.test.ts src/tests/l1PrekeyNodeWebSocket.test.ts src/tests/l1PrekeyContract.test.ts src/tests/l1PrekeyRunnerPolicy.test.ts src/tests/l1PrekeyRun.test.ts
```

The tests generate an ephemeral RSA pair and synthetic peer responses in memory. They exercise the shipped obfuscation, abridged framing, transport, TL parser, authorizer validation and stop-before-key boundary. They cover success, 429, nonce/fingerprint/PQ/DH failures, malformed framing, deadline cleanup, output allowlisting, rate spacing, live-owner retention, replacement-lock races, WebSocket payload dropping, and child crash/deadline privacy. They do not invoke the live runner.

The production artifact proof is `pnpm run check:private-artifact-output`. It builds the private production bundle in a temporary directory and fails if the test-only harness marker appears in any artifact. CI may run the ordinary synthetic test suite and that artifact audit; CI must not invoke `pnpm run test:l1-prekey`.
