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
- [x] Items: `Name:value` and `H:Name=value` headers (the value continues over following words: `H:Authorization=Bearer x`), `k==v` / `Q:k=v` query, `k=v` JSON string field, `k:=json` raw JSON field, HTTPie 3 nested fields (`a[b]=x`, `a[]=x`, `a[2]=x`, `[0][k]=x`, `\[` escapes), `Name;` empty header, `-f` form, `-u user:pass`, `-A bearer -a <token>`, `-H 'Name: value'`, `-k`, `-j`, `-d <raw body>`, trailing `{…}`/`[…]` JSON body (runs to the end of the line).
- [x] Sending with `/usr/bin/curl`: config on stdin (`-q -K -`, never a shell string, never ~/.curlrc), body through a file (`data-binary @file`), `proto`/`proto-redir =http,https`, `globoff`, `compressed`, configurable timeout (`max-time`) and size limit (`max-filesize` plus a streaming cut-off for chunked responses), redirects configurable (max 10).
- [x] Response view: status, time, size; timing row (DNS · Connect · TLS · TTFB · Total, remote IP, HTTP version); redirect chain; headers (each copyable); body preview; ⌘Y Quick Look (pretty JSON, HTML rebuilt without scripts/styles/remote content, SVG as an `<img>`, images, PDF), ⌘L Large Type; send again; save; converters.
- [x] Body handling: pretty-printed JSON that keeps number literals, charset decoding (ISO-8859-1, Shift_JIS…; Windows-1252 fallback when not UTF-8), sniffing of untyped JSON/HTML/images, binary detection (revealed in Finder, never opened).
- [x] Detached sender (setsid) with a live "Sending… ↩ Cancel" view that reruns every 0.3 s; cancel verifies the pid's command line before killing.
- [x] curl command parsing without a shell: bash/zsh quoting (`'…'`, `"…"`, `$'…'` with \x \u \U octal escapes), line continuations, Windows cmd format (`^"`), comments; stops at `|`, `;`, `&&`, `>`; `$VAR`, `$(…)` kept literal with a note. Every option of the curl 8.21 man page is known (value-taking ones, so a value is never taken for the URL; an unknown option right before the URL is refused). A pasted command is never run: only the parsed request becomes curl options, so `-o`, `-D`, `-c`, `--trace`, `--libcurl`, `--stderr`, `--etag-save`… can't write anything (a note says they were ignored), and `--digest`/`--ntlm`/`--netrc`/`--aws-sigv4` say they aren't supported. Refuses anything that reads local files (`-d @f`, `-F f=@x`, `-F f=<x`, `-T`, `-K`, `-H @f`, `--data-urlencode n@f`, `--variable`, `--expand-*`, unix sockets). Browser `Accept-Encoding: br, zstd` is replaced by curl's gzip (macOS curl has no brotli).
- [x] Clipboard: a curl command or URL in the clipboard is the first row of `http`; Universal Action "Send with HTTP" for selected text or URLs.
- [x] Converters: curl, JavaScript fetch, Python requests, HTTPie, wget (none for multipart). Exact bodies (string literals, not re-serialised JSON).
- [x] History (100, deduplicated, newest first, filterable by URL) and saved named requests (`http save <name>` then pick one, or `http save <name> <request>`); ⌥↩ last response, ⌃↩ remove; `http clear`.
- [x] Secrets: Authorization, Proxy-Authorization, Cookie, Set-Cookie, API key/token/secret/session headers, URL passwords, sensitive query parameters and JSON/form fields are masked in titles, subtitles and Large Type. Copies and reruns use real values. history.json, saved.json and response folders never hold secrets: they are split off (headers with their positions, password, URL, body) and kept in the macOS Keychain (Security framework, one item per request: `<bundleid>.history` / `<bundleid>.saved`), for saved requests always and for the history only with "Remember secrets" (**off by default**). The history deduplicates on a hash of the request without secrets. Texts that hold secrets reach the next object in the `http_text` variable (environment), never in `arg` (argv, visible in `ps`). umask 077: every file 0600, every folder 0700 (curl's own files too); curl's header dump and stderr are deleted after parsing.
- [x] Safety: POST/PUT/PATCH/DELETE (anything but GET/HEAD/OPTIONS) show a review step (`!<id>`: Send / Cancel / details) before anything is sent; can be turned off.
- [x] Status codes: `http 404`, `http 42` (prefix), `http 4xx`, or a name (`teapot`); 62 official codes plus nginx, Cloudflare, IIS and proxy codes; MDN link for official ones; offline.

## Tech
- **Stack:** one JXA script (`src/http.js`) with the ObjC bridge (NSTask, NSPipe, NSFileHandle, NSPasteboard, CFStringConvertIANACharSetNameToEncoding, SecItem*, CFNetworkCopySystemProxySettings, NSXMLDocument's HTML tidy), `src/resolve.sh` for ⌘↩ paste.
- **Proxy:** the HTTP/HTTPS/SOCKS proxy from System Settings › Network is passed to curl (`proxy`, `noproxy` with the exceptions list plus localhost). PAC files and proxies that need a password aren't supported.
- **Dependencies:** none. `/usr/bin/curl`, `/usr/bin/osascript`, `/bin/ps` ship with macOS.
- **Network:** only where the user sends a request; the Script Filter never touches the network while typing (queue mode 1). No rate limit to enforce: there is no API behind the workflow.
- **Files:** `$alfred_workflow_data/history.json`, `saved.json`; `$alfred_workflow_cache/resp/<id>/` (request without secrets, body, preview, quicklook.html, meta; `send.json` hands the full request to the sender and is deleted at once; newest 40 kept, 7 days max), `req/` (typed requests, 1 day), `out/` (long texts, 1 hour). All writes atomic; history/saved edits under an mkdir lock with dead-owner takeover.
- Target: macOS 13+ (curl 7.84+: `%{exitcode}`, `%{errormsg}`, `%{stderr}`), Apple Silicon and Intel, Alfred 5 + Powerpack.

## Known limitations
- File uploads (`-F f=@file`, `-d @file`, `-T`) are refused on purpose: a pasted command must never send a local file.
- Proxies, client certificates, `--resolve` and `--connect-to` from pasted commands are ignored (noted in the subtitle); the system proxy is used instead. PAC files and authenticated proxies aren't supported.
- Without “Remember secrets”, a history entry is sent again without its secret headers and password (the row says “secrets weren’t kept”), and secret JSON/form fields are sent as `•••`. Turning the option off keeps secrets already in the Keychain until the entry leaves the history or `http clear`.
- ⌘C on a stored request copies the command with its secrets masked; ⌘↩ reads the Keychain and pastes the real one.
- A typed request larger than 64 KB is stashed in the cache with its secrets (0600, deleted once sent or saved, or after a day).
- Response bodies and headers (Set-Cookie, tokens in a login response) stay in the cache (0600, newest 40, 7 days) until `http clear`.
- HTML previews are simplified (no styles, links or remote images); ↩ copies and Finder has the page as it came.
- Brotli and zstd responses can't be decoded by macOS's curl, so browser commands ask for gzip instead.
- Typed requests travel to the action in an Alfred variable, so nothing is written while typing; only a request larger than 64 KB is stashed in the cache (deleted after a day).
- A request body larger than 256 KB isn’t kept in the history (history.json is read on every keystroke); it can be sent again while its response folder is cached (the newest 40).
- ⌘C on a row whose text is over 50 KB (or a body over 4,000 characters) copies the start and says so; ↩ copies everything.
- Timing is cumulative across redirects (curl's own numbers).
- Custom methods sent with `-X` keep their case (curl semantics); known methods are upper-cased.
- `$'…'` bytes that aren't valid UTF-8 are kept as Latin-1 characters.

## Verify in real Alfred
- [ ] “Remember secrets” on: send a request with an Authorization header; Keychain Access shows an item “HTTP request secrets (Alfred HTTP, history)” and no prompt appears when sending it again from the history or pressing ⌘↩ on its row (item created and read by /usr/bin/osascript).
- [ ] `http save` a request with a token, then send it: no Keychain prompt; delete it (⌃↩): the Keychain item is gone.
- [ ] ⌘Y on an HTML response (e.g. `http example.com`) shows the simplified page with the grey “Preview without scripts…” note, and Little Snitch/`nettop` shows no request from Quick Look; ⌘Y on an SVG response shows the image.
- [ ] With an HTTP proxy set in System Settings › Network, a request goes through it (proxy log), and `localhost` doesn't.
- [ ] ↩ on a GET row: Alfred reopens on `http =<id>`, shows "Sending…" and then the response without losing the selection (rerun 0.3 s, uids).
- [ ] POST row: ↩ autocompletes to `!<id>` (review), ↩ sends, Cancel returns to the typed request.
- [ ] ⌘Y Quick Look of preview.json, HTML (no remote loads), PNG, PDF; ⌘L Large Type of the status row.
- [ ] ⌘↩ pastes the body / curl command, including a >50 KB one (resolve.sh).
- [ ] Universal Action "Send with HTTP" on a selected curl command and on a URL.
- [ ] Clipboard row with a real "Copy as cURL (bash)" from Chrome, Safari and Firefox, and Chrome's "(cmd)" variant.
- [ ] ↩ Cancel while a slow request runs; the request stops (no curl left in Activity Monitor).
- [ ] Notifications for save/delete/clear; no blank notification after copy.
- [ ] Workflow Configuration: keyword, timeout, size limit, follow redirects, ask before sending, remember secrets (off by default).
- [ ] Screenshots for every `images/*.png` referenced in the README.

## Release checklist (Alfred forum + Gallery)
- [x] README starts with `## Usage`; each paragraph ends "via the `http` keyword" / "via the Universal Action"
- [ ] Screenshots in `images/` (placeholders referenced)
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> …`, Quick Look as ⌘Y
- [x] No `## Setup` (nothing to set up)
- [x] Keyword ≥ 3 characters and configurable
- [x] Main icon ≥ 256 px
- [x] No self-updater; installs nothing; network only to the URLs the user sends

## Audits (3 full passes, 2026-09-28)
- **Pass 1:** `-u user` without a password made curl prompt on a terminal it doesn't have → sends an empty password with a note; converter quoting left `^`, and `=`/`~` at a word start, unquoted (special in zsh); several `--json` parts were joined with `&` (curl concatenates them); a server's `Content-Type: constructor` and a method named `constructor` hit `Object.prototype` (Maps now); directories were re-created on every row (memoised); old stashes were only pruned on send (the home view now prunes hourly). Regression tests: `Audit1RegressionTests`, `PrototypeTests`.
- **Pass 2:** every keystroke that parsed wrote the request (with its secrets) to the cache → typed requests now travel in an item variable and the review step is the query `!<request>` / `!hist:<id>` / `!clip`, re-parsed so what is shown is what is sent; cancel killed curl before the sender, which could then overwrite "Cancelled"; `autocomplete` lost tabs through the display sanitiser; the Script Filter's running subtitle said "Sending…" while typing; history rows didn't say when secrets weren't kept; IPv6 hosts covered. Regression tests: `Audit2RegressionTests`.
- **Pass 3:** ⌘C silently copied only the first 50 KB (or 4,000 characters of a body) → cut texts now say so; huge bodies made history.json (read per keystroke) grow without bound → bodies over 256 KB stay in the response folder only. Regression tests: `Audit3RegressionTests`, `HistorySizeTests`.
- Checked every pass: bare PATH (absolute /usr/bin/curl, /usr/bin/osascript, /bin/ps), no LANG (explicit UTF-8), cache/data paths with spaces, fresh install, damaged history/saved files, config values empty/padded/"0"/"false"/garbage, macOS 13 JavaScriptCore features (no replaceAll/at/hasOwn/lookbehind), curl ≥ 7.84 write-out variables, injection (argv only, curl config quoting, header names validated, no `@` file syntax reachable), keystroke time 70–110 ms including osascript start (100 history + 20 saved entries).

- **Pass 4 (independent audit, 2026-09-28):**
  - High: “Remember secrets” was on by default, so Authorization headers, cookies, passwords (and, even with it off, secret URL parameters and body fields) were written in plain text to history.json, saved.json and every response folder's request.json → split off into the Keychain; off by default; saved requests keep theirs in the Keychain.
  - High: Quick Look of an HTML or SVG response loaded its remote images, style sheets and iframes (verified with `qlmanage -p` against a local server; a CSP `<meta>` is ignored) → HTML is rebuilt from a whitelist via NSXMLDocument's tidy (external DTDs never loaded), SVG is wrapped in an `<img>`.
  - Medium: copy/paste/open rows put tokens and cookies in `arg`, i.e. in the argv of the next process (visible to every user via `ps`) → `http_text` variable; stored requests build their curl command only when ⌘↩ is pressed.
  - Medium: files were 0644 inside 0700 folders, and curl's header dump (Set-Cookie) and stderr (effective URL with its API key) stayed in the cache → umask 077, both deleted after parsing, URLs stored without secrets.
  - Medium: 7 value-taking options of the current curl man page (`--httpsig-*`, `--keepalive-cnt`, `--parallel-max-host`, `--ssl-sessions`) were unknown, so their value became the URL (`curl --ssl-sessions f.txt -H 'Authorization: …' https://api` would have sent the header to `http://f.txt`) → added, and any unknown option right before the URL is now refused.
  - Low: the history's dedupe fingerprint hashed the secrets (an offline oracle for guessing a password) → hashes the request without them; truncation could split an emoji into a lone surrogate (shown as �) → `cut()`; tests could fall back to the real clipboard/Keychain when an override was missing → hard test-mode guard.
  - Improvements: HTTPie nested JSON fields, `-A bearer -a <token>`, `Name;` empty headers, the system proxy, notes for ignored file/auth options. Regression tests: `Audit4RegressionTests`.

## Ideas for v1.1
Ranked by user demand (raycast/extensions issues, Alfred forum) and risk:
1. JSONPath / jq-style extraction on the response (`http =<id> .data[0].id`): Raycast cURL added JSONPath copy (2025-03), its most-used recent feature.
2. Run a saved request from a Hotkey or an External Trigger (`http saved:<name>`): Raycast cURL #15897, #16641.
3. Environments and variables (`{{base}}`, `{{token}}` from the Keychain) for saved requests; admin/user logins against the same URL (Raycast #15514, #16641; rhttp has them).
4. Import Postman collections / HAR files (Raycast rhttp #30633; Postman extension #11728, #22910).
5. Edit a stored request's headers and parameters before sending (remove/toggle one: Raycast #20123, rhttp #30634), e.g. by autocompleting it back into the query.
6. HTTPie `Name:` (empty value) to remove a default header such as `Accept` or `User-Agent`.
7. PAC files and authenticated proxies (Alfred forum "Workflows and HTTP proxies").
8. Opt-in file uploads from a file picked in Finder (File Action), never from pasted text (HTTPie `field@file`).
9. Response diff between two history entries (via DevToolbox's diff).
10. Copy as Go, Swift URLSession, PHP, Node axios.
