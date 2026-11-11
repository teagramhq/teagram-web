# Security Policy

## Server discovery and first trust

Teagram Web fetches a server's discovery document from
`https://<server>/.well-known/teagramd/client` over HTTPS, without credentials
and without following redirects. The document advertises the WSS endpoint and
the MTProto RSA public key. For `web.teagram.io`, the advertised WSS host may
differ from `web.teagram.io`; the first-use prompt shows the full advertised
endpoint and the SHA-256 fingerprint of that public key before connecting.

HTTPS authenticates the discovery origin according to the browser's certificate
store. It does not independently verify that the advertised WSS service is
controlled by the same operator. Whoever can control the discovery host's DNS,
hosting, TLS configuration, or response can advertise another permitted WSS
destination and key. On first use there is no stored identity to detect this,
so users should confirm the displayed endpoint and verify the displayed
fingerprint with the server administrator through a separate trusted channel.
The WSS URL is also shown on identity-change prompts so a destination change is
visible before the connection remains blocked.

After first-use confirmation, this browser stores a local pin for the selected
server host. The pin covers the advertised WSS endpoint, datacenter ID, and
MTProto RSA public-key SPKI SHA-256 fingerprint. A change to any pinned value
blocks the connection before sign-in traffic is sent. The identity-change flow
shows the pinned and current endpoints and fingerprints; continuing requires a
separate explicit confirmation to delete the old server data and pin, followed
by the first-use trust prompt for the new identity. A changed discovery
response alone never silently replaces a pin.

Pins are local to this browser profile. They do not protect first use, another
browser or device, a compromised browser, or data already exposed to a server
operator. Verify first-use identities and unexpected rotations out of band.

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Use this section to tell people how to report a vulnerability.

Tell them where to go, how often they can expect to get an update on a
reported vulnerability, what to expect if the vulnerability is accepted or
declined, etc.
