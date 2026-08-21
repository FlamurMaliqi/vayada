# Finance folio recipient encryption contract

VAY-1132 defines `envelope_aead_v1` as the opaque `CiphertextBlob` returned by
AWS KMS for a customer-managed symmetric key. Code must not parse, log, or
depend on its bytes. Decoder and database enforce KMS's 6,144-byte limit.

## Plaintext and scope

Before encryption, the recipient is UTF-8 JSON in this exact canonical form:

```text
{"v":1,"name":"Ada Lovelace","email":"ada@example.com"}
```

It has exactly those ordered fields and no extra whitespace. `v` is `1`; `name`
is trimmed and non-empty; `email` is trimmed with `@` or `null`. Plaintext is at
most 4,096 bytes, the KMS direct-encryption limit.

The exact non-secret KMS context is `purpose=finance-folio-recipient-v1`,
`propertyId=<canonical property UUID>`, `folioId=<canonical folio UUID>`, and
`revision=<positive decimal revision>`.

The context prevents moving ciphertext between records. `recipient_key_version`
stores an immutable key ARN, not an alias. Decryption accepts configured ARNs
only and verifies KMS returns the same ARN.

## Deployment prerequisite

This contract does not activate the live repository. Before `server.ts`
composition, platform must provision the key, grant the API **task role** narrow
`kms:Decrypt` access, and configure immutable ARNs without plaintext keys.

An operator must inventory production schemes and key versions in-network.
Unknown rows require quarantine or provenance-backed migration; never guessing.

Encryption/writes, fingerprints/HMAC, IAM, and deployment are successor work.
