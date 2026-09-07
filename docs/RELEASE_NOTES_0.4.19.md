# 0.4.19 - Discord original attachments

- Download Discord originals once and retain encrypted, ticket-scoped copies for seven days.
- Parse originals inside reusable offline Linux containers; failed previews no longer destroy the source.
- Read PDF page ranges and full-page Korean/English OCR. Restricted agents can reopen originals without reattachment or expanded PC permission.
- Retain original access across container expiry and desktop restarts, with integrity checks and bounded storage.
- Add an administrator-only existing WSL Docker engine selection, without changing Docker Desktop data.
- Preserve role/model/host-file boundaries and cancellation during download/analysis.
- Desktop/source version 0.4.19; existing mobile 0.4.18 remains compatible. No new APK is required for this host/Discord-side fix.

Validation: TypeScript typecheck; Discord policy/lifecycle tests; 65 Python tests;
real Linux-container original-PDF, scanned-PDF OCR, cross-ticket file, non-root,
no-network and no-daemon-socket checks. See the plugin README for bounds and
the distinction between OCR and visual interpretation. Discord transport is not E2EE.
