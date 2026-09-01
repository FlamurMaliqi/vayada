# Native Guest Inbox experience design

- Status: proposed implementation design for VAY-906
- Product decision: [VAY-905](https://linear.app/vayadacom/issue/VAY-905/define-native-guest-inbox-mvp-and-cutover-plan)
- Contract: [`native-guest-inbox.v2`](native-guest-inbox-contract.md)
- Implementation: [VAY-1376](https://linear.app/vayadacom/issue/VAY-1376/build-the-target-inbox-ui-and-composer)

## Experience goal

Help property staff clear the next guest conversation and reply safely without
losing the reservation, channel, ownership, or delivery context.

The Inbox is an operational workspace, not a dashboard. The conversation is
the visual focus. Queue state stays visible, booking context is quieter, and AI
only prepares editable content for a human to review and send.

Marketplace collaboration chat remains a separate product and data model.

## Proven patterns combined for Vayada

| Source pattern                                                                                | Vayada adaptation                                                                               |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bookboost reservation context, assignment, notes, attachments, quick replies, and translation | A quiet context pane and a reply/note composer that keeps staff coordination private            |
| Conduit attention, follow-up, done, and team ownership                                        | One persistent attention rail, explicit assignment, and reversible workflow state               |
| chatlyn multilingual continuity and handoff                                                   | Translation stays next to the message or draft; ownership and notes preserve shift context      |
| Hello Hotel shared history and mobile follow-up                                               | One chronological property history and a mobile queue-to-thread flow                            |
| HolidayHero three-pane Inbox and assisted drafting                                            | Queue, conversation, and stay context on wide screens; assistance is subordinate to manual send |

These are workflow and information-architecture references, not permission to
copy product text, visual trade dress, or source code.

## Visual direction

Reuse the existing PMS shell and its Inter typeface. Do not introduce a second
design system for the Inbox.

| Role        | Token     | Use                                         |
| ----------- | --------- | ------------------------------------------- |
| Ink         | `#111827` | Primary text and high-emphasis controls     |
| Canvas      | `#F9FAFB` | Timeline and app background                 |
| Surface     | `#FFFFFF` | Queue, composer, and context surfaces       |
| Border      | `#E5E7EB` | Pane boundaries and grouping                |
| Action      | `#2F52F5` | Selection, focus, links, and primary action |
| Operational | `#059669` | Connected and successfully sent states      |

Amber and rose remain semantic warning/error colors already used by PMS. Color
never carries meaning alone. Labels and icons accompany every status.

- Page title: Inter, 20 px, 700.
- Thread names and section labels: Inter, 13–14 px, 600.
- Message text: Inter, 14 px, 400, 1.5 line height.
- Metadata: Inter, 11–12 px, 400–600.
- Booking references may use the PMS monospace treatment.
- Corners stay within the PMS `rounded-md` to `rounded-xl` range. The Inbox is
  divided by borders, not nested inside a large floating card.

The signature interaction is the **attention rail**. It is vertical beside the
queue on desktop and horizontal above the queue on mobile. It always exposes
Needs attention, Follow up, and Done. This makes the team's work state visible
without dashboard metric cards or a hidden filter menu.

### Existing PMS patterns to reuse

- `apps/pms-web/app/(app)/layout.tsx`: the fixed `100dvh` shell, independent
  content overflow, mobile sidebar overlay, and existing Header/Sidebar.
- `apps/pms-web/components/layout/Sidebar.tsx`: compact navigation rows, active
  state, collapse behavior, and capped unread badge.
- `apps/pms-web/app/(app)/bookings/page.tsx`: search focus treatment, responsive
  filter toolbar, horizontal tabs, mobile list cards, and quiet desktop rows.
- `apps/pms-web/app/(app)/bookings/[id]/page.tsx`: booking labels, date/reference
  formatting, and guest/stay language.
- `apps/pms-web/components/Modal.tsx`: focus trapping, Escape behavior, focus
  restoration, `dvh`, and mobile full-screen treatment for drawers/dialogs.
- `apps/pms-web/app/globals.css` and `tailwind.config.js`: Inter, the mobile 16 px
  input floor, gray surfaces, and the existing primary palette.

Do not reuse the rolled-back VAY-657 interface, browser-native confirm dialogs,
or the unsupported methods in `apps/pms-web/services/messaging/index.ts`.

## Responsive information architecture

### Wide desktop: three panes at 1280 px and above

```text
+------------- existing PMS shell -----------------------------------------------------+
| Sidebar | Header: property / global search / profile                                  |
|         +----------+----------------+--------------------------+----------------------+
|         | attention| conversation   | selected conversation    | guest / stay context |
|         | rail     | queue          |                          |                      |
|         |          |                | guest + route + actions  | guest & source       |
|         | Needs    | Search         +--------------------------+ booking / inquiry    |
|         | Follow   | Filters        | chronological timeline   | stay / party         |
|         | Done     |                | messages + private notes | assignment           |
|         |          | thread rows    |                          | provider action      |
|         |          |                +--------------------------+                      |
|         |          |                | reply / note composer    |                      |
+---------+----------+----------------+--------------------------+----------------------+
           96 px       280 px           minmax(420 px, 1fr)        272 px
```

The Inbox fills the available height below the existing 48 px PMS header. The
page owns its internal scrolling: queue, timeline, and context scroll
independently; the composer and conversation header remain reachable.

### Compact desktop and tablet: two panes from 768–1279 px

```text
+----------+----------------+--------------------------------------+
| rail     | queue          | selected conversation                |
| 88 px    | 280 px         | header / timeline / composer         |
|          |                | context opens as a right-side drawer |
+----------+----------------+--------------------------------------+
```

The context pane becomes a drawer opened by **Guest & stay**. This preserves a
usable conversation width instead of squeezing three narrow columns.

### Mobile: queue to thread below 768 px

```text
QUEUE                                      THREAD
+----------------------------------+       +----------------------------------+
| Inbox                 filters    |       | < Inbox   Alex Lee       More   |
| Needs attention | Follow up | Done|       | Booking.com · Reply ready        |
| Search conversations            |       +----------------------------------+
| Alex Lee              12m       |       |                                  |
| Booking.com · unread             |  ->   | chronological timeline           |
| "Could we arrive early?"         |       |                                  |
|                                  |       +----------------------------------+
| Maria Gomez           1h         |       | Reply via Booking.com            |
| Airbnb · assigned to me         |       | draft / attachments       Send   |
+----------------------------------+       +----------------------------------+
```

Only one level is visible at a time. Back returns to the same queue, filters,
scroll position, and focused row. Guest context opens as a full-height sheet.
The composer uses `100dvh`, respects the safe area, and never sits behind mobile
browser chrome or the on-screen keyboard.

## Navigation and URL behavior

- Add Inbox between Reservations and Reviews in the existing PMS sidebar. Its
  badge uses the property unread-thread count; `99+` is the maximum label.
- Persist `attentionState`, unread, channel, and assignee filters in the URL so
  links and browser navigation restore the queue.
- Keep the search term in component state rather than browser history because
  it may contain guest PII. Debounce server search and never send it to client
  analytics.
- A selected thread may use `thread=<id>` in the URL. Changing property clears
  selection and every property-scoped cache entry.
- **New message** opens an eligible direct-booking chooser. Booking detail also
  exposes **Message guest**. Both start or reuse the deterministic direct-email
  thread, then navigate to it. OTA reservations are not converted to email.

### Permission behavior

- With `pms.inbox.read` only, staff can use the queue, detail, timeline, and
  view available private timeline attachments. Hide mutation entry points and
  explain that reply access is required; do not replace readable data with a
  denial screen.
- Reply, triage, assignment, notes, quick replies, assistance, provider actions,
  direct-thread start, and preparing draft attachments require reply access.
- Contact fields appear only when returned under `pms.guest_contact.read`.
- A mutation `403` rechecks read access. Preserve data only when read remains
  authorized and only reply permission was lost. Missing/inactive entitlement,
  property access, or Inbox read clears every property cache, selection, and
  draft before showing the full denial state.

## Attention rail and queue

The rail is navigation, not a status mutation. Each destination shows its label
and selected state. It does not invent per-state totals that are absent from the
v2 list contract. A due follow-up or new inbound message moves into Needs
attention when the server reports the contract transition.

The queue toolbar contains:

1. Search by guest name, retained message/note text, or booking/inquiry
   reference.
2. An unread toggle.
3. Channel filter: All, OTA, or Email. Provider badges still distinguish
   Booking.com, Airbnb, and future OTA providers.
4. Assignee filter: Anyone, Me, Unassigned, or an eligible property member.

Each row contains only the scan-critical hierarchy:

- guest display name, activity time, and unread count;
- provider/channel and linked booking, inquiry, or unlinked label;
- two-line last-message preview with an attachment indicator;
- assignee or follow-up metadata when present;
- a 3 px action-colored leading edge plus `aria-current` when selected.

Use **Unknown guest** when the display name is null. Show **No messages yet**
only when `lastMessage.at` is null; a null preview with activity becomes
**Attachment** when `hasAttachments`, otherwise **Message unavailable**.

Unread rows use stronger type and a labeled count, not background color alone.
The list loads recent-first with cursor pagination. Loading the next page keeps
existing rows and shows skeleton rows at the bottom.

## Conversation workspace

### Header and triage

The header shows guest name, provider source, context state, resolved reply
route, assignee, and the following actions:

- **Done** is one click with no browser-native confirmation. It moves the
  thread out of the active queue and shows a short **Undo** toast that calls
  reopen with the returned version.
- **Follow up** opens a keyboard-accessible popover with Today, Tomorrow, custom
  date/time, and property-timezone labeling.
- **Reopen** replaces Done in the Done queue.
- **Assign** supports Me, Unassigned, and eligible members.
- Overflow contains the provider-specific **No reply needed** action only when
  returned by thread detail. Its copy states that it updates Booking.com and is
  separate from Vayada's local Done state.

After the provider action returns `202`, replace it with disabled **Updating
Booking.com…** and refresh detail. The backend must suppress the available
capability while pending/completed and expose a held outcome for review. If it
cannot, VAY-1373 blocks this control: never re-enable it from a timer, generate
a second logical action, or offer blind retry after an ambiguous outcome.

Versioned mutations show a local pending state, then update the UI only after
the API accepts them. A new inbound message can restore Needs attention, even
while the thread is open.

### Timeline

- Messages and internal notes share one chronological timeline with date
  separators and an unread boundary.
- Guest messages are left-aligned white surfaces; property messages are
  right-aligned with a light Action tint. Message widths cap at 72% on desktop
  and 88% on mobile.
- Internal notes are full-width pale-amber strips with a lock icon, author, and
  **Visible to property staff only**. They never resemble a guest message.
- Attachments show file type, filename, size, and availability. Available files
  use the authenticated media path; migrated unavailable files are disabled and
  never reveal a legacy URL.
- Outbound messages always show Queued, Retrying, Sent, Held, or Failed in text.
  A trustworthy provider receipt may add Delivered or Read without replacing
  the send state.
- **Load earlier messages** prepends a page without moving the reader's current
  scroll anchor.
- After detail renders, mark read through the latest loaded inbound message ID.
  Do not locally zero a newer inbound message that arrives concurrently.
- A selected empty direct-email thread shows **No messages yet — start the
  conversation below**, plus its resolved route and active composer.

### Guest and stay context

The quiet right pane or drawer contains no aggregate cards:

- guest display name and contact fields only when the response includes them;
- source and provider reference;
- linked booking reference, dates, nights, party, room, and booking status,
  with **Open booking**;
- inquiry dates and party exactly as supplied, labeled **Inquiry — no booking
  yet**; or
- **Unlinked conversation** with retained source reference and no invented
  reservation match.

Assignment is repeated here for team handoff. The available provider action is
grouped under Source so it cannot be confused with local triage.

## Composer and assistance

Reply and Internal note are explicit modes in one anchored composer. Switching
to Internal note changes the surface to amber, replaces route text with
**Property staff only**, hides attachments and guest-facing assistance, and
changes the button to **Add note**.

Reply mode always shows the resolved route immediately above the draft:

```text
Replying through Booking.com               Connected
[ Quick replies ] [ Draft reply ] [ Translate draft ] [ Attach ]
[ Editable message -------------------------------------------------- ]
AI-assisted draft — review before sending                    [ Send ]
```

- The caller cannot choose or silently change the channel.
- A held route disables Send and explains the exact blocker. If the route turns
  held during submission, the accepted message appears as **Held — not
  delivered** and the draft text remains available to copy into a new reply
  after the blocker is resolved.
- Command/Ctrl+Enter sends only in Reply mode when the route is ready. Enter
  inserts a line break.
- Keep independent per-thread Reply and Internal note buffers. Never transfer
  text between modes; attachments and assisted output belong only to Reply.
  Clear Reply only when queued delivery is accepted; retain it for an accepted
  held message. Clear Internal note only after successful note creation.
- Both buffers, plus prepared Reply attachments, survive read refreshes, send
  errors, version conflicts, and assistance failures.
- Images and PDFs are prepared through private Platform Media. Each file shows
  preparation progress, validation, removal, and channel-specific rejection.
- Selecting a quick reply previews variables against this thread before
  replacing or inserting text. Unresolved required variables block insertion
  and leave the existing draft untouched.
- **Manage quick replies** opens a focused drawer with name, text, approved
  variables, preview, edit, and archive. There is no automation navigation.
- Translate message renders a labeled, dismissible translation below that
  message, defaulting to the staff UI language with an explicit language menu.
  Summarize opens a labeled summary above the timeline. Draft reply and
  Translate draft insert editable text with **AI-assisted — review before
  sending**.
- Summaries and drafted replies show the message boundary they covered. A new
  inbound message labels older assistance as **New messages arrived — refresh
  this draft/summary**; it never silently regenerates or sends.
- Assistance never changes thread state or sends. Its failure is local to the
  assist control; manual typing, attachments, notes, and Send remain usable.

## State behavior

| State                            | Presentation and recovery                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| First page loading               | Preserve shell; skeleton queue rows, conversation, and context                                                                          |
| Empty Needs attention            | “You're caught up” with links to Follow up and Done                                                                                     |
| Empty Follow up                  | “No conversations scheduled” and no fake call to action                                                                                 |
| Empty Done                       | “No completed conversations yet”                                                                                                        |
| No selection on desktop          | Quiet conversation placeholder; queue remains interactive                                                                               |
| Thread loading                   | Keep queue stable; skeleton only conversation and context                                                                               |
| Read model unavailable           | Inline pane error with request ID when supplied and Retry; do not show empty copy                                                       |
| Inbox read/entitlement denied    | Full Inbox access state with no thread metadata; link to property administrator/support                                                 |
| Reply permission missing         | Preserve readable queue/detail; hide mutation controls and explain the required access                                                  |
| Reply route held/disconnected    | Persistent amber route banner, exact reason, disabled Send, and connection/settings recovery link when authorized                       |
| Queued                           | Clock icon and “Queued” beside the outbound message                                                                                     |
| Retrying                         | Amber “Retrying automatically” with no manual duplicate-send action                                                                     |
| Sent                             | Green check and “Sent”; provider acknowledgement is separate                                                                            |
| Held after submit                | Red/amber “Not delivered — review required”; never show Retry for an ambiguous outcome                                                  |
| Failed                           | Red reason and “Copy to new reply”; original attempt stays immutable                                                                    |
| Stale thread version             | Refresh current state; preserve reply/note buffers and rejected intent; require explicit reapplication without automatic mutation retry |
| Assistance unavailable           | Error beside the requested assist action; composer remains enabled                                                                      |
| Quick-reply variables unresolved | List unresolved names, block insertion, preserve the current draft                                                                      |
| Attachment unavailable           | Disabled attachment row with “File unavailable”; no raw source link                                                                     |
| Thread deleted or inaccessible   | Return to queue with a non-revealing notice and restore queue focus                                                                     |

## Component and contract inventory

| Component                                | Primary contract use                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `InboxNavItem`                           | `GET /unread-count`                                              |
| `AttentionRail`                          | `attentionState` filter; no unsupported per-state totals         |
| `InboxQueueToolbar`                      | `unread`, `channel`, `assignee`, and redacted `search` query     |
| `ThreadQueue` / `ThreadRow`              | `GET /threads`, cursor, `ThreadSummary`                          |
| `ConversationHeader`                     | detail summary, route, assignment, provider actions              |
| `ConversationTimeline`                   | `GET /threads/:id`, mixed timeline, `previousCursor`             |
| `MessageItem` / `InternalNoteItem`       | `Message`, delivery/receipt, and `InternalNote`                  |
| `ConversationContext`                    | linked, inquiry, and unlinked context variants                   |
| `TriageActions`                          | done, follow-up, reopen, assignment commands with version        |
| `ProviderActionMenu`                     | capability-gated no-reply-needed command                         |
| `Composer`                               | manual reply, mark read boundary, current route, preserved draft |
| `AttachmentTray`                         | Platform Media prepare/finalize plus pre-send validation         |
| `QuickReplyPicker` / `QuickReplyManager` | list, preview, create, update, archive                           |
| `AssistControls`                         | translate message/draft, summarize, and draft reply              |
| `DirectThreadLauncher`                   | deterministic direct-email thread start by booking ID            |

Every logical command generates one opaque idempotency key and reuses that key
for transport retries until it receives a definitive response. A new user
action gets a new key. Commands submit the latest accepted thread or quick-reply
version. Client caches are keyed by property ID. No message, note, search, guest
contact, or filename is sent to analytics.

## Accessibility and interaction requirements

- Queue rows are native links or buttons with a visible focus ring, selected
  semantics, useful accessible names, and at least a 44 px mobile target.
- On mobile selection, focus moves to the conversation heading. Back restores
  focus to the originating row. Drawers/popovers trap focus and restore it on
  close; Escape closes the top layer.
- Route, unread, attention, delivery, and attachment states have text in
  addition to color and icon. Live delivery changes use a polite live region;
  send and permission failures use an assertive alert.
- Reply and Internal note expose tab semantics and explicit labels. The send
  shortcut is documented beside the action and is never the only send method.
- Timeline order remains logical in the DOM. Visual alignment does not reverse
  reading order.
- Inputs follow the existing mobile 16 px minimum and all sticky regions honor
  zoom, safe areas, reduced motion, and 320 px-wide screens.

## Implementation and validation notes for VAY-1376

Build one coherent workflow in reviewable slices:

1. Navigation, responsive shell, attention rail, filters, queue, detail,
   context, and all read states.
2. Versioned triage, assignment, notes, mark-read boundary, provider action,
   direct-email entry, and optimistic/undo behavior.
3. Manual reply, attachments, delivery states, quick replies, and
   human-reviewed assistance.
4. Focused component tests, keyboard tests, 320/768/1280 px browser smoke, PMS
   build/lint, and property-isolation/denial checks.

The implementation must use `native-guest-inbox.v2` routes rather than reviving
the rolled-back VAY-657 UI or unsupported messaging service methods. It must not
add Marketplace chat, WhatsApp, SMS, social, voice, automations, autonomous
sending, cross-property queues, SLA/analytics, or journeys.
