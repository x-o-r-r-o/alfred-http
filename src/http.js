#!/usr/bin/osascript -l JavaScript
// HTTP for Alfred — send requests with the curl that ships with macOS, replay curl commands,
// convert requests to code, keep a history and explain status codes. No dependencies.
// Usage: osascript -l JavaScript http.js <filter|act|send|tokenize|parse> [args…]
//   filter            Script Filter JSON for $http_query
//   act <arg>         run the action chosen in Alfred ($http_action)
//   send <id>         send a stored request (spawned detached by act)
//   tokenize / parse  test suite only: JSON array of commands on stdin → JSON on stdout
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.bindFunction("setsid", ["int", []]);
ObjC.bindFunction("kill", ["int", ["int", "int"]]);
ObjC.bindFunction("CFStringConvertIANACharSetNameToEncoding", ["unsigned int", ["id"]]);
ObjC.bindFunction("CFStringConvertEncodingToNSStringEncoding", ["unsigned long", ["unsigned int"]]);

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
// Alfred checkboxes arrive as "1"/"0" (older versions: "true"/"false"); padded or empty values happen
function enabled(name, fallback) {
  const v = env(name, null);
  if (v === null || v.trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(v.trim());
}
function numberSetting(name, fallback, min, max) {
  const n = Number(String(env(name, "")).trim().replace(",", "."));
  if (!String(env(name, "")).trim() || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const BUNDLE = env("alfred_workflow_bundleid", "io.github.x-o-r-r-o.http");
const VERSION = env("alfred_workflow_version", "1.0.0");
const TIMEOUT = numberSetting("timeout", 30, 1, 600); // seconds for the whole request
const MAX_MB = numberSetting("max_size", 10, 0.001, 1024); // response body limit
const MAX_BYTES = Math.round(MAX_MB * 1024 * 1024);
const FOLLOW = enabled("follow_redirects", true);
const CONFIRM = enabled("confirm_writes", true);
const KEEP_SECRETS = enabled("keep_secrets", true);
const HISTORY_MAX = 100;
const SAVED_MAX = 200;
const RESPONSES_MAX = 40; // cached response folders
const PRETTY_MAX = 5 * 1024 * 1024; // JSON larger than this is previewed as is
const INLINE_MAX = 50 * 1024; // larger texts go through a cache file and resolve.sh
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const UA = `alfred-http/${VERSION}`;

function now() {
  const t = env("HTTP_TEST_NOW", null); // test suite only: fixed clock (epoch seconds)
  return t !== null ? Number(t) : Date.now() / 1000;
}

function keyword() {
  const k = env("keyword_http", "http").trim();
  return /^[^\s"'\\]{1,32}$/.test(k) ? k : "http";
}

// ---------- files ----------

const FM = $.NSFileManager.defaultManager;

const MADE = new Set(); // folders this process has already created (one syscall each, not one per row)
function mkdirs(dir, priv) {
  if (MADE.has(dir)) return dir;
  MADE.add(dir);
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  // requests hold Authorization headers and cookies: only this user may read them
  if (priv) FM.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: 0o700 }), dir, $());
  return dir;
}
function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}alfred-http`), true);
}
function dataDir() {
  return mkdirs(env("alfred_workflow_data", `${$.NSTemporaryDirectory().js}alfred-http-data`), true);
}
function exists(path) {
  return FM.fileExistsAtPath(path);
}
function readFile(path) {
  if (!exists(path)) return null;
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}
function writeFile(path, text) {
  // atomic: readers (and a Script Filter run that Alfred kills) never see a half-written file
  return $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}
// UTF-8, or Latin-1 when the bytes aren't UTF-8 (HTTP headers may be either); "" when missing
function readText(path) {
  const t = readFile(path);
  if (t !== null || !exists(path)) return t || "";
  const d = $.NSData.dataWithContentsOfFile(path);
  if (d.isNil()) return "";
  const s = $.NSString.alloc.initWithDataEncoding(d, $.NSISOLatin1StringEncoding);
  return s.isNil() ? "" : s.js;
}
function removeFile(path) {
  FM.removeItemAtPathError(path, $());
  MADE.delete(path);
}
function readJSON(path, fallback) {
  const t = readFile(path);
  if (t === null) return fallback;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch (e) {
    return fallback;
  }
}
function mtime(path) {
  const a = FM.attributesOfItemAtPathError(path, $());
  return a.isNil() ? 0 : a.fileModificationDate.timeIntervalSince1970;
}
function fileSize(path) {
  const a = FM.attributesOfItemAtPathError(path, $());
  return a.isNil() ? 0 : Number(a.fileSize);
}
function listDir(dir) {
  const a = FM.contentsOfDirectoryAtPathError(dir, $());
  return a.isNil() ? [] : a.js.map((s) => s.js);
}

// ---------- processes ----------

const PID = $.NSProcessInfo.processInfo.processIdentifier;

// Run a program with argv (never a shell) and optional stdin; returns {status, stdout, stderr}.
function exec(path, args, input) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const inP = $.NSPipe.pipe, outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardInput = inP;
  task.standardOutput = outP;
  task.standardError = errP;
  if (!task.launchAndReturnError($())) return { status: -1, stdout: "", stderr: `cannot run ${path}` };
  if (input) inP.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
  inP.fileHandleForWriting.closeFile;
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const str = (d) => $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js || "";
  return { status: task.terminationStatus, stdout: str(out), stderr: str(err) };
}

function alive(pid) {
  return Number.isInteger(pid) && pid > 1 && $.kill(pid, 0) === 0;
}

// Start a detached process (stdio to /dev/null so Alfred doesn't wait for it); returns its pid or 0.
function spawn(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const nul = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = nul;
  task.standardOutput = nul;
  task.standardError = nul;
  return task.launchAndReturnError($()) ? task.processIdentifier : 0;
}

// Serialise a read-modify-write across processes: mkdir is atomic. The owner's pid goes inside, so
// a lock left by a killed process is taken over at once; one without a pid after a few seconds.
function withLock(dir, fn) {
  const until = Date.now() + 3000;
  let got = false;
  while (!(got = FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $(), $()))) {
    const age = Date.now() / 1000 - mtime(dir);
    const owner = Number(readFile(`${dir}/pid`));
    if (exists(dir) && (age > 10 || age < -60 || (owner > 1 && !alive(owner)))) removeFile(dir);
    else if (Date.now() > until) break;
    else $.NSThread.sleepForTimeInterval(0.03);
  }
  if (got) writeFile(`${dir}/pid`, String(PID));
  try {
    return fn();
  } finally {
    if (got) removeFile(dir);
  }
}

// ---------- text ----------

function oneLine(s, max = 100) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function fmtBytes(n) {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
function fmtMs(sec) {
  const ms = sec * 1000;
  if (!(ms >= 0)) return "–";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}
function fmtAgo(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function plural(n, one, many) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many || one + "s"}`;
}

// cyrb53: a fast 53-bit string hash for ids and file names (not for security)
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function base64(s) {
  return $(s).dataUsingEncoding($.NSUTF8StringEncoding).base64EncodedStringWithOptions(0).js;
}

// ---------- secrets ----------
// Authorization, cookies, API keys and tokens are masked wherever they are shown (titles, subtitles,
// Large Type). Copied commands and reruns keep the real values.

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-amz-security-token|x-goog-api-key|private-token)$|token|secret|passw|api[-_]?key|session|signature|credential/i;
const SECRET_PARAM = /^(access_token|id_token|refresh_token|token|api_key|apikey|api-key|key|secret|client_secret|password|passwd|pass|pwd|sig|signature|auth|session|sessionid|sid|code|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;
const SECRET_FIELD = /^(password|passwd|pass|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api_key|apikey|private_key|otp|pin|cvv|cvc|card_number)$/i;
const DOTS = "•••";

function isSecretHeader(name) {
  return SECRET_HEADER.test(String(name).trim());
}
function maskHeader(name, value) {
  value = String(value);
  if (!isSecretHeader(name) || value === "") return value;
  const n = String(name).trim().toLowerCase();
  if (n === "authorization" || n === "proxy-authorization") {
    const m = /^([A-Za-z][\w-]*)\s+\S/.exec(value);
    return m ? `${m[1]} ${DOTS}` : DOTS;
  }
  if (n === "cookie") return value.split(/;\s*/).filter((p) => p !== "").map((p) => (p.includes("=") ? `${p.slice(0, p.indexOf("="))}=${DOTS}` : DOTS)).join("; ");
  if (n === "set-cookie") {
    const [first, ...attrs] = value.split(/;\s*/);
    return [first.includes("=") ? `${first.slice(0, first.indexOf("="))}=${DOTS}` : DOTS, ...attrs].join("; ");
  }
  return DOTS;
}
function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch (e) {
    return s;
  }
}
function maskQuery(q) {
  return q.split("&").map((p) => {
    const i = p.indexOf("=");
    return i > 0 && SECRET_PARAM.test(safeDecode(p.slice(0, i))) && i < p.length - 1 ? `${p.slice(0, i)}=${DOTS}` : p;
  }).join("&");
}
function maskURL(url) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!m) return url;
  let [, scheme, authority, path, query, frag] = m;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = authority.slice(0, at), c = userinfo.indexOf(":");
    authority = (c >= 0 ? `${userinfo.slice(0, c)}:${DOTS}` : userinfo) + authority.slice(at);
  }
  return scheme + authority + path + (query ? "?" + maskQuery(query.slice(1)) : "") + (frag || "");
}
// The URL as shown: https:// is implied (http:// stays visible), secrets masked
function displayURL(url) {
  return maskURL(url).replace(/^https:\/\//i, "");
}
function maskBody(text) {
  return String(text)
    .replace(/("([^"\\]{1,40})"\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (m, pre, k, v) => (SECRET_FIELD.test(k) && v ? `${pre}"${DOTS}"` : m))
    .replace(/(^|&)([^=&\s]{1,40})=([^&]+)/g, (m, pre, k, v) => (SECRET_FIELD.test(safeDecode(k)) ? `${pre}${k}=${DOTS}` : m));
}
function maskAuth(auth) {
  const i = auth.indexOf(":");
  return i >= 0 ? `${auth.slice(0, i)}:${DOTS}` : auth;
}

// ---------- URLs ----------

class ParseError extends Error {}

const PRIVATE_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|[\w-]+\.(localhost|local|test|internal|lan|home\.arpa))$/i;

// Percent-encode what may not appear in a URL (spaces, non-ASCII, quotes…), leaving valid escapes alone
function encodeLoose(s) {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=]/.test(ch)) out += ch;
    else if (ch === "%") out += "%";
    else out += encodeURIComponent(ch);
  }
  return out.replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
}

// "api.github.com/users" → https://…, "localhost:3000/x" and ":3000/x" → http://…
// Throws ParseError for anything that isn't an http(s) URL.
function normalizeURL(input, defaultScheme) {
  let s = String(input).trim();
  if (!s) throw new ParseError("Type a URL");
  if (/[\x00-\x20\x7f]/.test(s.replace(/ /g, ""))) throw new ParseError("The URL contains control characters");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1])) throw new ParseError(`Only http:// and https:// URLs can be sent, not ${scheme[1].toLowerCase()}://`);
    s = scheme[1].toLowerCase() + s.slice(scheme[1].length);
  } else {
    if (/^(file|javascript|data|mailto|ftp):/i.test(s)) throw new ParseError("Only http:// and https:// URLs can be sent");
    if (s.startsWith("//")) s = s.slice(2);
    else if (/^:\d*(\/|$)/.test(s)) s = "localhost" + s; // HTTPie shorthand for localhost
    const host = s.split(/[/?#]/)[0];
    const hostOnly = host.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    const looksLikeHost = /\./.test(hostOnly) || /^localhost$/i.test(hostOnly) || /^\[[0-9a-f:.]+\]$/i.test(hostOnly) || /:\d+$/.test(host);
    if (!looksLikeHost || !/^[^\s"'<>\\^`{|}]+$/.test(hostOnly)) throw new ParseError(`“${oneLine(s, 40)}” doesn’t look like a URL`);
    s = `${defaultScheme || (PRIVATE_HOST.test(hostOnly) ? "http" : "https")}://${s}`;
  }
  const m = /^https?:\/\/([^/?#]*)/i.exec(s);
  const authority = m ? m[1] : "";
  const host = authority.replace(/^[^@]*@/, "").replace(/:\d*$/, "");
  if (!host) throw new ParseError("The URL has no host");
  if (/:(\d*)$/.test(authority.replace(/^[^@]*@/, "")) && !/^\[.*\]$/.test(authority.replace(/^[^@]*@/, ""))) {
    const port = authority.replace(/^[^@]*@/, "").match(/:(\d*)$/)[1];
    if (port !== "" && !(Number(port) >= 1 && Number(port) <= 65535)) throw new ParseError(`Port ${port} is out of range`);
  }
  return encodeLoose(s);
}
function hostOf(url) {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
  return m ? m[1] : url;
}
function addQuery(url, pairs) {
  if (!pairs.length) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url, frag = hashAt >= 0 ? url.slice(hashAt) : "";
  const q = pairs.map(([k, v]) => (v === null ? k : `${k}=${v}`)).join("&");
  return base + (base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?") + q + frag;
}
const enc = (s) => encodeURIComponent(s);

// curl asks for the password on the terminal when -u has none; here it's sent empty instead
function withPassword(auth, notes) {
  if (auth.includes(":")) return auth;
  notes.push("No password after the user name: sending an empty one");
  return `${auth}:`;
}

// ---------- request model ----------
// { method, url, headers: [[name, value]…], body: null | {kind: json|form|text|multipart, text, fields},
//   auth: "user:pass" | null, insecure, notes: [warnings shown in the subtitle] }

function header(req, name) {
  const n = name.toLowerCase();
  const h = req.headers.find(([k]) => k.toLowerCase() === n);
  return h ? h[1] : null;
}
function setDefaultHeader(req, name, value) {
  if (header(req, name) === null) req.headers.push([name, value]);
}
function bodyKind(text, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (/json/.test(ct)) return "json";
  if (/x-www-form-urlencoded/.test(ct)) return "form";
  if (ct) return "text";
  const t = text.trim();
  if (/^[{\[]/.test(t)) return "json";
  if (/^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(t)) return "form";
  return "text";
}
function jsonError(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return String(e.message || e).replace(/^JSON Parse error: /, "");
  }
}
function fingerprint(req) {
  return hash(JSON.stringify([req.method, req.url, req.headers, req.body, req.auth || null, !!req.insecure]));
}
function cleanRequest(r) {
  // requests come from our own files, but files can be damaged: never trust their shape
  if (!r || typeof r !== "object" || typeof r.method !== "string" || typeof r.url !== "string") return null;
  if (!/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(r.method) || !/^https?:\/\//i.test(r.url) || /[\x00-\x20\x7f]/.test(r.url)) return null;
  const headers = Array.isArray(r.headers) ? r.headers.filter((h) => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string" && validHeader(h[0], h[1])) : [];
  let body = null;
  if (r.body && typeof r.body === "object" && r.body.kind === "multipart" && Array.isArray(r.body.fields)) {
    body = { kind: "multipart", text: "", fields: r.body.fields.filter((f) => Array.isArray(f) && typeof f[0] === "string" && typeof f[1] === "string") };
  } else if (r.body && typeof r.body === "object" && typeof r.body.text === "string") {
    body = { kind: ["json", "form", "text"].includes(r.body.kind) ? r.body.kind : "text", text: r.body.text };
  }
  return {
    method: r.method, url: r.url, headers, body,
    auth: typeof r.auth === "string" && !/[\x00-\x1f\x7f]/.test(r.auth) ? r.auth : null,
    insecure: r.insecure === true,
    notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === "string").slice(0, 5) : [],
    redacted: r.redacted === true,
  };
}
function validHeader(name, value) {
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) && !/[\x00-\x08\x0a-\x1f\x7f]/.test(value);
}
function finishRequest(req) {
  for (const [k, v] of req.headers) {
    if (!validHeader(k, v)) throw new ParseError(/[\r\n]/.test(v) ? `The ${k} header contains a line break` : `“${oneLine(k, 30)}” isn’t a valid header name`);
  }
  if (req.auth !== null && /[\x00-\x1f\x7f]/.test(req.auth)) throw new ParseError("The user name or password contains control characters");
  if (req.body && req.body.kind === "multipart") {
    for (const [k] of req.body.fields) if (/[\x00-\x1f\x7f"]/.test(k)) throw new ParseError("A form field name contains quotes or control characters");
  }
  return req;
}

// ---------- request line ----------
// get api.github.com/users/octocat   ·   post httpbin.org/post {"a":1}   ·   https://…  H:Authorization=Bearer x
// Items after the URL (HTTPie style): Name:value header, H:Name=value header, k==v or Q:k=v query,
// k=v field, k:=json raw JSON field, -f form, -u user:pass, -k, -d <raw body>, or a trailing JSON body.

function lineTokens(q) {
  const toks = [];
  let i = 0;
  const n = q.length;
  while (i < n) {
    while (i < n && /\s/.test(q[i])) i++;
    if (i >= n) break;
    const start = i;
    let text = "", quoted = false;
    while (i < n && !/\s/.test(q[i])) {
      const c = q[i];
      if (c === "'" || c === '"') {
        const j = c === "'" ? q.indexOf("'", i + 1) : closingDouble(q, i + 1);
        if (j < 0) {
          text += c; // an unclosed quote is an apostrophe: name=O'Brien
          i++;
          continue;
        }
        const inner = q.slice(i + 1, j);
        text += c === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner;
        quoted = true;
        i = j + 1;
      } else {
        text += c;
        i++;
      }
    }
    toks.push({ text, start, end: i, quoted });
  }
  return toks;
}
function closingDouble(s, from) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

function parseLine(q) {
  q = q.trim();
  if (/^curl(\.exe)?(\s|$)/i.test(q)) return parseCurl(q);
  const toks = lineTokens(q);
  if (!toks.length) throw new ParseError("Type a request");
  let i = 0, method = null;
  const t0 = toks[0].text;
  if (!toks[0].quoted && (METHODS.includes(t0.toUpperCase()) || (/^[A-Z]{3,12}$/.test(t0) && toks.length > 1))) {
    method = t0.toUpperCase();
    i = 1;
  }
  if (i >= toks.length) throw new ParseError(`Type a URL after ${method}`);
  const req = { method: null, url: normalizeURL(toks[i].text), headers: [], body: null, auth: null, insecure: false, notes: [] };
  const query = [], fields = [];
  let raw = null, form = false, forceJSON = false, last = null;
  for (let j = i + 1; j < toks.length; j++) {
    const t = toks[j], s = t.text;
    if (/^[{\[]/.test(q[t.start])) {
      if (fields.length) throw new ParseError("Use either fields (k=v) or a body, not both");
      raw = q.slice(t.start).trim(); // a JSON body runs to the end, spaces and quotes included
      break;
    }
    if (t.quoted && /^\s*[{\[]/.test(s) && j === toks.length - 1 && !fields.length) {
      raw = s.trim(); // '{"a": 1}'
      break;
    }
    if (!t.quoted && /^(-d|--data|--raw)$/.test(s)) {
      if (j + 1 >= toks.length) throw new ParseError(`Type the body after ${s}`);
      raw = q.slice(toks[j + 1].start).trim();
      if (toks[j + 1].quoted && j + 2 === toks.length) raw = toks[j + 1].text;
      break;
    }
    if (!t.quoted && /^(-f|--form)$/.test(s)) {
      form = true;
      last = null;
      continue;
    }
    if (!t.quoted && /^(-j|--json)$/.test(s)) {
      forceJSON = true;
      last = null;
      continue;
    }
    if (!t.quoted && /^(-k|--insecure)$/.test(s)) {
      req.insecure = true;
      last = null;
      continue;
    }
    if (!t.quoted && /^(-u|-a|--auth|--user)$/.test(s)) {
      if (j + 1 >= toks.length) throw new ParseError(`Type user:password after ${s}`);
      req.auth = withPassword(toks[++j].text, req.notes);
      last = null;
      continue;
    }
    if (!t.quoted && /^(-H|--header)$/.test(s)) {
      if (j + 1 >= toks.length) throw new ParseError(`Type Name: value after ${s}`);
      const h = toks[++j].text, c = h.indexOf(":");
      if (c <= 0) throw new ParseError(`Write the header as “Name: value”`);
      last = [h.slice(0, c).trim(), h.slice(c + 1).trim()];
      req.headers.push(last);
      continue;
    }
    let m;
    if ((m = /^([HhQq]):([^=:\s]+)[=:]([\s\S]*)$/.exec(s))) {
      last = [m[2], m[3].trim()];
      (m[1].toUpperCase() === "H" ? req.headers : query).push(last);
      continue;
    }
    const endsEmpty = (v) => v === "" && !t.quoted && last; // base64 padding ("abc==") after a header value
    if ((m = /^([^\s=:]+)==([\s\S]*)$/.exec(s)) && !endsEmpty(m[2])) {
      last = [m[1], m[2]];
      query.push(last);
      continue;
    }
    if ((m = /^([^\s=:]+):=([\s\S]*)$/.exec(s))) {
      last = [m[1], m[2], "raw"];
      fields.push(last);
      continue;
    }
    if ((m = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):([\s\S]*)$/.exec(s)) && !m[2].startsWith("//")) {
      last = [m[1], m[2].trim()];
      req.headers.push(last);
      continue;
    }
    if ((m = /^([^\s=:]+)=([\s\S]*)$/.exec(s)) && !endsEmpty(m[2])) {
      last = [m[1], m[2]];
      fields.push(last);
      continue;
    }
    if (last) {
      last[1] = last[1] === "" ? s : `${last[1]} ${s}`;
      continue;
    }
    throw new ParseError(`Didn’t understand “${oneLine(s, 30)}”: quote values that contain spaces`);
  }
  req.url = addQuery(req.url, query.map(([k, v]) => [enc(k), enc(v)]));
  if (raw !== null && fields.length) throw new ParseError("Use either fields (k=v) or a body, not both");
  if (fields.length) {
    if (form) {
      if (fields.some((f) => f[2] === "raw")) throw new ParseError("Raw JSON fields (k:=…) can’t be sent as a form");
      req.body = { kind: "form", text: fields.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&") };
    } else {
      for (const f of fields) {
        if (f[2] === "raw") {
          const err = jsonError(f[1]);
          if (err) throw new ParseError(`${f[0]}:= needs valid JSON (${err})`);
        }
      }
      req.body = { kind: "json", text: "{" + fields.map(([k, v, r]) => `${JSON.stringify(k)}: ${r ? v.trim() : JSON.stringify(v)}`).join(", ") + "}" };
    }
  } else if (raw !== null) {
    const kind = forceJSON ? "json" : form ? "form" : bodyKind(raw, header(req, "Content-Type"));
    req.body = { kind, text: raw };
    if (kind === "json") {
      const err = jsonError(raw);
      if (err) req.notes.push(`The body isn’t valid JSON (${oneLine(err, 60)})`);
    }
  }
  if (req.body) {
    if (req.body.kind === "json") {
      setDefaultHeader(req, "Content-Type", "application/json");
      setDefaultHeader(req, "Accept", "application/json, */*;q=0.5");
    } else if (req.body.kind === "form") setDefaultHeader(req, "Content-Type", "application/x-www-form-urlencoded");
    else setDefaultHeader(req, "Content-Type", "text/plain; charset=utf-8");
  } else if (forceJSON) setDefaultHeader(req, "Accept", "application/json, */*;q=0.5");
  req.method = method || (req.body ? "POST" : "GET");
  if (req.body && (req.method === "GET" || req.method === "HEAD")) req.notes.push(`${req.method} with a body: many servers ignore it`);
  return finishRequest(req);
}

// ---------- curl commands ----------
// A pasted command is split into words the way a shell would (bash, zsh, or Windows cmd as copied from
// Chrome), but nothing is ever evaluated: $VAR, $(…) and `…` stay as written, and anything after
// |, ;, && or > is ignored. Options that would read or write local files are refused.

// bash $'…' (ANSI-C quoting, used by Chrome's "Copy as cURL" for bodies with special characters)
function ansiC(s, i) {
  // s[i] is the first character after $' ; returns [text, index after the closing quote]
  let out = "", bytes = [];
  const flush = () => {
    if (!bytes.length) return;
    const pct = bytes.map((b) => "%" + b.toString(16).padStart(2, "0")).join("");
    try {
      out += decodeURIComponent(pct);
    } catch (e) {
      out += String.fromCharCode(...bytes); // not UTF-8: keep the bytes as Latin-1
    }
    bytes = [];
  };
  const simple = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      flush();
      return [out, i + 1];
    }
    if (c !== "\\") {
      flush();
      out += c;
      i++;
      continue;
    }
    const d = s[i + 1];
    let m;
    if (d === undefined) break;
    if (Object.prototype.hasOwnProperty.call(simple, d)) {
      flush();
      out += simple[d];
      i += 2;
    } else if (d === "x" && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2)))) {
      bytes.push(parseInt(m[0], 16));
      i += 2 + m[0].length;
    } else if ((d === "u" || d === "U") && (m = (d === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i + 2)))) {
      flush();
      const cp = parseInt(m[0], 16);
      out += cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "\ufffd";
      i += 2 + m[0].length;
    } else if ((m = /^[0-7]{1,3}/.exec(s.slice(i + 1)))) {
      bytes.push(parseInt(m[0], 8) & 0xff);
      i += 1 + m[0].length;
    } else if (d === "c" && s[i + 2] !== undefined) {
      flush();
      out += String.fromCharCode(s.charCodeAt(i + 2) & 0x1f);
      i += 3;
    } else {
      flush();
      out += "\\" + d;
      i += 2;
    }
  }
  throw new ParseError("A $'…' quote isn’t closed");
}

// POSIX shell words. Returns {words, notes}.
function bashWords(s) {
  const words = [], notes = new Set();
  let cur = null, i = 0;
  const n = s.length;
  const push = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  while (i < n) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] === "\n") i += 2;
      else if (s[i + 1] === "\r" && s[i + 2] === "\n") i += 3;
      else if (i + 1 >= n) i++;
      else {
        cur = (cur || "") + s[i + 1];
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new ParseError("A single quote isn’t closed");
      cur = (cur || "") + s.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === "$" && s[i + 1] === "'") {
      const [text, next] = ansiC(s, i + 2);
      cur = (cur || "") + text;
      i = next;
      continue;
    }
    if (c === "$" && s[i + 1] === '"') {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1, text = "";
      for (; j < n && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < n && '$`"\\\n'.includes(s[j + 1])) {
          if (s[j + 1] !== "\n") text += s[j + 1];
          j++;
        } else {
          if ((s[j] === "$" && /[A-Za-z_{(]/.test(s[j + 1] || "")) || s[j] === "`") notes.add("Shell variables and commands were kept as written, not expanded");
          text += s[j];
        }
      }
      if (j >= n) throw new ParseError("A double quote isn’t closed");
      cur = (cur || "") + text;
      i = j + 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      push();
      i++;
      continue;
    }
    if (c === "#" && cur === null) {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "|" || c === ";" || c === ">" || c === "<" || (c === "&" && (s[i + 1] === "&" || i + 1 >= n || /\s/.test(s[i + 1])))) {
      if (c === ">" && cur !== null && /^\d$/.test(cur)) cur = null; // 2>&1
      push();
      const rest = s.slice(i).trim();
      if (rest) notes.add(`Ignored everything from “${oneLine(rest, 20)}”`);
      break;
    }
    if ((c === "$" && /[A-Za-z_{(]/.test(s[i + 1] || "")) || c === "`") notes.add("Shell variables and commands were kept as written, not expanded");
    cur = (cur || "") + c;
    i++;
  }
  push();
  return { words, notes: [...notes] };
}

// Windows cmd as copied from Chrome ("Copy as cURL (cmd)"): ^ escapes, then the C runtime's argv rules
function cmdWords(s) {
  s = s.replace(/\^\r?\n/g, "").replace(/\^([\s\S])/g, "$1");
  const words = [];
  let cur = null, inQ = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      let k = 0;
      while (s[i + k] === "\\") k++;
      if (s[i + k] === '"') {
        cur = (cur || "") + "\\".repeat(Math.floor(k / 2));
        if (k % 2) {
          cur += '"';
          i += k + 1;
        } else i += k;
      } else {
        cur = (cur || "") + "\\".repeat(k);
        i += k;
      }
      continue;
    }
    if (c === '"') {
      if (inQ && s[i + 1] === '"') {
        cur = (cur || "") + '"';
        i += 2;
        continue;
      }
      inQ = !inQ;
      cur = cur || "";
      i++;
      continue;
    }
    if (!inQ && /\s/.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
      i++;
      continue;
    }
    cur = (cur || "") + c;
    i++;
  }
  if (inQ) throw new ParseError("A double quote isn’t closed");
  if (cur !== null) words.push(cur);
  return { words, notes: [] };
}

function curlWords(text) {
  const t = String(text).trim();
  if (/^curl(\.exe)?\s+\^"/i.test(t) || /\s\^\r?\n/.test(t)) return cmdWords(t);
  return bashWords(t);
}

// Options that take a value (from `curl --help all`, curl 8.7, plus newer ones)
const CURL_ARG = new Set(("abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers config connect-timeout connect-to " +
  "continue-at cookie cookie-jar create-file-mode crlfile curves data data-ascii data-binary data-raw data-urlencode delegation " +
  "dns-interface dns-ipv4-addr dns-ipv6-addr dns-servers doh-url dump-header egd-file engine etag-compare etag-save expect100-timeout " +
  "form form-string ftp-account ftp-alternative-to-user ftp-method ftp-port ftp-ssl-ccc-mode happy-eyeballs-timeout-ms haproxy-clientip " +
  "header help hostpubmd5 hostpubsha256 hsts interface ipfs-gateway json keepalive-time key key-type krb libcurl limit-rate local-port " +
  "login-options mail-auth mail-from mail-rcpt max-filesize max-redirs max-time netrc-file noproxy oauth2-bearer output output-dir " +
  "parallel-max pass pinnedpubkey proto proto-default proto-redir proxy-cacert proxy-capath proxy-cert proxy-cert-type proxy-ciphers " +
  "proxy-crlfile proxy-header proxy-key proxy-key-type proxy-pass proxy-pinnedpubkey proxy-service-name proxy-tls13-ciphers " +
  "proxy-tlsauthtype proxy-tlspassword proxy-tlsuser proxy-user proxy1.0 pubkey quote random-file range rate referer request " +
  "request-target resolve retry retry-delay retry-max-time sasl-authzid service-name socks4 socks4a socks5 socks5-gssapi-service " +
  "socks5-hostname speed-limit speed-time stderr telnet-option tftp-blksize time-cond tls-max tls13-ciphers tlsauthtype tlspassword " +
  "tlsuser trace trace-ascii trace-config unix-socket upload-file url url-query user user-agent variable write-out proxy preproxy " +
  "ech ip-tos vlan-priority sigalgs upload-flags knownhosts").split(" "));
const CURL_SHORT_ARG = { E: "cert", K: "config", C: "continue-at", b: "cookie", c: "cookie-jar", d: "data", D: "dump-header", F: "form", P: "ftp-port", H: "header", h: "help", m: "max-time", o: "output", U: "proxy-user", Q: "quote", r: "range", e: "referer", X: "request", Y: "speed-limit", y: "speed-time", t: "telnet-option", z: "time-cond", T: "upload-file", u: "user", A: "user-agent", w: "write-out", x: "proxy" };
const CURL_SHORT_FLAG = { a: "append", q: "disable", f: "fail", G: "get", g: "globoff", I: "head", 0: "http1.0", i: "include", k: "insecure", 4: "ipv4", 6: "ipv6", j: "junk-session-cookies", l: "list-only", L: "location", M: "manual", n: "netrc", N: "no-buffer", Z: "parallel", p: "proxytunnel", J: "remote-header-name", O: "remote-name", R: "remote-time", S: "show-error", s: "silent", 2: "sslv2", 3: "sslv3", 1: "tlsv1", B: "use-ascii", v: "verbose", V: "version", "#": "progress-bar", ":": "next" };
const CURL_KNOWN_FLAGS = new Set(("anyauth append basic ca-native compressed compressed-ssh create-dirs crlf digest disable disable-eprt disable-epsv " +
  "disallow-username-in-url doh-cert-status doh-insecure fail fail-early fail-with-body false-start follow form-escape ftp-create-dirs ftp-pasv ftp-pret " +
  "ftp-skip-pasv-ip ftp-ssl-control get globoff haproxy-protocol head http0.9 http1.0 http1.1 http2 http2-prior-knowledge http3 http3-only " +
  "ignore-content-length include insecure ipv4 ipv6 junk-session-cookies list-only location location-trusted mail-rcpt-allowfails manual mptcp " +
  "negotiate netrc netrc-optional next no-alpn no-buffer no-clobber no-keepalive no-npn no-progress-meter no-sessionid ntlm ntlm-wb out-null " +
  "parallel parallel-immediate path-as-is post301 post302 post303 progress-bar proxy-anyauth proxy-basic proxy-ca-native proxy-digest " +
  "proxy-http2 proxy-insecure proxy-negotiate proxy-ntlm proxy-ssl-allow-beast proxy-ssl-auto-client-cert proxy-tlsv1 proxytunnel raw " +
  "remote-header-name remote-name remote-name-all remote-time remove-on-error retry-all-errors retry-connrefused sasl-ir show-error " +
  "show-headers silent skip-existing socks5-basic socks5-gssapi socks5-gssapi-nec ssl ssl-allow-beast ssl-auto-client-cert ssl-no-revoke " +
  "ssl-reqd ssl-revoke-best-effort sslv2 sslv3 styled-output suppress-connect-headers tcp-fastopen tcp-nodelay tftp-no-options " +
  "tlsv1 tlsv1.0 tlsv1.1 tlsv1.2 tlsv1.3 tr-encoding trace-ids trace-time use-ascii verbose version xattr").split(" "));

const LOCAL_FILE = "reads a local file, which isn’t supported";

function parseCurl(text) {
  const { words, notes: wordNotes } = curlWords(text);
  if (!words.length || !/(^|[\\/])curl(\.exe)?$/i.test(words[0])) throw new ParseError("Not a curl command");
  const notes = new Set(wordNotes);
  const urls = [], data = [], form = [], headers = [], urlQuery = [];
  let method = null, head = false, get = false, json = false, auth = null, insecure = false, onlyJSON = true;
  const fail = (msg) => {
    throw new ParseError(msg);
  };
  const handle = (name, val) => {
    switch (name) {
      case "request":
        method = val;
        return;
      case "header": {
        if (val.startsWith("@")) fail(`-H ${val.slice(0, 20)} ${LOCAL_FILE}`);
        const semi = /^([^:;\s]+);$/.exec(val.trim());
        if (semi) return headers.push([semi[1], ""]); // "Name;" sends an empty header
        const c = val.indexOf(":");
        if (c <= 0) return notes.add(`Ignored the header “${oneLine(val, 30)}”`);
        const k = val.slice(0, c).trim(), v = val.slice(c + 1).trim();
        if (v === "") return; // "Name:" removes a header in curl
        headers.push([k, v]);
        return;
      }
      case "data":
      case "data-ascii":
      case "data-binary":
      case "json":
        if (val.startsWith("@")) fail(`--${name} @… ${LOCAL_FILE}`);
        data.push(val);
        if (name === "json") json = true;
        else onlyJSON = false;
        return;
      case "data-raw":
        data.push(val);
        onlyJSON = false;
        return;
      case "data-urlencode":
      case "url-query": {
        const eq = val.indexOf("="), at = val.indexOf("@");
        if (at >= 0 && (eq < 0 || at < eq)) fail(`--${name} name@file ${LOCAL_FILE}`);
        let part;
        if (name === "url-query" && val.startsWith("+")) part = val.slice(1);
        else if (eq < 0) part = enc(val);
        else if (eq === 0) part = enc(val.slice(1));
        else part = `${val.slice(0, eq)}=${enc(val.slice(eq + 1))}`;
        if (name === "url-query") urlQuery.push([part, null]);
        else {
          data.push(part);
          onlyJSON = false;
        }
        return;
      }
      case "form":
      case "form-string": {
        const eq = val.indexOf("=");
        if (eq <= 0) fail(`-F needs name=value, not “${oneLine(val, 20)}”`);
        const k = val.slice(0, eq), v = val.slice(eq + 1);
        if (name === "form" && /^[@<]/.test(v)) fail(`-F ${k}=${v.slice(0, 20)} ${LOCAL_FILE}`);
        form.push([k, name === "form" ? v.replace(/;type=[^;]*$/, "") : v]);
        return;
      }
      case "user":
        auth = val;
        return;
      case "cookie":
        if (!val.includes("=")) return notes.add("Ignored the cookie file");
        headers.push(["Cookie", val]);
        return;
      case "user-agent":
        headers.push(["User-Agent", val]);
        return;
      case "referer":
        headers.push(["Referer", val.replace(/;auto$/, "")]);
        return;
      case "oauth2-bearer":
        headers.push(["Authorization", `Bearer ${val}`]);
        return;
      case "range":
        headers.push(["Range", `bytes=${val}`]);
        return;
      case "url":
        urls.push(val);
        return;
      case "config":
      case "upload-file":
      case "netrc-file":
        fail(`--${name} ${LOCAL_FILE}`);
      case "variable":
        fail("--variable isn’t supported");
      case "unix-socket":
      case "abstract-unix-socket":
        fail("Unix sockets aren’t supported");
      case "proxy":
      case "preproxy":
      case "socks4":
      case "socks4a":
      case "socks5":
      case "socks5-hostname":
        notes.add("Ignored the proxy");
        return;
      case "resolve":
      case "connect-to":
        notes.add(`Ignored --${name}`);
        return;
      case "cert":
      case "key":
        notes.add("Ignored the client certificate");
        return;
      default:
        return; // output, write-out, max-time… don't change what is sent
    }
  };
  const flag = (name) => {
    if (name === "get") get = true;
    else if (name === "head") head = true;
    else if (name === "insecure") insecure = true;
    else if (name === "next") notes.add("Only the first request is used");
    else if (!CURL_KNOWN_FLAGS.has(name.replace(/^no-/, "")) && !CURL_KNOWN_FLAGS.has(name)) notes.add(`Ignored --${oneLine(name, 20)}`);
  };
  let endOpts = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (endOpts || !w.startsWith("-") || w === "-") {
      urls.push(w);
      continue;
    }
    if (w === "--") {
      endOpts = true;
      continue;
    }
    if (w.startsWith("--")) {
      const name = w.slice(2);
      if (CURL_ARG.has(name) || name.startsWith("expand-")) {
        if (i + 1 >= words.length) fail(`${w} needs a value`);
        const val = words[++i];
        if (name.startsWith("expand-")) fail(`${w} expands variables, which isn’t supported`);
        handle(name, val);
      } else flag(name);
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      const ch = w[k];
      if (Object.prototype.hasOwnProperty.call(CURL_SHORT_ARG, ch)) {
        let val = w.slice(k + 1);
        if (val === "") {
          if (i + 1 >= words.length) fail(`-${ch} needs a value`);
          val = words[++i];
        }
        handle(CURL_SHORT_ARG[ch], val);
        break;
      }
      if (Object.prototype.hasOwnProperty.call(CURL_SHORT_FLAG, ch)) flag(CURL_SHORT_FLAG[ch]);
      else notes.add(`Ignored -${ch}`);
    }
  }
  if (!urls.length) fail("The curl command has no URL");
  if (urls.length > 1) notes.add("Only the first URL is used");
  // curl adds http:// to a URL without a scheme
  let url = normalizeURL(urls[0], /^[a-z][a-z0-9+.-]*:\/\//i.test(urls[0]) ? null : "http");
  url = addQuery(url, urlQuery);
  if (data.length && form.length) fail("-d and -F can’t be used together");
  const noteList = [];
  const req = { method: null, url, headers: [], body: null, auth: auth === null ? null : withPassword(auth, noteList), insecure, notes: [] };
  for (const n of noteList) notes.add(n);
  for (const [k, v] of headers) {
    if (k.startsWith(":")) continue; // HTTP/2 pseudo-headers from Safari
    if (/^accept-encoding$/i.test(k)) {
      notes.add("Asks for gzip instead of the browser’s Accept-Encoding");
      continue;
    }
    if (/^content-length$/i.test(k)) continue; // curl computes it
    req.headers.push([k, v]);
  }
  if (data.length && get) {
    req.url = addQuery(req.url, data.map((d) => [d, null]));
  } else if (data.length) {
    const text = data.join(json && onlyJSON ? "" : "&"); // curl joins --json parts as they are, -d parts with &
    if (json) {
      setDefaultHeader(req, "Content-Type", "application/json");
      setDefaultHeader(req, "Accept", "application/json");
    } else setDefaultHeader(req, "Content-Type", "application/x-www-form-urlencoded"); // what curl sends
    req.body = { kind: bodyKind(text, header(req, "Content-Type")), text };
  } else if (form.length) {
    req.body = { kind: "multipart", text: "", fields: form };
    req.headers = req.headers.filter(([k]) => !/^content-type$/i.test(k) || !/multipart/i.test(header(req, "Content-Type"))); // curl adds the boundary
  }
  const m = method ? (METHODS.includes(method.toUpperCase()) ? method.toUpperCase() : method) : null;
  req.method = m || (head ? "HEAD" : req.body ? "POST" : "GET");
  if (!/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(req.method)) fail(`“${oneLine(req.method, 20)}” isn’t a valid method`);
  if (insecure) notes.add("Certificate checks are off (-k)");
  req.notes = [...notes];
  return finishRequest(req);
}

// ---------- converters ----------

function shq(s) {
  s = String(s);
  // zsh treats ^ (extended glob), and = or ~ at the start of a word, specially: quote them
  return /^[A-Za-z0-9_\-.,:\/@%+][A-Za-z0-9_\-.,:\/@%+=]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
function lines(first, rest) {
  return rest.length ? [first, ...rest].join(" \\\n  ") : first;
}
const jsStr = (s) => JSON.stringify(String(s)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function toCurl(req) {
  const rest = [];
  if (req.method === "HEAD") rest.push("-I");
  else if (!(req.method === "GET" && !req.body) && !(req.method === "POST" && req.body)) rest.push(`-X ${shq(req.method)}`);
  for (const [k, v] of req.headers) rest.push(`-H ${shq(v === "" ? `${k};` : `${k}: ${v}`)}`);
  if (req.auth) rest.push(`-u ${shq(req.auth)}`);
  if (req.body && req.body.kind === "multipart") for (const [k, v] of req.body.fields) rest.push(`--form-string ${shq(`${k}=${v}`)}`);
  else if (req.body) rest.push(`--data-raw ${shq(req.body.text)}`);
  if (req.insecure) rest.push("-k");
  return lines(`curl ${shq(req.url)}`, rest);
}

function toFetch(req) {
  const opts = [];
  if (req.method !== "GET") opts.push(`  method: ${jsStr(req.method)},`);
  const hs = req.headers.map(([k, v]) => `    ${jsStr(k)}: ${jsStr(v)},`);
  if (req.auth) hs.push(`    "Authorization": ${jsStr("Basic " + base64(req.auth))},`);
  if (hs.length) opts.push(`  headers: {\n${hs.join("\n")}\n  },`);
  let pre = "";
  if (req.body && req.body.kind === "multipart") {
    pre = "const form = new FormData();\n" + req.body.fields.map(([k, v]) => `form.append(${jsStr(k)}, ${jsStr(v)});`).join("\n") + "\n\n";
    opts.push("  body: form,");
  } else if (req.body) opts.push(`  body: ${jsStr(req.body.text)},`);
  const note = req.insecure ? "// fetch can’t turn off certificate checks (curl -k)\n" : "";
  return `${pre}${note}const response = await fetch(${jsStr(req.url)}${opts.length ? `, {\n${opts.join("\n")}\n}` : ""});\nconsole.log(response.status, await response.text());`;
}

function toPython(req) {
  const py = (s) => jsStr(s); // a JSON string is a valid Python string literal
  const out = ["import requests", "", `url = ${py(req.url)}`];
  const args = ["url"];
  if (req.headers.length) {
    out.push("headers = {", ...req.headers.map(([k, v]) => `    ${py(k)}: ${py(v)},`), "}");
    args.push("headers=headers");
  }
  if (req.body && req.body.kind === "multipart") {
    out.push("files = {", ...req.body.fields.map(([k, v]) => `    ${py(k)}: (None, ${py(v)}),`), "}");
    args.push("files=files");
  } else if (req.body) {
    out.push(`data = ${py(req.body.text)}.encode()`);
    args.push("data=data");
  }
  if (req.auth) {
    const i = req.auth.indexOf(":");
    args.push(`auth=(${py(i >= 0 ? req.auth.slice(0, i) : req.auth)}, ${py(i >= 0 ? req.auth.slice(i + 1) : "")})`);
  }
  if (req.insecure) args.push("verify=False");
  const m = req.method.toLowerCase();
  const call = ["get", "post", "put", "patch", "delete", "head", "options"].includes(m) ? `requests.${m}(${args.join(", ")})` : `requests.request(${py(req.method)}, ${args.join(", ")})`;
  out.push("", `response = ${call}`, "print(response.status_code)", "print(response.text)");
  return out.join("\n");
}

function toHTTPie(req) {
  const flags = [];
  const esc = (k) => k.replace(/([\\:=@])/g, "\\$1");
  if (req.body && req.body.kind === "multipart") flags.push("--multipart");
  else if (req.body) flags.push(`--raw ${shq(req.body.text)}`);
  if (req.auth) flags.push(`-a ${shq(req.auth)}`);
  if (req.insecure) flags.push("--verify=no");
  const rest = [];
  for (const [k, v] of req.headers) rest.push(shq(v === "" ? `${esc(k)};` : `${esc(k)}:${v}`));
  if (req.body && req.body.kind === "multipart") for (const [k, v] of req.body.fields) rest.push(shq(`${esc(k)}=${v}`));
  const method = req.method === "GET" && !req.body ? "" : `${shq(req.method)} `;
  return lines(`http ${flags.map((f) => f + " ").join("")}${method}${shq(req.url)}`, rest);
}

function toWget(req) {
  if (req.body && req.body.kind === "multipart") return null; // wget can't send multipart forms
  const rest = [];
  if (req.method !== "GET" || req.body) rest.push(`--method=${shq(req.method)}`);
  for (const [k, v] of req.headers) rest.push(`--header=${shq(`${k}: ${v}`)}`);
  if (req.body) rest.push(`--body-data=${shq(req.body.text)}`);
  if (req.auth) {
    const i = req.auth.indexOf(":");
    rest.push(`--user=${shq(i >= 0 ? req.auth.slice(0, i) : req.auth)}`);
    if (i >= 0) rest.push(`--password=${shq(req.auth.slice(i + 1))}`);
  }
  if (req.insecure) rest.push("--no-check-certificate");
  rest.push("-O -");
  return lines(`wget ${shq(req.url)}`, rest);
}

const CONVERTERS = [
  ["curl", "curl", toCurl],
  ["fetch", "JavaScript fetch", toFetch],
  ["python", "Python requests", toPython],
  ["httpie", "HTTPie", toHTTPie],
  ["wget", "wget", toWget],
];

// ---------- status codes (works offline) ----------
// [code, name, explanation, unofficial source]

const STATUS = [
  [100, "Continue", "The server got the request headers; the client should send the body."],
  [101, "Switching Protocols", "The server agrees to switch protocols, for example to WebSocket."],
  [102, "Processing", "WebDAV: the server is still working on the request (deprecated)."],
  [103, "Early Hints", "Preload hints sent before the final response, usually Link headers."],
  [200, "OK", "The request succeeded."],
  [201, "Created", "The request succeeded and created a resource, usually named in the Location header."],
  [202, "Accepted", "The request was accepted for processing, which hasn’t finished yet."],
  [203, "Non-Authoritative Information", "A proxy changed the origin server’s successful response."],
  [204, "No Content", "The request succeeded and there is no body to send back."],
  [205, "Reset Content", "The request succeeded; the client should reset the form or view that sent it."],
  [206, "Partial Content", "The server sends only the range the client asked for (Range header)."],
  [207, "Multi-Status", "WebDAV: the body holds separate status codes for several operations."],
  [208, "Already Reported", "WebDAV: these members were already listed earlier in the response."],
  [226, "IM Used", "The response is the result of instance manipulations (delta encoding)."],
  [300, "Multiple Choices", "The resource has several representations to choose from."],
  [301, "Moved Permanently", "The resource has a new permanent URL (Location). Clients may change POST to GET when following it."],
  [302, "Found", "The resource is temporarily at another URL (Location). Clients often change POST to GET."],
  [303, "See Other", "Get the result from another URL (Location) with GET, typically after a form POST."],
  [304, "Not Modified", "The cached copy is still valid (after If-None-Match or If-Modified-Since); no body."],
  [305, "Use Proxy", "Deprecated: the resource must be accessed through a proxy."],
  [307, "Temporary Redirect", "The resource is temporarily at another URL; repeat the same method and body there."],
  [308, "Permanent Redirect", "The resource has a new permanent URL; repeat the same method and body there."],
  [400, "Bad Request", "The server can’t process the request: malformed syntax, invalid JSON or bad parameters."],
  [401, "Unauthorized", "Authentication is missing or invalid. Check the Authorization header or API key."],
  [402, "Payment Required", "Reserved; some APIs use it when a plan or payment is needed."],
  [403, "Forbidden", "The server understood who you are but refuses access to this resource."],
  [404, "Not Found", "The server has nothing at this URL. Check the path, or the resource was deleted."],
  [405, "Method Not Allowed", "This URL doesn’t support the method; the Allow header lists the ones it does."],
  [406, "Not Acceptable", "The server can’t produce a format that matches the Accept headers."],
  [407, "Proxy Authentication Required", "The proxy in between needs you to authenticate first."],
  [408, "Request Timeout", "The server gave up waiting for the client to finish sending the request."],
  [409, "Conflict", "The request conflicts with the resource’s current state, like an edit conflict or a duplicate."],
  [410, "Gone", "The resource was deleted on purpose and won’t come back."],
  [411, "Length Required", "The server needs a Content-Length header."],
  [412, "Precondition Failed", "A condition in the headers (If-Match, If-Unmodified-Since) didn’t hold."],
  [413, "Content Too Large", "The request body is larger than the server accepts."],
  [414, "URI Too Long", "The URL is longer than the server will process, often from a huge query string."],
  [415, "Unsupported Media Type", "The server doesn’t accept the body’s format. Check the Content-Type header."],
  [416, "Range Not Satisfiable", "The requested range is outside the resource."],
  [417, "Expectation Failed", "The server can’t meet the Expect header."],
  [418, "I’m a teapot", "An April Fools’ joke from RFC 2324: the teapot refuses to brew coffee."],
  [421, "Misdirected Request", "The request went to a server that can’t answer for this host (often an HTTP/2 connection reuse)."],
  [422, "Unprocessable Content", "The syntax is fine but the content fails validation, like a missing required field."],
  [423, "Locked", "WebDAV: the resource is locked."],
  [424, "Failed Dependency", "WebDAV: the request failed because an earlier one it depends on failed."],
  [425, "Too Early", "The server won’t process a request that might be replayed (TLS early data)."],
  [426, "Upgrade Required", "Switch to another protocol (named in the Upgrade header) and try again."],
  [428, "Precondition Required", "The server requires a conditional request (If-Match) to prevent lost updates."],
  [429, "Too Many Requests", "Rate limited. Wait before trying again; Retry-After says how long."],
  [431, "Request Header Fields Too Large", "The headers are too large, often from big cookies."],
  [451, "Unavailable For Legal Reasons", "The resource can’t be served for legal reasons, like a court order."],
  [500, "Internal Server Error", "The server hit an unexpected error. The problem is on the server’s side."],
  [501, "Not Implemented", "The server doesn’t support the functionality or method the request needs."],
  [502, "Bad Gateway", "A proxy or gateway got an invalid response from the server behind it."],
  [503, "Service Unavailable", "The server is overloaded or down for maintenance; Retry-After may say when to try again."],
  [504, "Gateway Timeout", "A proxy or gateway didn’t get a response from the server behind it in time."],
  [505, "HTTP Version Not Supported", "The server doesn’t support the HTTP version used."],
  [506, "Variant Also Negotiates", "The server’s content negotiation is misconfigured."],
  [507, "Insufficient Storage", "WebDAV: the server can’t store what it needs to complete the request."],
  [508, "Loop Detected", "WebDAV: the server found an infinite loop while processing the request."],
  [510, "Not Extended", "The server needs further extensions to the request (obsolete)."],
  [511, "Network Authentication Required", "You need to sign in to the network first, like a hotel or airport Wi-Fi portal."],
  [420, "Enhance Your Calm", "Rate limited (the old Twitter API; others use 429).", "Twitter"],
  [440, "Login Time-out", "The session expired; sign in again.", "Microsoft IIS"],
  [444, "No Response", "nginx closed the connection without sending anything.", "nginx"],
  [494, "Request Header Too Large", "nginx: the request headers are too large.", "nginx"],
  [495, "SSL Certificate Error", "nginx: the client certificate is invalid.", "nginx"],
  [496, "SSL Certificate Required", "nginx: a client certificate is required.", "nginx"],
  [497, "HTTP Request Sent to HTTPS Port", "nginx: plain HTTP was sent to an HTTPS port.", "nginx"],
  [499, "Client Closed Request", "nginx: the client closed the connection before the server answered.", "nginx"],
  [520, "Web Server Returned an Unknown Error", "Cloudflare got an empty or unexpected response from the origin server.", "Cloudflare"],
  [521, "Web Server Is Down", "Cloudflare couldn’t connect to the origin server.", "Cloudflare"],
  [522, "Connection Timed Out", "Cloudflare’s connection to the origin server timed out.", "Cloudflare"],
  [523, "Origin Is Unreachable", "Cloudflare can’t reach the origin server, often a DNS or routing problem.", "Cloudflare"],
  [524, "A Timeout Occurred", "The origin server accepted the connection but didn’t answer in time.", "Cloudflare"],
  [525, "SSL Handshake Failed", "The TLS handshake between Cloudflare and the origin server failed.", "Cloudflare"],
  [526, "Invalid SSL Certificate", "Cloudflare couldn’t validate the origin server’s certificate.", "Cloudflare"],
  [530, "Origin DNS Error", "Cloudflare returned a 1xxx error; the body has the details.", "Cloudflare"],
  [598, "Network Read Timeout", "Some proxies: the read from the server timed out.", "proxies"],
  [599, "Network Connect Timeout", "Some proxies: connecting to the server timed out.", "proxies"],
];
const STATUS_BY_CODE = new Map(STATUS.map((s) => [s[0], s]));
const CLASS_NAME = { 1: "Informational", 2: "Success", 3: "Redirection", 4: "Client error", 5: "Server error" };

function statusURL(code) {
  const s = STATUS_BY_CODE.get(code);
  if (!s || s[3] || code === 305) return null;
  return `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/${code}`;
}
function statusName(code) {
  const s = STATUS_BY_CODE.get(code);
  return s ? s[1] : CLASS_NAME[Math.floor(code / 100)] || "";
}

// ---------- JSON preview ----------

// Re-indent JSON without parsing it into numbers, so 12345678901234567890 and 1.0 stay as written
function prettyJSON(text, indent = "  ") {
  const re = /"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|\s+|[^{}\[\],:"\s]+/y;
  const out = [];
  let depth = 0, m, prevOpen = false;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const t = m[0];
    const c = t[0];
    if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
    if (c === "{" || c === "[") {
      if (prevOpen) out.push("\n" + indent.repeat(depth));
      out.push(t);
      depth++;
      prevOpen = true;
      continue;
    }
    if (c === "}" || c === "]") {
      depth = Math.max(0, depth - 1);
      if (prevOpen) out.push(t); // {} and [] stay on one line
      else out.push("\n" + indent.repeat(depth) + t);
      prevOpen = false;
      continue;
    }
    if (prevOpen) out.push("\n" + indent.repeat(depth));
    prevOpen = false;
    if (c === ",") out.push(",\n" + indent.repeat(depth));
    else if (c === ":") out.push(": ");
    else out.push(t);
  }
  return out.join("");
}

// ---------- sending ----------

const respRoot = () => mkdirs(`${cacheDir()}/resp`, true);
const respDir = (rid) => `${respRoot()}/${rid}`;
const RID_RE = /^[a-z0-9]{6,16}-[a-z0-9]{4,8}$/;
function newRid() {
  return `${Math.floor(now() * 1000).toString(36)}-${Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0")}`;
}

// A curl config value: quoted, with backslashes and quotes escaped. Control characters are refused
// (a header can't hold a line break); text may contain them escaped (curl's config file syntax).
function cfg(s) {
  s = String(s);
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(s)) throw new Error("control character in request");
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t") + '"';
}
function cfgText(s) {
  s = String(s);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) throw new Error("control character in a form field");
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
}

const WRITE_OUT = "%{stderr}\\n@@alfred-http@@ %{http_code} %{http_version} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_pretransfer} %{time_starttransfer} %{time_total} %{size_download} %{num_redirects} %{exitcode} %{remote_ip}\\n@@url@@ %{url_effective}\\n@@err@@ %{errormsg}\\n";

function curlConfig(req, dir) {
  const L = [
    `url = ${cfg(req.url)}`, "globoff", "silent", "show-error", "compressed",
    `proto = "=http,https"`, `proto-redir = "=http,https"`, // never file://, even after a redirect
    `max-time = ${TIMEOUT}`, `connect-timeout = ${Math.min(TIMEOUT, 15)}`,
    `max-filesize = ${MAX_BYTES}`, `dump-header = ${cfg(`${dir}/headers.txt`)}`, `write-out = "${WRITE_OUT}"`,
  ];
  if (FOLLOW) L.push("location", "max-redirs = 10");
  if (req.method === "HEAD") L.push("head");
  else if (!(req.method === "GET" && !req.body) && !(req.method === "POST" && req.body)) L.push(`request = ${cfg(req.method)}`);
  if (header(req, "User-Agent") === null) L.push(`user-agent = ${cfg(UA)}`);
  for (const [k, v] of req.headers) L.push(`header = ${cfg(v === "" ? `${k};` : `${k}: ${v}`)}`);
  if (req.auth) L.push(`user = ${cfg(req.auth)}`);
  if (req.insecure) L.push("insecure");
  if (req.body && req.body.kind === "multipart") {
    for (const [k, v] of req.body.fields) L.push(`form-string = ${cfgText(`${k}=${v}`)}`);
  } else if (req.body) {
    // the body goes through a file so any text (quotes, newlines, "@…") is sent exactly
    $(req.body.text).writeToFileAtomicallyEncodingError(`${dir}/reqbody`, false, $.NSUTF8StringEncoding, $());
    L.push(`data-binary = ${cfg(`@${dir}/reqbody`)}`);
  }
  return L.join("\n") + "\n";
}

function createFile(path) {
  FM.createFileAtPathContentsAttributes(path, $(), $({ NSFilePosixPermissions: 0o600 }));
  return $.NSFileHandle.fileHandleForWritingAtPath(path);
}

// Run curl, streaming the body into a file and stopping at the size limit. Returns the raw result.
function runCurl(req, dir) {
  const config = curlConfig(req, dir);
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath("/usr/bin/curl");
  task.arguments = ["-q", "-K", "-"]; // -q: never read the user's ~/.curlrc
  const inP = $.NSPipe.pipe, outP = $.NSPipe.pipe;
  const errFile = createFile(`${dir}/stderr.txt`);
  task.standardInput = inP;
  task.standardOutput = outP;
  task.standardError = errFile;
  if (!task.launchAndReturnError($())) return { exit: -1, error: "Couldn’t start /usr/bin/curl" };
  writeFile(`${dir}/curlpid`, String(task.processIdentifier));
  inP.fileHandleForWriting.writeData($(config).dataUsingEncoding($.NSUTF8StringEncoding));
  inP.fileHandleForWriting.closeFile;
  const out = createFile(`${dir}/body.tmp`);
  const rd = outP.fileHandleForReading;
  let total = 0, truncated = false;
  for (;;) {
    const d = rd.availableData;
    const len = Number(d.length);
    if (!len) break;
    if (req.method !== "HEAD") out.writeData(d);
    total += len;
    if (total > MAX_BYTES) {
      truncated = true;
      task.terminate;
      break;
    }
  }
  out.truncateFileAtOffset(Math.min(total, MAX_BYTES));
  out.closeFile;
  task.waitUntilExit;
  errFile.closeFile;
  removeFile(`${dir}/curlpid`);
  removeFile(`${dir}/reqbody`);
  return { exit: truncated ? -2 : task.terminationStatus, truncated, total: Math.min(total, MAX_BYTES) };
}

function parseHeaderDump(text) {
  const blocks = String(text || "").split(/\r?\n\r?\n/).map((b) => b.trim()).filter((b) => /^HTTP\/[\d.]+\s+\d{3}/.test(b));
  const parsed = blocks.map((b) => {
    const ls = b.split(/\r?\n/);
    const m = /^HTTP\/([\d.]+)\s+(\d{3})\s*(.*)$/.exec(ls[0]);
    const headers = [];
    for (const l of ls.slice(1)) {
      if (/^[ \t]/.test(l) && headers.length) headers[headers.length - 1][1] += " " + l.trim(); // folded line
      else {
        const c = l.indexOf(":");
        if (c > 0) headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
      }
    }
    return { version: m[1], status: Number(m[2]), reason: m[3].trim(), headers };
  });
  const finals = parsed.filter((b) => b.status >= 200);
  const final = finals.length ? finals[finals.length - 1] : parsed[parsed.length - 1] || null;
  const redirects = finals.slice(0, -1).map((b) => {
    const loc = b.headers.find(([k]) => k.toLowerCase() === "location");
    return { status: b.status, location: loc ? loc[1] : "" };
  });
  return { final, redirects };
}

const CURL_ERRORS = {
  1: "Couldn’t follow a redirect: only http:// and https:// are allowed",
  3: "The URL is malformed",
  5: "Can’t reach the proxy",
  6: "Can’t reach {host}: the server wasn’t found",
  7: "Can’t reach {host}: the connection was refused",
  16: "The HTTP/2 connection failed",
  18: "The response ended early",
  28: "Couldn’t get a response within {timeout} s",
  35: "Couldn’t connect securely to {host}",
  47: "Too many redirects",
  52: "The server closed the connection without a response",
  55: "Couldn’t send the request: the connection broke",
  56: "The connection broke while receiving the response",
  58: "Couldn’t connect securely: client certificate problem",
  60: "Couldn’t connect securely: {host}’s certificate isn’t trusted",
  61: "The server used an unknown content encoding",
  63: "The response is larger than the {limit} limit",
  92: "The HTTP/2 stream failed",
};

function charsetEncoding(name) {
  if (!name) return 0;
  const cf = $.CFStringConvertIANACharSetNameToEncoding($(name));
  if (cf === 0xffffffff || cf === 4294967295) return 0; // kCFStringEncodingInvalidId
  return Number($.CFStringConvertEncodingToNSStringEncoding(cf));
}
function decodeData(data, charset) {
  const enc = charsetEncoding(charset);
  if (enc && enc !== 4) {
    const s = $.NSString.alloc.initWithDataEncoding(data, enc);
    if (!s.isNil()) return { text: s.js, encoding: charset.toUpperCase() };
  }
  let s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (!s.isNil()) return { text: s.js, encoding: "UTF-8" };
  s = $.NSString.alloc.initWithDataEncoding(data, 12); // not UTF-8: show it as Windows-1252
  return { text: s.isNil() ? "" : s.js, encoding: "Windows-1252", guessed: true };
}
function magic(data) {
  const n = Math.min(16, Number(data.length));
  if (!n) return "";
  const bytes = [];
  const bin = $.NSString.alloc.initWithDataEncoding(data.subdataWithRange($.NSMakeRange(0, n)), $.NSISOLatin1StringEncoding).js || "";
  for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i));
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.startsWith("89504e47")) return "png";
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (hex.startsWith("47494638")) return "gif";
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return "webp";
  if (hex.startsWith("25504446")) return "pdf";
  if (hex.startsWith("1f8b") || hex.startsWith("504b0304")) return "bin";
  return "";
}

// NUL or other control characters in the first 4 KB (text has tabs, line breaks and ESC at most)
function looksBinary(data) {
  const n = Math.min(4096, Number(data.length));
  const s = $.NSString.alloc.initWithDataEncoding(data.subdataWithRange($.NSMakeRange(0, n)), $.NSISOLatin1StringEncoding).js || "";
  return /[\x00-\x08\x0b\x0e-\x1a\x1c-\x1f]/.test(s);
}

// a Map: the Content-Type comes from the server ("constructor" must not find Object.prototype)
const IMAGE_EXT = new Map(Object.entries({ "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/heic": "heic", "image/bmp": "bmp", "image/tiff": "tiff", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/avif": "avif" }));

// Name the body file for Quick Look and build the preview (pretty JSON, transcoded text)
function describeBody(dir, contentType, method, status) {
  const tmp = `${dir}/body.tmp`;
  const size = fileSize(tmp);
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  const cm = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType || "");
  const charset = cm ? cm[1] : "";
  const res = { kind: "empty", bodyFile: "", previewFile: "", previewText: "", lines: 0, encoding: "" };
  if (!size) {
    removeFile(tmp);
    return res;
  }
  const data = $.NSData.dataWithContentsOfFile(tmp);
  const sniff = magic(data);
  let kind, ext;
  if (IMAGE_EXT.has(mime) || (!mime && ["png", "jpg", "gif", "webp"].includes(sniff))) [kind, ext] = ["image", IMAGE_EXT.get(mime) || sniff];
  else if (mime === "application/pdf" || (!mime && sniff === "pdf")) [kind, ext] = ["pdf", "pdf"];
  else if (/[/+]json$/.test(mime) || mime === "application/x-ndjson") [kind, ext] = ["json", "json"];
  else if (mime === "text/html" || mime === "application/xhtml+xml") [kind, ext] = ["html", "html"];
  else if (/[/+]xml$/.test(mime)) [kind, ext] = ["xml", "xml"];
  else if (/^text\//.test(mime) || /javascript|ecmascript|yaml|csv|x-www-form-urlencoded|graphql/.test(mime)) [kind, ext] = ["text", "txt"];
  else if (mime || sniff) [kind, ext] = ["binary", "bin"];
  else if (looksBinary(data)) [kind, ext] = ["binary", "bin"];
  else [kind, ext] = ["text", "txt"]; // no type and no control characters: text (UTF-8, or else Windows-1252)
  res.kind = kind;
  if (kind === "text" || kind === "json" || kind === "html" || kind === "xml") {
    const head = size > PRETTY_MAX ? data.subdataWithRange($.NSMakeRange(0, 65536)) : data;
    let dec = decodeData(head, charset);
    if (size > PRETTY_MAX && dec.encoding === "Windows-1252" && dec.guessed) {
      // the 64 KB cut may split a UTF-8 character: try a few bytes shorter
      for (let cut = 1; cut <= 3 && dec.guessed; cut++) {
        const d2 = decodeData(data.subdataWithRange($.NSMakeRange(0, 65536 - cut)), charset);
        if (!d2.guessed) dec = d2;
      }
    }
    {
      let text = dec.text;
      res.encoding = dec.encoding;
      const t = text.trim();
      if (kind === "text" && !mime && /^[{\[]/.test(t) && !jsonError(t)) [kind, ext] = ["json", "json"];
      else if (kind === "text" && !mime && /^<(!doctype html|html)/i.test(t)) [kind, ext] = ["html", "html"];
      res.kind = kind;
      let preview = null;
      if (kind === "json" && size <= PRETTY_MAX && !jsonError(t)) preview = prettyJSON(t);
      else if (dec.encoding !== "UTF-8" && size <= PRETTY_MAX) preview = kind === "html" ? `<meta charset="utf-8">\n${text}` : text;
      if (preview !== null) {
        writeFile(`${dir}/preview.${ext}`, preview);
        res.previewFile = `${dir}/preview.${ext}`;
        text = preview;
      }
      res.previewText = text.slice(0, 4000);
      res.lines = size <= PRETTY_MAX ? (text.match(/\n/g) || []).length + 1 : 0;
      res.truncatedPreview = size > PRETTY_MAX;
    }
  }
  res.kind = kind;
  const body = `${dir}/body.${ext}`;
  FM.moveItemAtPathToPathError(tmp, body, $());
  res.bodyFile = body;
  if (!res.previewFile) res.previewFile = body;
  if (kind === "binary") res.previewText = `Binary data · ${fmtBytes(size)}${mime ? ` · ${mime}` : ""}`;
  if (kind === "image" || kind === "pdf") res.previewText = `${kind === "pdf" ? "PDF" : "Image"} · ${fmtBytes(size)} · ${mime || ext}`;
  return res;
}

// Send the request stored in resp/<rid>/request.json and write meta.json next to it.
function sendNow(rid, detached) {
  if (!RID_RE.test(rid)) return;
  if (detached) $.setsid(); // leave Alfred's process group: a new Alfred query must not kill the request
  const dir = respDir(rid);
  const req = cleanRequest(readJSON(`${dir}/request.json`, null));
  const started = now();
  const meta = { rid, t: started, method: req ? req.method : "", url: req ? req.url : "", status: 0, error: null, headers: [], redirects: [] };
  writeFile(`${dir}/pid`, String(PID));
  try {
    if (!req) throw Object.assign(new Error("The stored request is damaged"), { code: -1 });
    const r = runCurl(req, dir);
    const err = readFile(`${dir}/stderr.txt`) || "";
    const wo = /@@alfred-http@@ (\d{3}) (\S+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) (\d+) (\d+) (\d+) ?(\S*)/.exec(err);
    const url = /@@url@@ (.*)/.exec(err), emsg = /@@err@@ (.*)/.exec(err);
    const dump = parseHeaderDump(readText(`${dir}/headers.txt`));
    if (dump.final) {
      meta.status = dump.final.status;
      meta.reason = dump.final.reason || statusName(dump.final.status);
      meta.httpVersion = dump.final.version;
      meta.headers = dump.final.headers;
      meta.redirects = dump.redirects;
    }
    if (wo) {
      const [dns, conn, tls, pre, start, total] = wo.slice(3, 9).map(Number);
      meta.timing = { dns, connect: Math.max(0, conn - dns), tls: tls > 0 ? Math.max(0, tls - conn) : 0, ttfb: start, total };
      if (!meta.status && Number(wo[1])) meta.status = Number(wo[1]);
      meta.remoteIP = wo[12] || "";
      meta.effectiveURL = url ? url[1].trim() : req.url;
    }
    const code = r.truncated ? 63 : wo ? Number(wo[11]) : r.exit;
    if (r.truncated) meta.truncated = true;
    if (code !== 0) {
      const tmpl = CURL_ERRORS[code];
      const detail = emsg ? emsg[1].trim() : err.split("\n").filter((l) => l && !l.startsWith("@@")).join(" ").trim();
      meta.error = {
        code,
        message: tmpl ? tmpl.replace("{host}", hostOf(req.url)).replace("{timeout}", String(TIMEOUT)).replace("{limit}", fmtBytes(MAX_BYTES)) : `Couldn’t send the request: ${oneLine(detail, 120) || `curl error ${code}`}`,
        detail: oneLine(detail, 300),
      };
      if (code === 63) meta.truncated = true;
    }
    const ct = (meta.headers.slice().reverse().find(([k]) => k.toLowerCase() === "content-type") || [])[1] || "";
    meta.contentType = ct;
    meta.size = fileSize(`${dir}/body.tmp`);
    Object.assign(meta, describeBody(dir, ct, req.method, meta.status));
  } catch (e) {
    meta.error = { code: e.code || -1, message: `Couldn’t send the request: ${e.message}` };
  }
  meta.done = now();
  writeFile(`${dir}/meta.json`, JSON.stringify(meta));
  removeFile(`${dir}/pid`);
  if (!KEEP_SECRETS) writeFile(`${dir}/request.json`, JSON.stringify(redactRequest(req || {})));
  updateHistory(rid, meta);
  return meta;
}

function respState(rid) {
  const dir = respDir(rid);
  const meta = readJSON(`${dir}/meta.json`, null);
  if (meta) return { state: "done", meta };
  if (!exists(dir)) return { state: "missing" };
  const pid = Number(readFile(`${dir}/pid`));
  const started = mtime(`${dir}/request.json`);
  if (pid > 1 && alive(pid)) return { state: "running", started };
  // not started yet (spawn in progress) or the sender died
  return Date.now() / 1000 - started < 3 ? { state: "running", started } : { state: "dead" };
}

// ---------- storage ----------

const historyPath = () => `${dataDir()}/history.json`;
const savedPath = () => `${dataDir()}/saved.json`;
const stashDir = () => mkdirs(`${cacheDir()}/req`, true);
const outDir = () => mkdirs(`${cacheDir()}/out`, true);
const STASH_RE = /^[0-9a-f]{14}$/;

// Without "Remember secrets", history keeps the request but drops secret headers and the password
function redactRequest(req) {
  const r = JSON.parse(JSON.stringify(req));
  if (!Array.isArray(r.headers)) return r;
  const dropped = r.headers.filter(([k]) => isSecretHeader(k)).map(([k]) => k);
  r.headers = r.headers.filter(([k]) => !isSecretHeader(k));
  if (typeof r.auth === "string" && r.auth.includes(":")) {
    r.auth = r.auth.slice(0, r.auth.indexOf(":") + 1);
    dropped.push("password");
  }
  if (typeof r.url === "string" && /^https?:\/\/[^/?#@]*:[^/?#@]*@/i.test(r.url)) {
    r.url = r.url.replace(/^(https?:\/\/[^/?#@:]*):[^/?#@]*@/i, "$1@");
    dropped.push("password");
  }
  if (dropped.length) r.redacted = true;
  return r;
}

function loadHistory() {
  const h = readJSON(historyPath(), { items: [] });
  return (Array.isArray(h.items) ? h.items : [])
    .map((e) => (e && typeof e === "object" && RID_RE.test(e.id) ? Object.assign(e, { req: cleanRequest(e.req) }) : null))
    .filter((e) => e && e.req);
}
function saveHistory(items) {
  return writeFile(historyPath(), JSON.stringify({ version: 1, items: items.slice(0, HISTORY_MAX) }));
}
const historyLock = () => `${cacheDir()}/history.lock`;
function addHistory(rid, req) {
  withLock(historyLock(), () => {
    const fp = fingerprint(req);
    const items = loadHistory().filter((e) => e.fp !== fp);
    items.unshift({ id: rid, t: now(), fp, req: KEEP_SECRETS ? req : redactRequest(req), status: 0 });
    saveHistory(items);
  });
}
function updateHistory(rid, meta) {
  withLock(historyLock(), () => {
    const items = loadHistory();
    const e = items.find((x) => x.id === rid);
    if (!e) return;
    e.status = meta.status || 0;
    e.ms = meta.timing ? Math.round(meta.timing.total * 1000) : null;
    e.size = meta.size || 0;
    e.error = meta.error && !meta.status ? meta.error.message : null;
    saveHistory(items);
  });
}

function loadSaved() {
  const s = readJSON(savedPath(), { items: [] });
  return (Array.isArray(s.items) ? s.items : [])
    .map((e) => (e && typeof e === "object" && typeof e.name === "string" && validName(e.name) ? Object.assign(e, { req: cleanRequest(e.req) }) : null))
    .filter((e) => e && e.req);
}
function validName(name) {
  return name.length >= 1 && name.length <= 60 && !/[\x00-\x1f\x7f]/.test(name);
}
function saveNamed(name, req) {
  return withLock(`${cacheDir()}/saved.lock`, () => {
    const items = loadSaved().filter((e) => e.name.toLowerCase() !== name.toLowerCase());
    if (items.length >= SAVED_MAX) return false;
    items.unshift({ name, t: now(), req });
    return writeFile(savedPath(), JSON.stringify({ version: 1, items }));
  });
}
function removeNamed(name) {
  return withLock(`${cacheDir()}/saved.lock`, () => {
    const all = loadSaved();
    const items = all.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
    if (items.length === all.length) return false;
    return writeFile(savedPath(), JSON.stringify({ version: 1, items }));
  });
}

// A typed or pasted request travels to the action in an item variable (never in arg: it may hold
// secrets), so nothing is written to disk while typing. One too large for the environment is
// stashed in the cache by content instead.
const VAR_MAX = 64 * 1024;
function reqVars(req) {
  const json = JSON.stringify(req);
  if (json.length <= VAR_MAX) return { http_req: json };
  const id = fingerprint(req);
  const p = `${stashDir()}/${id}.json`;
  if (!exists(p)) writeFile(p, json);
  return { http_ref: `req:${id}` };
}
function loadStash(id) {
  if (!STASH_RE.test(id)) return null;
  return cleanRequest(readJSON(`${stashDir()}/${id}.json`, null));
}
// The request an action works on: $http_req (JSON), or $http_ref / arg as a reference
function requestFromEnv(arg) {
  const json = env("http_req", "");
  if (json) {
    try {
      return cleanRequest(JSON.parse(json));
    } catch (e) {
      return null;
    }
  }
  return loadRef(env("http_ref", arg));
}
// "req:<id>" (stash), "hist:<rid>" (history), "resp:<rid>" (a sent request) or "saved:<name>"
function loadRef(ref) {
  ref = String(ref || "");
  if (ref.startsWith("req:")) return loadStash(ref.slice(4));
  if (ref.startsWith("resp:")) return RID_RE.test(ref.slice(5)) ? cleanRequest(readJSON(`${respDir(ref.slice(5))}/request.json`, null)) : null;
  if (ref.startsWith("hist:")) {
    const e = loadHistory().find((x) => x.id === ref.slice(5));
    return e ? e.req : null;
  }
  if (ref.startsWith("saved:")) {
    const name = ref.slice(6).toLowerCase();
    const e = loadSaved().find((x) => x.name.toLowerCase() === name);
    return e ? e.req : null;
  }
  return null;
}

// Long texts (converted commands, big bodies) travel as httpfile:<path>; resolve.sh and act read them back
function outText(text) {
  if (text.length <= INLINE_MAX) return text;
  const p = `${outDir()}/${hash(text)}.txt`;
  if (!exists(p)) writeFile(p, text);
  return `httpfile:${p}`;
}
function resolveText(arg) {
  const m = /^httpfile:(.+)$/.exec(arg);
  if (!m) return arg;
  const root = `${cacheDir()}/`;
  const rel = m[1].startsWith(root) ? m[1].slice(root.length) : "";
  if (!/^(out\/[0-9a-f]{14}\.txt|resp\/[a-z0-9]{6,16}-[a-z0-9]{4,8}\/(body|preview)\.(json|html|xml|txt|svg))$/.test(rel)) return arg;
  return readText(m[1]);
}

function prune() {
  const t = Date.now() / 1000;
  const rdirs = listDir(respRoot()).filter((d) => RID_RE.test(d)).sort().reverse();
  rdirs.forEach((d, i) => {
    const p = `${respRoot()}/${d}`;
    const running = alive(Number(readFile(`${p}/pid`)));
    if (!running && (i >= RESPONSES_MAX || t - mtime(p) > 7 * 86400)) removeFile(p);
  });
  for (const [dir, age] of [[stashDir(), 86400], [outDir(), 3600]]) {
    for (const f of listDir(dir)) if (t - mtime(`${dir}/${f}`) > age) removeFile(`${dir}/${f}`);
  }
}

// ---------- clipboard ----------

function clipboardText() {
  const t = env("HTTP_TEST_CLIPBOARD", null); // test suite only
  if (t !== null) return t;
  const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
  return s.isNil() ? "" : s.js;
}
function setClipboard(text) {
  const out = env("HTTP_TEST_CLIPBOARD_OUT", null); // test suite only
  if (out !== null) return writeFile(out, text);
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  return pb.setStringForType($(text), $.NSPasteboardTypeString);
}

// ---------- Script Filter items ----------

function icon(name) {
  return { path: `icons/${name}.png` };
}
const METHOD_ICON = new Map(Object.entries({ GET: "get", HEAD: "get", OPTIONS: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "delete" }));
const methodIcon = (m) => icon(METHOD_ICON.get(m) || "method"); // a Map: methods are user input
function statusIcon(code) {
  return icon(code >= 500 ? "s5xx" : code >= 400 ? "s4xx" : code >= 300 ? "s3xx" : code >= 200 ? "s2xx" : "info");
}

function info(title, subtitle, iconName = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: icon(iconName) }, extra);
}
// Every row sets all modifiers: a modifier without its own arg and variables would run the row's action
function withMods(item, mods = {}) {
  const off = { valid: false, arg: "", subtitle: item.subtitle || "" };
  item.mods = {};
  for (const k of ["cmd", "alt", "ctrl"]) item.mods[k] = mods[k] ? Object.assign({ valid: true }, mods[k]) : off;
  return item;
}
function pasteMod(text, subtitle) {
  return { arg: outText(text), subtitle, variables: { http_action: "paste" } };
}
function copyItem(title, subtitle, text, iconName, extra = {}) {
  return withMods(Object.assign({
    title, subtitle, arg: outText(text), variables: { http_action: "copy" }, icon: icon(iconName),
    text: { copy: text.length <= INLINE_MAX ? text : text.slice(0, INLINE_MAX), largetype: text.slice(0, 4000) },
  }, extra), { cmd: pasteMod(text, "⌘↩ Paste into the frontmost app") });
}

function maskRequest(req) {
  return Object.assign({}, req, {
    url: maskURL(req.url),
    headers: req.headers.map(([k, v]) => [k, maskHeader(k, v)]),
    auth: req.auth ? maskAuth(req.auth) : null,
    body: req.body ? Object.assign({}, req.body, { text: maskBody(req.body.text), fields: req.body.fields && req.body.fields.map(([k, v]) => [k, SECRET_FIELD.test(k) ? DOTS : v]) }) : null,
  });
}
function bodySummary(body) {
  if (!body) return "";
  if (body.kind === "multipart") return `multipart form · ${plural(body.fields.length, "field")}`;
  const bytes = $(body.text).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding);
  return `${{ json: "JSON", form: "form", text: "text" }[body.kind]} body ${fmtBytes(bytes)}`;
}
function requestSummary(req) {
  const parts = [];
  if (req.headers.length) parts.push(plural(req.headers.length, "header"));
  if (req.auth) parts.push("basic auth");
  if (req.body) parts.push(bodySummary(req.body));
  return parts.join(" · ");
}
function requestText(req) {
  const m = maskRequest(req);
  const out = [`${m.method} ${m.url}`, ...m.headers.map(([k, v]) => `${k}: ${v}`)];
  if (m.auth) out.push(`Basic auth: ${m.auth}`);
  if (m.body && m.body.kind === "multipart") out.push("", ...m.body.fields.map(([k, v]) => `${k}=${v}`));
  else if (m.body) out.push("", m.body.kind === "json" && !jsonError(m.body.text) ? prettyJSON(m.body.text) : m.body.text);
  return out.join("\n").slice(0, 4000);
}
const needsConfirm = (req) => CONFIRM && !SAFE_METHODS.has(req.method);

// The row that sends a request (or, for POST/PUT/PATCH/DELETE…, opens the confirmation step)
// o: {ref (hist:/saved:/req: or none), line (the typed text), review (what ! reopens), title, prefix,
//     kind: line|clipboard|history|saved|again|confirm, name, entry, confirmed}
function requestRow(req, o) {
  const title = o.title || `${req.method} ${displayURL(req.url)}`;
  const confirm = needsConfirm(req) && !o.confirmed;
  const hint = confirm ? "↩ Review before sending" : "↩ Send";
  const sub = [o.prefix, requestSummary(req), ...(o.notes || req.notes || []), hint].filter(Boolean).join(" · ");
  const curl = toCurl(req);
  const item = {
    title: oneLine(title, 200), subtitle: sub, icon: methodIcon(req.method),
    text: { copy: curl.length <= INLINE_MAX ? curl : curl.slice(0, INLINE_MAX), largetype: requestText(req) },
  };
  // the review step is a query: "!" + the typed request, or "!" + a reference (hist:…, saved:…, clip)
  if (confirm) Object.assign(item, { valid: false, autocomplete: `!${o.review || o.ref || o.line}` });
  else Object.assign(item, { arg: "send", variables: Object.assign({ http_action: "send" }, o.ref ? { http_ref: o.ref } : reqVars(req)) });
  if (req.method === "GET" && !req.body && !req.headers.length && !req.auth) item.quicklookurl = req.url;
  const mods = { cmd: pasteMod(curl, "⌘↩ Paste as a curl command") };
  if (req.method === "GET" && !req.body) mods.alt = { arg: req.url, subtitle: "⌥↩ Open in the browser", variables: { http_action: "open" } };
  if (o.kind === "history") {
    if (exists(`${respDir(o.entry.id)}/meta.json`)) mods.alt = { arg: o.entry.id, subtitle: "⌥↩ Show the last response", variables: { http_action: "show", http_ref: o.ref } };
    mods.ctrl = { arg: o.entry.id, subtitle: "⌃↩ Remove from the history", variables: { http_action: "forget" } };
  }
  if (o.kind === "saved") mods.ctrl = { arg: o.name, subtitle: `⌃↩ Delete the saved request “${o.name}”`, variables: { http_action: "unsave", http_name: o.name } };
  return withMods(item, mods);
}

// Headers, body and “Copy as …” rows below a request
function detailRows(req, withConverters = true) {
  const items = [];
  for (const n of req.notes || []) items.push(info(n, "Note", "info"));
  for (const [k, v] of req.headers) {
    items.push(copyItem(oneLine(`${k}: ${maskHeader(k, v)}`, 200), `Request header · ↩ Copy the value${isSecretHeader(k) ? " (the real one)" : ""}`, v, "header", { text: { copy: v, largetype: `${k}: ${maskHeader(k, v)}` } }));
  }
  if (req.auth) items.push(info(`Basic auth: ${maskAuth(req.auth)}`, "Sent as an Authorization header", "header"));
  if (req.redacted) items.push(info("Secret headers weren’t kept", "Turn on “Remember secrets” in the Workflow’s Configuration to keep them in the history", "info"));
  if (req.body) {
    const b = req.body;
    const shown = b.kind === "multipart" ? b.fields.map(([k, v]) => `${k}=${SECRET_FIELD.test(k) ? DOTS : v}`).join(" · ") : maskBody(b.text);
    const text = b.kind === "multipart" ? b.fields.map(([k, v]) => `${k}=${v}`).join("\n") : b.text;
    items.push(copyItem(oneLine(shown, 200) || "(empty body)", `${capital(bodySummary(b))} · ↩ Copy · ⌘L Large Type`, text, "body", {
      text: { copy: text.slice(0, INLINE_MAX), largetype: requestText(Object.assign({}, req, { headers: [], method: "", url: "" })).trim() },
    }));
  }
  if (withConverters) items.push(...converterRows(req));
  return items;
}
function converterRows(req) {
  const masked = maskRequest(req);
  const items = [];
  for (const [id, name, fn] of CONVERTERS) {
    const code = fn(req);
    if (code === null) continue;
    const shown = fn(masked);
    items.push(copyItem(`Copy as ${name}`, oneLine(shown, 120), code, "code", { uid: `convert-${id}`, text: { copy: code.slice(0, INLINE_MAX), largetype: shown.slice(0, 4000) } }));
  }
  return items;
}

// ---------- views ----------

function hintRows() {
  return [
    info("Type a request", "Like: get api.github.com/users/octocat · post httpbin.org/post name=Ada age:=36", "info", { autocomplete: "get api.github.com/users/octocat" }),
    info("Paste a curl command", "Copy one in your browser’s developer tools (Network › Copy as cURL), then open this list", "curl"),
    info("Look up a status code", "Like: 404, 429 or 5xx", "status", { autocomplete: "404" }),
  ];
}

function clipboardRow() {
  const clip = clipboardText().trim();
  if (!clip || clip.length > 200000) return null;
  try {
    if (/^curl(\.exe)?\s/i.test(clip)) {
      const req = parseCurl(clip);
      return requestRow(req, { review: "clip", prefix: "curl command in the clipboard", kind: "clipboard" });
    }
    if (/^https?:\/\/\S+$/i.test(clip) && clip.length <= 4000) {
      const req = parseLine(clip);
      return requestRow(req, { review: "clip", prefix: "URL in the clipboard", kind: "clipboard" });
    }
  } catch (e) {
    if (e instanceof ParseError) return info(`Couldn’t read the curl command in the clipboard: ${e.message}`, "Nothing was sent", "error");
    throw e;
  }
  return null;
}

function historyRow(e) {
  const ago = fmtAgo(now() - e.t);
  const result = e.status ? `${e.status} ${statusName(e.status)}` : e.error ? oneLine(e.error, 40) : "no response";
  const notes = e.req.redacted ? ["secrets weren’t kept"] : [];
  return requestRow(e.req, { ref: `hist:${e.id}`, prefix: `${result} · ${ago}`, kind: "history", entry: e, notes });
}
function savedRow(e) {
  return requestRow(e.req, { ref: `saved:${e.name}`, title: `${e.name} · ${e.req.method} ${displayURL(e.req.url)}`, prefix: "Saved", kind: "saved", name: e.name, notes: [] });
}

function homeView() {
  const marker = `${cacheDir()}/pruned`;
  if (Date.now() / 1000 - mtime(marker) > 3600) {
    writeFile(marker, "");
    prune();
  }
  const items = [];
  const clip = clipboardRow();
  if (clip) items.push(clip);
  const saved = loadSaved(), hist = loadHistory();
  items.push(...saved.slice(0, 20).map((e) => Object.assign(savedRow(e), { icon: icon("saved") })));
  items.push(...hist.slice(0, 30).map(historyRow));
  if (!saved.length && !hist.length) items.push(...hintRows());
  return { items };
}

function searchView(q, parseErr) {
  const needle = q.toLowerCase();
  const items = [];
  if (parseErr) items.push(info(parseErr.message, "Example: post httpbin.org/post name=Ada age:=36 · quote values with spaces", "error"));
  const saved = loadSaved().filter((e) => e.name.toLowerCase().includes(needle) || displayURL(e.req.url).toLowerCase().includes(needle));
  const hist = loadHistory().filter((e) => displayURL(e.req.url).toLowerCase().includes(needle) || e.req.method.toLowerCase() === needle);
  items.push(...saved.slice(0, 20).map((e) => Object.assign(savedRow(e), { icon: icon("saved") })));
  items.push(...hist.slice(0, 20).map(historyRow));
  if (needle.length >= 3) items.push(...STATUS.filter((s) => s[1].toLowerCase().includes(needle)).slice(0, 10).map(statusRow));
  if (!items.length) items.push(info(`No saved or recent requests match “${oneLine(q, 40)}”`, "Type a URL to send a request, like example.com", "info"), ...hintRows().slice(0, 1));
  return { items };
}

function statusRow(s) {
  const [code, name, text, source] = s;
  const url = statusURL(code);
  const cls = CLASS_NAME[Math.floor(code / 100)];
  const sub = `${text}${source ? ` · Unofficial (${source})` : ""}`;
  const item = {
    title: `${code} ${name}`, subtitle: sub, icon: statusIcon(code), uid: `status-${code}`,
    text: { copy: `${code} ${name}`, largetype: `${code} ${name}\n${cls}${source ? ` · unofficial, ${source}` : ""}\n\n${text}` },
  };
  if (url) Object.assign(item, { arg: url, variables: { http_action: "open" }, quicklookurl: url, subtitle: `${sub} · ↩ MDN` });
  else Object.assign(item, { arg: `${code} ${name}`, variables: { http_action: "copy" }, subtitle: `${sub} · ↩ Copy` });
  return withMods(item, { cmd: pasteMod(`${code} ${name}`, "⌘↩ Paste the code and its name") });
}
function statusView(q) {
  const qq = q.toLowerCase();
  if (/^[1-5]xx$/.test(qq)) {
    const c = Number(qq[0]);
    return { items: STATUS.filter((s) => Math.floor(s[0] / 100) === c).sort((a, b) => a[0] - b[0]).map(statusRow) };
  }
  const exact = STATUS_BY_CODE.get(Number(q));
  const rows = STATUS.filter((s) => String(s[0]).startsWith(q) && s[0] !== Number(q)).sort((a, b) => a[0] - b[0]);
  const items = (exact ? [exact] : []).concat(q.length === 3 ? [] : rows).map(statusRow);
  if (!items.length) {
    const cls = CLASS_NAME[Number(q[0])];
    items.push(info(`${q} isn’t a known status code`, cls && q.length === 3 ? `${q[0]}xx codes mean: ${cls.toLowerCase()}` : "Status codes run from 100 to 599", "status"));
  }
  return { items };
}

function requestView(req, line) {
  return { items: [requestRow(req, { kind: "line", line }), ...detailRows(req)] };
}

// The review step before a POST, PUT, PATCH or DELETE: "!<typed request>", "!hist:<id>", "!saved:<name>",
// "!req:<id>" or "!clip" (the clipboard, read again: what is shown is what is sent)
function confirmView(what) {
  let req = null, ref = null, back = "";
  try {
    if (/^(hist|saved|req|resp):/.test(what)) req = loadRef((ref = what));
    else if (what === "clip") {
      const clip = clipboardText().trim();
      req = /^curl(\.exe)?\s/i.test(clip) ? parseCurl(clip) : /^https?:\/\/\S+$/i.test(clip) ? parseLine(clip) : null;
    } else {
      req = parseLine(what);
      back = what;
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { items: [info(e.message, "Nothing was sent", "error", { autocomplete: what })] };
  }
  if (!req) return { items: [info("This request is no longer available", "Nothing was sent", "error", { autocomplete: "" })] };
  const row = requestRow(req, { ref, confirmed: true, kind: "confirm", notes: [], title: `Send ${req.method} ${displayURL(req.url)}` });
  row.subtitle = `↩ Send now: this can change data on ${hostOf(req.url)}${requestSummary(req) ? " · " + requestSummary(req) : ""}`;
  row.icon = icon("send");
  const cancel = info("Cancel", "Nothing was sent", "cancel", { autocomplete: back });
  return { items: [row, cancel, ...detailRows(req)] };
}

function saveView(rest) {
  const toks = lineTokens(rest);
  if (!toks.length) return { items: [info("Type a name for the request", "Then pick the request to save: http save <name>", "saved")] };
  const name = toks[0].text;
  if (!validName(name)) return { items: [info("Names can be 1–60 characters", "", "error")] };
  const exists_ = loadSaved().some((e) => e.name.toLowerCase() === name.toLowerCase());
  const replace = exists_ ? ` (replaces the saved “${name}”)` : "";
  const items = [];
  const after = rest.slice(toks[0].end).trim();
  if (after) {
    try {
      const req = parseLine(after);
      items.push(withMods({ title: `Save “${name}”: ${req.method} ${displayURL(req.url)}`, subtitle: `↩ Save${replace}`, arg: name, icon: icon("saved"), variables: Object.assign({ http_action: "save", http_name: name }, reqVars(req)) }));
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      items.push(info(e.message, "Type a request after the name, or pick a recent one below", "error"));
    }
  }
  for (const e of loadHistory().slice(0, 20)) {
    items.push(withMods({ title: `Save “${name}”: ${e.req.method} ${displayURL(e.req.url)}`, subtitle: `Sent ${fmtAgo(now() - e.t)} · ↩ Save${replace}`, arg: name, icon: methodIcon(e.req.method), variables: { http_action: "save", http_name: name, http_ref: `hist:${e.id}` } }));
  }
  if (!items.length) items.push(info("Send a request first", `Or type one after the name: save ${name} get example.com`, "info"));
  return { items };
}

function clearView() {
  const n = loadHistory().length;
  let size = 0;
  for (const d of listDir(respRoot())) for (const f of listDir(`${respRoot()}/${d}`)) size += fileSize(`${respRoot()}/${d}/${f}`);
  return {
    items: [
      withMods({ title: "Clear the request history", subtitle: `${plural(n, "request")} · saved requests stay`, arg: "history", icon: icon("trash"), variables: { http_action: "clear" } }),
      withMods({ title: "Clear cached responses", subtitle: fmtBytes(size), arg: "cache", icon: icon("trash"), variables: { http_action: "clearcache" } }),
    ],
  };
}

function timingText(m) {
  const t = m.timing;
  if (!t) return "";
  const parts = [`DNS ${fmtMs(t.dns)}`, `Connect ${fmtMs(t.connect)}`];
  if (t.tls > 0) parts.push(`TLS ${fmtMs(t.tls)}`);
  parts.push(`TTFB ${fmtMs(t.ttfb)}`, `Total ${fmtMs(t.total)}`);
  return parts.join(" · ");
}
function responseText(m) {
  const out = [];
  out.push(m.status ? `${m.status} ${m.reason || statusName(m.status)}` : m.error ? m.error.message : "No response");
  out.push(`${m.method} ${maskURL(m.url)}`);
  if (m.timing) out.push(timingText(m));
  if (m.size !== undefined) out.push(`${fmtBytes(m.size)}${m.truncated ? " (stopped at the size limit)" : ""}`);
  if (m.headers.length) out.push("", ...m.headers.map(([k, v]) => `${k}: ${maskHeader(k, v)}`));
  if (m.previewText) out.push("", m.previewText.slice(0, 2000));
  return out.join("\n").slice(0, 4000);
}

function responseView(rid) {
  const st = respState(rid);
  const hist = loadHistory().find((e) => e.id === rid);
  const req = cleanRequest(readJSON(`${respDir(rid)}/request.json`, null)) || (hist && hist.req);
  const again = (title) => {
    if (!req) return null;
    return requestRow(req, { ref: hist ? `hist:${rid}` : `resp:${rid}`, title, kind: "again", notes: [] });
  };
  if (st.state === "missing") {
    return { items: [info("This response is no longer cached", "Send the request again", "info"), again(null)].filter(Boolean) };
  }
  if (st.state === "running") {
    const secs = Math.max(0, Date.now() / 1000 - st.started);
    return {
      rerun: 0.3,
      items: [withMods({ title: `Sending ${req ? `${req.method} ${displayURL(req.url)}` : "the request"}…`, subtitle: `Waiting ${secs.toFixed(1)} s · ↩ Cancel`, arg: rid, icon: icon("clock"), variables: { http_action: "cancel" } })],
    };
  }
  if (st.state === "dead") return { items: [info("Couldn’t send the request: it stopped unexpectedly", "Send it again", "error"), again(null)].filter(Boolean) };
  const m = st.meta;
  m.headers = Array.isArray(m.headers) ? m.headers.filter((h) => Array.isArray(h) && h.length === 2) : [];
  const items = [];
  const disp = `${m.method} ${displayURL(m.url)}`;
  const mime = (m.contentType || "").split(";")[0].trim();
  const isText = ["json", "html", "xml", "text"].includes(m.kind);
  const bodyArg = m.previewFile && isText ? `httpfile:${m.previewFile}` : "";
  // 1. status
  if (!m.status) {
    const e = m.error || { message: "No response" };
    items.push(info(e.message, `${disp}${e.detail && e.detail !== e.message ? ` · ${oneLine(e.detail, 100)}` : ""}`, e.code === 6 || e.code === 7 ? "offline" : "error", { text: { copy: e.detail || e.message, largetype: responseText(m) } }));
  } else {
    const title = `${m.status} ${m.reason || statusName(m.status)} · ${m.timing ? fmtMs(m.timing.total) : "–"} · ${fmtBytes(m.size || 0)}${m.truncated ? " (stopped)" : ""}`;
    const sub = [disp, mime, m.error ? m.error.message : "", isText ? "↩ Copy the body" : m.kind === "image" || m.kind === "pdf" ? "↩ Open" : m.bodyFile ? "↩ Show in Finder" : ""].filter(Boolean).join(" · ");
    const item = { title, subtitle: sub, icon: statusIcon(m.status), text: { copy: `${m.status} ${m.reason || statusName(m.status)}`, largetype: responseText(m) } };
    if (m.previewFile) item.quicklookurl = m.previewFile;
    const mods = {};
    if (isText) {
      Object.assign(item, { arg: bodyArg, variables: { http_action: "copy" } });
      mods.cmd = { arg: bodyArg, subtitle: "⌘↩ Paste the body into the frontmost app", variables: { http_action: "paste" } };
    } else if (m.bodyFile) Object.assign(item, { arg: m.bodyFile, variables: { http_action: m.kind === "image" || m.kind === "pdf" ? "openfile" : "reveal" } });
    else item.valid = false;
    if (m.method === "GET") mods.alt = { arg: m.url, subtitle: "⌥↩ Open in the browser", variables: { http_action: "open" } };
    items.push(withMods(item, mods));
  }
  if (m.truncated) items.push(info(m.error && m.error.code === 63 && !m.size ? m.error.message : `Stopped at ${fmtBytes(MAX_BYTES)}: the rest wasn’t downloaded`, "Raise the size limit in the Workflow’s Configuration", "info"));
  // 2. body
  if (m.bodyFile && m.previewText) {
    const first = m.previewText.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ");
    const what = { json: "JSON", html: "HTML", xml: "XML", text: "Text", image: "Image", pdf: "PDF", binary: "Binary" }[m.kind] || "Body";
    const bits = [what];
    if (m.lines) bits.push(plural(m.lines, "line"));
    if (m.encoding && m.encoding !== "UTF-8") bits.push(`decoded from ${m.encoding}`);
    if (m.truncatedPreview) bits.push("large: previewed as is");
    bits.push(isText ? "↩ Copy · ⌘Y Quick Look · ⌘L Large Type" : "⌘Y Quick Look");
    const item = { title: oneLine(isText ? maskBody(first) : m.previewText, 200) || "(empty)", subtitle: bits.join(" · "), icon: icon(m.kind === "image" ? "image" : "body"), quicklookurl: m.previewFile, text: { copy: isText ? m.previewText : m.bodyFile, largetype: m.previewText.slice(0, 4000) } };
    if (isText) {
      Object.assign(item, { arg: bodyArg, variables: { http_action: "copy" } });
      items.push(withMods(item, { cmd: { arg: bodyArg, subtitle: "⌘↩ Paste the body", variables: { http_action: "paste" } } }));
    } else items.push(withMods(Object.assign(item, { arg: m.bodyFile, variables: { http_action: m.kind === "binary" ? "reveal" : "openfile" } })));
  }
  // 3. timing and redirects
  if (m.timing) {
    const t = timingText(m);
    items.push(copyItem(t, ["Timing", m.remoteIP, m.httpVersion ? `HTTP/${m.httpVersion}` : ""].filter(Boolean).join(" · "), t, "clock"));
  }
  if (Array.isArray(m.redirects) && m.redirects.length) {
    const chain = m.redirects.map((r) => r.status).concat([m.status]).join(" → ");
    items.push(copyItem(oneLine(`Redirected ${m.redirects.length}×: ${displayURL(m.effectiveURL || m.url)}`, 200), `${chain} · ↩ Copy the final URL`, m.effectiveURL || m.url, "s3xx"));
  }
  // 4. headers
  if (m.headers.length) {
    const all = m.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
    items.push(copyItem(`Headers (${m.headers.length})`, oneLine(m.headers.slice(0, 4).map(([k]) => k).join(", "), 100) + " · ↩ Copy all", all, "header", { text: { copy: all, largetype: m.headers.map(([k, v]) => `${k}: ${maskHeader(k, v)}`).join("\n").slice(0, 4000) } }));
    for (const [k, v] of m.headers.slice(0, 40)) items.push(copyItem(oneLine(`${k}: ${maskHeader(k, v)}`, 200), "Response header · ↩ Copy the value", v, "header", { text: { copy: v, largetype: `${k}: ${maskHeader(k, v)}` } }));
  }
  // 5. again, save, convert
  if (req) {
    items.push(again(`Send again: ${req.method} ${displayURL(req.url)}`));
    items.push(info("Save this request…", "↩ Type a name for it", "saved", { autocomplete: "save " }));
    items.push(...converterRows(req));
  }
  return { items };
}

// Rows need a uid for Alfred to keep the selected row while the Script Filter reruns
function stableUids(items) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return items;
}

function looksLikeRequest(q) {
  const first = q.split(/\s+/)[0];
  return METHODS.includes(first.toUpperCase()) || /[./:]/.test(first);
}

function filter(query) {
  const q = String(query).replace(/^\s+|\s+$/g, "");
  if (q === "") return homeView();
  let m;
  if ((m = /^!\s*([\s\S]+)$/.exec(q))) return confirmView(m[1].trim());
  if ((m = /^=([a-z0-9-]{11,25})$/.exec(q)) && RID_RE.test(m[1])) return responseView(m[1]);
  if ((m = /^save(?:\s+([\s\S]*))?$/i.exec(q))) return saveView(m[1] || "");
  if (/^clear$/i.test(q)) return clearView();
  if (/^(\d{1,3}|[1-5]xx)$/i.test(q)) return statusView(q);
  try {
    return requestView(parseLine(q), q);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    if (/^curl(\.exe)?(\s|$)/i.test(q)) return { items: [info(`Couldn’t read the curl command: ${e.message}`, "Nothing was sent", "error")] };
    return searchView(q, looksLikeRequest(q) ? e : null);
  }
}

// ---------- actions ----------

function testMode() {
  return env("HTTP_TEST_NOOPEN", "0") !== "0"; // test suite only: never open apps or Alfred
}
function alfredSearch(text) {
  if (testMode()) return;
  exec("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application id "com.runningwithcrayons.Alfred" to search (item 1 of argv)', "-e", "end run", text]);
}

function startSend(req) {
  const rid = newRid();
  const dir = mkdirs(respDir(rid), true);
  writeFile(`${dir}/request.json`, JSON.stringify(req));
  addHistory(rid, req);
  prune();
  if (env("HTTP_SYNC", "0") === "1") {
    sendNow(rid, false); // test suite: send in this process
    return rid;
  }
  const script = `${FM.currentDirectoryPath.js}/http.js`;
  if (!exists(script) || !spawn("/usr/bin/osascript", ["-l", "JavaScript", script, "send", rid])) {
    writeFile(`${dir}/meta.json`, JSON.stringify({ rid, t: now(), method: req.method, url: req.url, status: 0, headers: [], error: { code: -1, message: "Couldn’t start sending the request" } }));
  }
  return rid;
}

function cancel(rid) {
  if (!RID_RE.test(rid)) return "";
  const dir = respDir(rid);
  if (exists(`${dir}/meta.json`)) return "";
  for (const f of ["pid", "curlpid"]) { // the sender first, so it can't write a result after ours
    const pid = Number(readFile(`${dir}/${f}`));
    if (!alive(pid)) continue;
    // make sure the pid still belongs to this request before stopping it
    const cmd = exec("/bin/ps", ["-o", "command=", "-p", String(pid)]).stdout;
    if ((f === "pid" && cmd.includes("http.js") && cmd.includes(rid)) || (f === "curlpid" && /\/usr\/bin\/curl\b/.test(cmd))) $.kill(pid, 15);
  }
  const req = cleanRequest(readJSON(`${dir}/request.json`, null)) || { method: "", url: "" };
  const meta = { rid, t: now(), method: req.method, url: req.url, status: 0, headers: [], error: { code: -3, message: "Cancelled" } };
  writeFile(`${dir}/meta.json`, JSON.stringify(meta));
  removeFile(`${dir}/pid`);
  updateHistory(rid, meta);
  return "Cancelled the request";
}

function inCache(path, re) {
  const root = `${cacheDir()}/`;
  return path.startsWith(root) && re.test(path.slice(root.length)) && exists(path);
}

function act(arg) {
  const action = env("http_action", "");
  const report = env("HTTP_TEST_NOOPEN", "0") === "1";
  switch (action) {
    case "send": {
      const req = requestFromEnv(arg);
      if (!req) return "Couldn’t send the request: it’s no longer available";
      const rid = startSend(req);
      alfredSearch(`${keyword()} =${rid}`);
      return report ? `sent ${rid}` : "";
    }
    case "show": // the last response of a history entry
      if (!RID_RE.test(arg)) return "";
      alfredSearch(`${keyword()} =${arg}`);
      return report ? `show ${arg}` : "";
    case "copy":
    case "paste":
      setClipboard(resolveText(arg));
      return "";
    case "open": {
      if (!/^https?:\/\/[^\s]+$/i.test(arg)) return "";
      const url = $.NSURL.URLWithString(arg);
      if (url.isNil()) return "";
      if (!testMode()) $.NSWorkspace.sharedWorkspace.openURL(url);
      return report ? `open ${arg}` : "";
    }
    case "openfile":
    case "reveal": {
      // only a body this workflow downloaded; HTML and other types are revealed, never opened
      if (!inCache(arg, /^resp\/[a-z0-9]{6,16}-[a-z0-9]{4,8}\/body\.[a-z]{2,5}$/)) return "";
      const open = action === "openfile" && /\.(png|jpg|gif|webp|heic|bmp|tiff|ico|avif|pdf)$/.test(arg);
      if (!testMode()) {
        if (open) $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(arg));
        else $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($([$.NSURL.fileURLWithPath(arg)]));
      }
      return report ? `${open ? "open" : "reveal"} ${arg}` : "";
    }
    case "cancel":
      return cancel(arg);
    case "save": {
      const name = env("http_name", arg).trim();
      if (!validName(name)) return "Couldn’t save the request: names can be 1–60 characters";
      const req = requestFromEnv("");
      if (!req) return "Couldn’t save the request: it’s no longer available";
      return saveNamed(name, req) ? `Saved “${name}”` : `Couldn’t save the request: there are already ${SAVED_MAX} saved requests`;
    }
    case "unsave": {
      const name = env("http_name", arg);
      return removeNamed(name) ? `Deleted “${name}”` : `Couldn’t delete “${name}”: it isn’t saved`;
    }
    case "forget": {
      if (!RID_RE.test(arg)) return "";
      withLock(historyLock(), () => saveHistory(loadHistory().filter((e) => e.id !== arg)));
      return "Removed from the history";
    }
    case "clear":
      withLock(historyLock(), () => saveHistory([]));
      return "Cleared the request history";
    case "clearcache":
      for (const d of ["resp", "req", "out"]) removeFile(`${cacheDir()}/${d}`);
      return "Cleared cached responses";
  }
  return "";
}

// Alfred rejects the whole JSON when a string holds an unpaired surrogate. Bidi overrides and
// control characters (from response headers or bodies) are removed from display text; newlines stay
// (Large Type, copy text). Args are ids, URLs and file paths, which never hold them.
function wellFormed(k, v) {
  if (typeof v !== "string") return v;
  v = v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\ufffd"));
  if (k === "arg" || k === "copy" || k === "autocomplete") return v; // copied and typed text stays exact
  return v.replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]+/g, " ");
}

function readStdin() {
  const d = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js || "";
}

function run(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "filter": {
        // the query comes in http_query (see workflow.json) or, for tests, as arguments
        const res = filter(rest.length ? rest.join(" ") : env("http_query", ""));
        res.items = stableUids((res.items || []).filter(Boolean));
        return JSON.stringify(Object.assign({ skipknowledge: true }, res), wellFormed);
      }
      case "act": // "" would still print a newline, and Alfred's notification would show up empty
        return act(rest.join(" ")) || undefined;
      case "send":
        sendNow(rest[0] || "", true);
        return undefined;
      case "tokenize": // test suite: [command…] → [{words, notes} | {error}]
      case "parse": // test suite: [line…] → [request | {error}]
      case "convert": {
        const inputs = JSON.parse(readStdin());
        return JSON.stringify(inputs.map((s) => {
          try {
            if (cmd === "tokenize") return curlWords(s);
            const req = parseLine(s);
            if (cmd === "parse") return req;
            return Object.fromEntries(CONVERTERS.map(([id, , fn]) => [id, fn(req)]));
          } catch (e) {
            if (e instanceof ParseError) return { error: e.message };
            return { crash: String(e && e.stack ? `${e.message} ${e.stack}` : e) };
          }
        }));
      }
      case "pretty":
        return prettyJSON(readStdin());
    }
    return undefined;
  } catch (e) {
    if (cmd !== "filter") return `Error: ${e.message}`;
    return JSON.stringify({ items: [info("Something went wrong", oneLine(e.message, 200), "error")] }, wellFormed);
  }
}
