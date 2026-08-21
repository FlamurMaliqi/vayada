# Finance folio recipient encryption contract

VAY-1132 defines `envelope_aead_v1` as the opaque `CiphertextBlob` returned by
AWS KMS for a dedicated customer-managed symmetric key. Application code must
not parse, construct, log, or otherwise depend on the blob's internal bytes.
The stored blob is at most 6,144 bytes, the AWS KMS `Decrypt` request limit;
the database and decoder enforce the same boundary.

## Plaintext and scope

Before encryption, the recipient is UTF-8 JSON in this exact canonical form:

```text
{"v":1,"name":"Ada Lovelace","email":"ada@example.com"}
```

The object has exactly `v`, `name`, and `email` in that order, with no extra
whitespace or fields. `v` is `1`; `name` is non-empty and trimmed; `email` is a
trimmed address containing `@` or `null`. The encoded plaintext is at most
4,096 bytes, matching the AWS KMS direct-encryption limit.

Encryption and decryption use this exact non-secret KMS encryption context:

- `purpose=finance-folio-recipient-v1`
- `propertyId=<canonical property UUID>`
- `folioId=<canonical folio UUID>`
- `revision=<positive decimal revision>`

This context is authenticated additional data. A ciphertext cannot be moved to
another property, folio, or revision and still decrypt.

`recipient_key_version` stores the immutable KMS key ARN used for the row, not
an alias. Runtime decryption accepts only configured key ARNs and verifies that
KMS returns the same ARN.

## Deployment prerequisite

This contract does not activate the live repository. Before `server.ts`
composition, the platform repository must provision the customer-managed key,
grant the next API **task role** narrowly scoped `kms:Decrypt` access, and pass
the allowed immutable ARN configuration. No plaintext key material belongs in
application configuration.

An operator must also inventory existing production folio recipient schemes
and key versions from an in-network database path. Unknown pre-existing rows
must be quarantined or migrated from proven provenance; the decoder must never
guess their format.

Encryption/writes, fingerprints/HMAC, key creation, IAM, and deployment are
successor work and are intentionally outside this slice.
