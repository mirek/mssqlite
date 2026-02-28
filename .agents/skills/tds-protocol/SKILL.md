---
name: tds-protocol
description: "Comprehensive TDS (Tabular Data Stream) protocol reference for implementing MSSQL clients and servers. Covers packet framing, message types, token streams, data types, login, prelogin, SQL batch, RPC, transactions, error handling, and wire format details. Use when implementing TDS protocol handling, debugging wire-level issues, or understanding MSSQL communication."
---

# TDS Protocol Reference

Complete reference for the Tabular Data Stream (TDS) protocol used by Microsoft SQL Server. Based on the MS-TDS open specification and SQL Server documentation.

Source: [MS-TDS Specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/b46a581a-39de-4745-b076-ec4dbb7d13ec)

## Reference Files

- [packet-framing.md](packet-framing.md) — Protocol overview, TDS versions, connection flow, packet header format
- [prelogin-login.md](prelogin-login.md) — PreLogin message, Login7 message, password scrambling, FeatureExt
- [tokens.md](tokens.md) — Token stream overview, COLMETADATA, ROW/NBCROW, DONE, ENVCHANGE, ERROR/INFO, LOGINACK, RETURNSTATUS, RETURNVALUE, FEATUREEXTACK, SESSIONSTATE, and other tokens
- [data-types.md](data-types.md) — TYPE_INFO, fixed/variable-length types, PLP, COLLATION, datetime encoding, decimal, money, GUID, sql_variant, vector, UDT, XML, TVP
- [messages.md](messages.md) — ALL_HEADERS, SQL Batch, RPC Request, Transaction Manager, Bulk Load, Federated Auth, SSPI, Attention
- [response-patterns.md](response-patterns.md) — Server response patterns (login, query, SP, error, transactions), variable-length data stream definitions
- [state-machines-and-notes.md](state-machines-and-notes.md) — Client/server state machines, TLS/SSL encryption, routing, MARS, implementation notes, common pitfalls
- [examples.md](examples.md) — Protocol examples with annotated hex dumps: PreLogin, Login7, SQL Batch, RPC, Attention, SSPI, Bulk Load, Transaction Manager, TVP, SparseColumn, FeatureExt, SESSIONRECOVERY, AZURESQLSUPPORT
