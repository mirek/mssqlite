---
name: authentication
description: Add optional SQL login password validation. Use when changing Login7 handling, credential storage, or server authentication configuration.
---

# Authentication

Optionally validate SQL logins such as `sa` and configured users instead of
accepting every credential, while retaining an explicit insecure development
mode.

## Implementation

- Define configuration and credential storage with modern password hashing,
  safe comparison, rotation, and no secret logging.
- Validate Login7 credentials and return protocol-correct login failures
  without revealing whether a user exists.
- Establish session identity for catalog visibility and future authorization.
- Keep SSPI, NTLM, and federated authentication explicitly outside this scope.

## Completion criteria

- Test successful, missing, malformed, and incorrect credentials at the wire
  boundary without exposing secrets in snapshots or logs.
- Verify configuration reload/startup behavior and insecure-mode opt-in.
- Exercise login success and failure with `tedious`.
- Update architecture, TDS, and tedious skills with the security model.
