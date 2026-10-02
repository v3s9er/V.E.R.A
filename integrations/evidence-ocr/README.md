# Offline image observation

This fixed Node worker runs Tesseract.js 7 with the pinned English traineddata
package. It supplements original pixels; it does not certify a transcription,
execute image code, or grant file access. The host evidence tool authorizes and
decodes the image before sending PNG bytes. Models cannot choose engine paths,
languages, URLs, or commands. English/code OCR does not replace Korean vision.

Two engines at most, a 6-second observation deadline, a 30-second idle lifetime,
8 MB / 8 megapixel input bounds, and bounded text/line output limit resource use.
Cancellation retires the supervising worker and its nested OCR worker. Missing
assets or OCR failures leave the original image available, with an explicit
unavailable observation. No runtime downloads or persistent recognition cache.

The shipped `4.0.0/eng.traineddata.gz` SHA-256 is
`ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468`.
Upgrades require an explicit dependency, hash, license and regression review.
Identical observations are cached only within one evidence-tool lifecycle.

At most 12 low-confidence words are rescanned as enlarged single-line crops.
Differences are retained as competing hypotheses, never silently substituted.
The host attaches one bounded review sheet containing enlarged original pixels
for up to six disputed regions and their coordinate mappings. These rescans use
the same engine and are not independent votes or correctness guarantees.

Upstream: https://github.com/naptha/tesseract.js
and https://github.com/naptha/tessdata (language-data provenance).
See NOTICE.txt and the application's THIRD_PARTY_NOTICES.txt.
