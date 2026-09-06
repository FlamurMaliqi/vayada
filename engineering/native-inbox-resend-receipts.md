# Resend receipt ownership — VAY-1381

The Vayada Resend account sends both Booking notifications and native PMS Inbox
email. The Booking worker accepts persisted `emailProduct: booking`; only those
jobs send the non-PII `vayada_product: booking` tag. Resend includes tags in
its signed webhook payload ([provider contract](https://resend.com/docs/webhooks/emails/delivered)).

After signature and envelope validation, only the explicit `booking` value is
acknowledged as outside the Inbox. Other values, including missing tags on older
mail, still require exactly one accepted Inbox attempt. Zero or ambiguous matches
return 503 for retry/reconciliation; a tag never supplies property ownership or
creates a message. Existing receipts and idempotency are unchanged.

## Two-stage deployment gate

1. Deploy this consumer/receiver slice first. It does **not** mark newly enqueued
   jobs. Verify every API/email worker process, including draining old tasks, has
   upgraded before the producer change is merged or deployed.
2. A separate producer PR will persist `emailProduct: booking` on new jobs.
   Enqueue replay must keep `ON CONFLICT DO NOTHING`, never rewrite an old job.
   Do not combine these phases: an old worker ignores the marker and would send
   a different body from a new worker retrying the same provider idempotency key.
3. Before enabling the account-wide subscription, verify older untagged Booking
   jobs have drained or been reconciled. Do not replay historical Booking events;
   they still require manual ownership reconciliation, not silent acknowledgement.

The Inbox adapter is unchanged. Old Booking jobs keep their untagged provider
body. After phase two, rollback may remove the producer but must retain this
consumer until all marked jobs, including pending/running/retryable work, have
finished or been reconciled. Disabling the webhook is the first receipt rollback;
it does not require downgrading the sender. No global send pause is authorized.

This slice does not enable a webhook, sender, callback secret or global flag.
It does not ingest guest replies or project bounces/complaints. Those events must
not be advertised as supported receipt tracking. The signed delivery receipt
means recipient-mail-server delivery, not human reading or inbox placement.
