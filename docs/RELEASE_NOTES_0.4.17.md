# 0.4.17 — Discord attachment intake

Removed the unconditional attachment rejection in personal tickets. A message
can carry multiple files; attachment-only messages request a summary. `/robot ask`
also accepts an optional file. All extensions can be received, while the UI/model
clearly distinguishes extracted text, partial/OCR results and unreadable formats.

Readers cover PDF, modern Office/ODF, HWP/HWPX, XLS, RTF, encoded text, ZIP members
and Windows image OCR. Proprietary binaries and audio/video currently expose only
metadata/readable byte previews; they are not semantically decoded or executed.
Bounds and original-file retention are documented in the Discord plugin README.

Incoming files remain separate from PC access authority. Download origins and
channel/file identities are checked, redirects denied, content sizes bounded,
and temporary originals removed after a credential-stripped resource-limited
parser subprocess. Cancellation and role changes prevent forwarding to the model.
The parser is not an OS sandbox and Discord attachments are not E2EE.

Verified with synthetic PDF download-to-parser tests, document/table/archive
fixtures, binary fallback, origin/size/cancellation checks, same-ticket excerpt
forwarding, unchanged privilege separation, Windows Korean screenshot OCR and a
real Codex subscription response using a synthetic PDF excerpt. No user's actual
document was posted to Discord by these tests.
