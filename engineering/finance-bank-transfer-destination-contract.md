# Direct guest bank transfers

VAY-1041 / VAY-1465. Implements the Finance ownership boundary in
`typescript-backend-structure.md` and `backend-database-restructure.md`.

Provider onboarding remains hosted by Stripe/Xendit. Provider account references,
capabilities and readiness are independent of the direct-transfer destination.
Selecting bank transfer must never create or replace a provider account.

Finance owns immutable destination revisions, encrypted using AWS KMS with a
dedicated purpose and property/revision identity in its encryption context.
Only the account suffix is retained for masked settings reads. Account holder,
account number/IBAN, bank, SWIFT/BIC and optional instructions are ciphertext.
Encryption is not ownership verification. No legacy policy values are imported.

Authorized finance settings operations create/replace a destination, disable it
for new bookings, or delete its encrypted revisions. Each operation records only
actor, property, destination ID and action. Optimistic revision checks prevent
lost updates; command IDs make retries safe. Settings APIs never decrypt.

Submission binds a bank-transfer booking to the currently enabled destination
in the booking transaction. Replacement cannot redirect an existing booking.
Disabling stops new bookings; deletion makes old instructions unavailable.
An internal Finance operation verifies this binding and booking payment method
before decryption. Its only consumers are an authorized guest confirmation read
and delivery of a guest transactional email. Reveal audits contain IDs only.

Full instructions exist transiently at delivery. Booking metadata, quote data,
events, queued jobs, email persistence, logs and errors contain no raw values.
Email jobs carry booking/property IDs and resolve instructions at delivery.
Guest responses use no-store and the existing confirmation-token authorization.
Policy bank fields are removed and rejected; affected hotels must re-enter them.

Implementation stack: VAY-1465 storage/codec; VAY-1466 management and readiness;
VAY-1467 booking binding and delivery; VAY-1468 onboarding/settings and browser QA.
The additive storage slice alone does not enable the feature or fix existing
policy storage. Release requires all dependent slices and their validation.
