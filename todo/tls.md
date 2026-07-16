---
name: tls
description: Add TDS prelogin encryption negotiation and TLS transport. Use when implementing encrypted connections or enabling drivers that require encryption by default.
---

# TLS

Negotiate TDS encryption during prelogin and wrap the packet stream in TLS so
modern drivers can connect without `encrypt: false`.

## Implementation

- Implement server-side ENCRYPT negotiation for supported client modes and
  reject impossible combinations with protocol-correct failures.
- Upgrade the socket at the correct prelogin boundary without losing buffered
  TDS bytes or packet framing.
- Add certificate and key configuration, secure defaults, and explicit local
  development behavior.
- Preserve login, cancellation, disconnect, and error handling over TLS.

## Completion criteria

- Assert prelogin payloads and negotiation branches with annotated wire tests.
- Test trusted, self-signed, mismatched, and plaintext client configurations.
- Connect with current `tedious` defaults and at least one other mainstream
  SQL Server driver.
- Update architecture, TDS, server, and tedious skills with configuration.
