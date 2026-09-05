# PMS calendar setup recovery (VAY-1481)

PMS calendar auto-open can report incomplete canonical calendar setup while the
property already has product access. The general Marketplace setup wizard still
uses a rollout flag, so linking to its default entry alone cannot repair this state.

The PMS warning links through Marketplace reauthentication, preserving the complete
recovery return URL even when no Marketplace session exists. Its destination is
the canonical setup entry with the property ID from the
server read, `entryProduct=pms`, `returnProduct=pms`, `recovery=pms-calendar`, and
a rooms or calendar step. The return destination is `/settings#calendar`.
Only this explicit recovery entry selects the adaptive setup shell independently
of the general rollout; ordinary signup and add-property entries are unchanged.
The marker is navigation intent, never authorization. The existing setup route
read and every room/calendar command continue to enforce their property policy.
Users without setup authority are told to ask their property administrator.

Recovery reuses canonical physical-room labels, operating-calendar revisions,
room bindings, and inventory materialization. It does not synthesize inventory,
remove availability checks, or touch legacy APIs. Completing the wizard does not
implicitly change the stored auto-open configuration; users return to settings.

Architecture: [TypeScript backend structure](typescript-backend-structure.md).
Predecessor: VAY-1462. Live acceptance unblocks VAY-930.
