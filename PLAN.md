# HTTP — Plan

**Bundle ID:** `io.github.x-o-r-r-o.http` · **Keyword:** `http` (configurable; everything else is a word after it: `save`, `clear`, a status code, `=<id>` and `!<id>` for the response and confirmation views)

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-28):

| Raycast extension | Downloads |
|---|---|
| cURL (keyboard-first HTTP client) | ~28,000 |
| Postman (send GET requests from collections) | ~6,000 |
| **Total** | **~34,000** |

**Alfred today:** nothing comparable. There are URL openers and old single-purpose "HTTP status code" lookups, but no workflow that sends requests, shows timings and headers, or replays a browser's "Copy as cURL".

**What the Raycast extensions get wrong (from their READMEs, changelog and GitHub issues):**
- cURL: no import from the clipboard (#21778, closed as stalled), JSON bodies were confusing and broke (#10932, #24065), query parameters were added late (#20123), error response bodies weren't readable (#18923), X-API-Key headers failed (#14802), no way to save the same URL under different names (#15514).
- Postman: only GET requests, collections folders broken (#11728, #22910), needs an API key.

This workflow: pastes curl commands from the clipboard first thing, one-line HTTPie-style syntax with JSON bodies that just work, any method, the response body for every status, timings, named saved requests, converters, and it never needs an account.

## Features (v1.0)
- [x] Request line: `[METHOD] URL [items] [body]`. Method optional (GET, or POST with a body), custom uppercase methods (PURGE). URL without scheme: https, or http for localhost, private IPs, `*.local`/`*.test`; `:3000/x` = localhost.
- [x] Items: `Name:value` and `H:Name=value` headers (the value continues over following words: `H:Authorization=Bearer x`), `k==v` / `Q:k=v` query, `k=v` JSON string field, `k:=json` raw JSON field, `-f` form, `-u user:pass`, `-H 'Name: value'`, `-k`, `-j`, `-d <raw body>`, trailing `{…}`/`[…]` JSON body (runs to the end of the line).
- [x] Sending with `/usr/bin/curl`: config on stdin (`-q -K -`, never a shell string, never ~/.curlrc), body through a file (`data-binary @file`), `proto`/`proto-redir =http,https`, `globoff`, `compressed`, configurable timeout (`max-time`) and size limit (`max-filesize` plus a streaming cut-off for chunked responses), redirects configurable (max 10).
- [x] Response view: status, time, size; timing row (DNS · Connect · TLS · TTFB · Total, remote IP, HTTP version); redirect chain; headers (each copyable); body preview; ⌘Y Quick Look (pretty JSON, HTML, images, PDF), ⌘L Large Type; send again; save; converters.
- [x] Body handling: pretty-printed JSON that keeps number literals, charset decoding (ISO-8859-1, Shift_JIS…; Windows-1252 fallback when not UTF-8), sniffing of untyped JSON/HTML/images, binary detection (revealed in Finder, never opened).
- [x] Detached sender (setsid) with a live "Sending… ↩ Cancel" view that reruns every 0.3 s; cancel verifies the pid's command line before killing.
- [x] curl command parsing without a shell: bash/zsh quoting (`'…'`, `"…"`, `$'…'` with \x \u \U octal escapes), line continuations, Windows cmd format (`^"`), comments; stops at `|`, `;`, `&&`, `>`; `$VAR`, `$(…)` kept literal with a note. 150+ curl options known (value-taking ones from `curl --help all`). Refuses anything that reads local files (`-d @f`, `-F f=@x`, `-F f=<x`, `-T`, `-K`, `-H @f`, `--data-urlencode n@f`, `--variable`, `--expand-*`, unix sockets). Browser `Accept-Encoding: br, zstd` is replaced by curl's gzip (macOS curl has no brotli).
- [x] Clipboard: a curl command or URL in the clipboard is the first row of `http`; Universal Action "Send with HTTP" for selected text or URLs.
- [x] Converters: curl, JavaScript fetch, Python requests, HTTPie, wget (none for multipart). Exact bodies (string literals, not re-serialised JSON).
- [x] History (100, deduplicated, newest first, filterable by URL) and saved named requests (`http save <name>` then pick one, or `http save <name> <request>`); ⌥↩ last response, ⌃↩ remove; `http clear`.
- [x] Secrets: Authorization, Proxy-Authorization, Cookie, Set-Cookie, API key/token/secret/session headers, URL passwords, sensitive query parameters and JSON/form fields are masked in titles, subtitles and Large Type. Copies and reruns use real values. Option "Remember secrets" (on by default) drops them from the history. Cache and data folders are 0700.
- [x] Safety: POST/PUT/PATCH/DELETE (anything but GET/HEAD/OPTIONS) show a review step (`!<id>`: Send / Cancel / details) before anything is sent; can be turned off.
- [x] Status codes: `http 404`, `http 42` (prefix), `http 4xx`, or a name (`teapot`); 62 official codes plus nginx, Cloudflare, IIS and proxy codes; MDN link for official ones; offline.

## Tech
- **Stack:** one JXA script (`src/http.js`) with the ObjC bridge (NSTask, NSPipe, NSFileHandle, NSPasteboard, CFStringConvertIANACharSetNameToEncoding), `src/resolve.sh` for ⌘↩ paste of long texts.
- **Dependencies:** none. `/usr/bin/curl`, `/usr/bin/osascript`, `/bin/ps` ship with macOS.
- **Network:** only where the user sends a request; the Script Filter never touches the network while typing (queue mode 1). No rate limit to enforce: there is no API behind the workflow.
- **Files:** `$alfred_workflow_data/history.json`, `saved.json`; `$alfred_workflow_cache/resp/<id>/` (request, headers, body, preview, meta; newest 40 kept, 7 days max), `req/` (typed requests, 1 day), `out/` (long texts, 1 hour). All writes atomic; history/saved edits under an mkdir lock with dead-owner takeover.
- Target: macOS 13+ (curl 7.84+: `%{exitcode}`, `%{errormsg}`, `%{stderr}`), Apple Silicon and Intel, Alfred 5 + Powerpack.

## Known limitations
- File uploads (`-F f=@file`, `-d @file`, `-T`) are refused on purpose: a pasted command must never send a local file.
- Proxies, client certificates, `--resolve` and `--connect-to` from pasted commands are ignored (noted in the subtitle). System proxy environment variables are honoured by curl only if Alfred's environment has them.
- Brotli and zstd responses can't be decoded by macOS's curl, so browser commands ask for gzip instead.
- A typed request is stashed in the cache (to find it on ↩ and in the review step) even when "Remember secrets" is off; stashes are deleted after a day.
- Timing is cumulative across redirects (curl's own numbers).
- Custom methods sent with `-X` keep their case (curl semantics); known methods are upper-cased.
- `$'…'` bytes that aren't valid UTF-8 are kept as Latin-1 characters.

## Verify in real Alfred
- [ ] ↩ on a GET row: Alfred reopens on `http =<id>`, shows "Sending…" and then the response without losing the selection (rerun 0.3 s, uids).
- [ ] POST row: ↩ autocompletes to `!<id>` (review), ↩ sends, Cancel returns to the typed request.
- [ ] ⌘Y Quick Look of preview.json, HTML (no remote loads), PNG, PDF; ⌘L Large Type of the status row.
- [ ] ⌘↩ pastes the body / curl command, including a >50 KB one (resolve.sh).
- [ ] Universal Action "Send with HTTP" on a selected curl command and on a URL.
- [ ] Clipboard row with a real "Copy as cURL (bash)" from Chrome, Safari and Firefox, and Chrome's "(cmd)" variant.
- [ ] ↩ Cancel while a slow request runs; the request stops (no curl left in Activity Monitor).
- [ ] Notifications for save/delete/clear; no blank notification after copy.
- [ ] Workflow Configuration: keyword, timeout, size limit, follow redirects, ask before sending, remember secrets.
- [ ] Screenshots for every `images/*.png` referenced in the README.

## Release checklist (Alfred forum + Gallery)
- [x] README starts with `## Usage`; each paragraph ends "via the `http` keyword" / "via the Universal Action"
- [ ] Screenshots in `images/` (placeholders referenced)
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> …`, Quick Look as ⌘Y
- [x] No `## Setup` (nothing to set up)
- [x] Keyword ≥ 3 characters and configurable
- [x] Main icon ≥ 256 px
- [x] No self-updater; installs nothing; network only to the URLs the user sends

## Ideas for v1.1
- Environments and variables (`{{base}}`, `{{token}}` from the Keychain) for saved requests.
- Import Postman collections / HAR files (Raycast rhttp #30633 asks for it).
- JSONPath / jq-style extraction on the response (`http =<id> .data[0].id`).
- Opt-in file uploads from a file picked in Finder (File Action), never from pasted text.
- Response diff between two history entries (via DevToolbox's diff).
- Copy as Go, Swift URLSession, PHP, Node axios.
- Hotkey to send the selected text as a request.
