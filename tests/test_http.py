#!/usr/bin/env python3
"""End-to-end tests: run the Script Filter and actions the way Alfred does (the scripts from
info.plist, run by /bin/bash with the query as $1), against a local mock HTTP server. Nothing
here touches the real network, the real clipboard or the user's Alfred."""
import base64, gzip, json, os, plistlib, random, re, shlex, shutil, signal, socket, string, struct, subprocess
import sys, tempfile, threading, time, unittest, zlib
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py")], check=True, capture_output=True)
with open(os.path.join(SRC, "info.plist"), "rb") as f:
    PLIST = plistlib.load(f)


def script_of(obj_type, contains):
    for o in PLIST["objects"]:
        if o["type"] == obj_type and contains in o["config"].get("script", ""):
            return o["config"]["script"]
    raise AssertionError(f"no {obj_type} with {contains}")


SF_SCRIPT = script_of("alfred.workflow.input.scriptfilter", "filter")
ACT_SCRIPT = script_of("alfred.workflow.action.script", "act")
RESOLVE_SCRIPT = script_of("alfred.workflow.action.script", "resolve.sh")


def png_1x1():
    raw = b"\x00\xff\x00\x00"
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG = png_1x1()
BIGNUM = b'{"n": 12345678901234567890, "f": 1.0, "e": {}, "a": [], "s": "x\\"y"}'


class Mock(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests = []

    def log_message(self, *a):
        pass

    def send(self, status, body=b"", ctype="application/json", headers=()):
        self.send_response(status)
        if ctype:
            self.send_header("Content-Type", ctype)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def chunked(self, parts, ctype="text/plain", delay=0.0, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            for p in parts:
                self.wfile.write(b"%x\r\n%s\r\n" % (len(p), p))
                self.wfile.flush()
                if delay:
                    time.sleep(delay)
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_any(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        Mock.requests.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
        p = u.path
        if p.startswith("/anything") or p == "/":
            echo = {"method": self.command, "path": p, "query": q, "headers": dict(self.headers),
                    "body": body.decode("utf-8", "replace")}
            return self.send(200, json.dumps(echo).encode())
        m = re.match(r"^/status/(\d{3})$", p)
        if m:
            code = int(m.group(1))
            return self.send(code, b"" if code in (204, 304) else json.dumps({"status": code}).encode(),
                             None if code in (204, 304) else "application/json")
        m = re.match(r"^/redirect/(\d+)$", p)
        if m:
            k = int(m.group(1))
            return self.send(302, b"", "text/plain", [("Location", f"/redirect/{k - 1}" if k > 1 else "/anything")])
        if p == "/redirect-to":
            return self.send(int(q.get("status", "302")), b"", "text/plain", [("Location", q["url"])])
        if p == "/gzip":
            data = gzip.compress(json.dumps({"gzipped": True}).encode())
            return self.send(200, data, "application/json", [("Content-Encoding", "gzip")])
        if p == "/chunked":
            return self.chunked([b"one,", b"two,", b"three"], delay=0.05)
        m = re.match(r"^/bytes/(\d+)$", p)
        if m:
            return self.send(200, b"a" * int(m.group(1)), "text/plain")
        m = re.match(r"^/stream-bytes/(\d+)$", p)
        if m:
            total = int(m.group(1))
            parts = [b"b" * min(65536, total - i) for i in range(0, total, 65536)]
            return self.chunked(parts)
        if p == "/image.png":
            return self.send(200, PNG, "image/png")
        if p == "/image-untyped":
            return self.send(200, PNG, None)
        if p == "/binary":
            return self.send(200, bytes(range(256)) * 4, "application/octet-stream")
        if p == "/latin1":
            return self.send(200, "<p>café naïve</p>".encode("latin-1"), "text/html; charset=ISO-8859-1")
        if p == "/latin1-nocharset":
            return self.send(200, "crème brûlée".encode("latin-1"), None)
        if p == "/sjis":
            return self.send(200, "こんにちは".encode("shift_jis"), "text/plain; charset=Shift_JIS")
        if p == "/utf8-nocharset":
            return self.send(200, "naïve ✓".encode(), None)
        if p == "/json-untyped":
            return self.send(200, b'{"a":[1,2]}', None)
        if p == "/slow":
            time.sleep(float(q.get("s", "3")))
            return self.send(200, b'{"slow": true}')
        if p == "/slow-body":
            return self.chunked([b"x" * 10] * 50, delay=0.02)
        if p == "/bignum":
            return self.send(200, BIGNUM)
        if p == "/cookies":
            return self.send(200, b"{}", "application/json", [("Set-Cookie", "session=abc123secret; Path=/; HttpOnly")])
        if p == "/html":
            return self.send(200, b"<!doctype html><title>Hi</title><h1>Hello</h1>", "text/html; charset=utf-8")
        if p == "/evil-html":
            t = BASE + "/track"
            page = (f'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "{t}/dtd"><html><head>'
                    f'<link rel="stylesheet" href="{t}/css"><base href="{t}/"><meta http-equiv="refresh" content="0;url={t}/r">'
                    f'<style>@import url({t}/import);</style><script src="{t}/js"></script></head>'
                    f'<body background="{t}/bg" style="background:url({t}/inline)"><h1 onclick="x()">Hello &amp; <i>world</i></h1>'
                    f'<img src="{t}/img" alt="logo"><img srcset="{t}/srcset 2x"><svg><image href="{t}/svg"/></svg>'
                    f'<iframe src="{t}/frame"></iframe><object data="{t}/obj"></object><video poster="{t}/poster"></video>'
                    f'<a href="{t}/link">link</a><table><tr><td colspan="2">cell</td></tr></table></body></html>')
            return self.send(200, page.encode(), "text/html; charset=utf-8")
        if p == "/svg":
            svg = f'<svg xmlns="http://www.w3.org/2000/svg"><image href="{BASE}/track/svg"/><script>1</script></svg>'
            return self.send(200, svg.encode(), "image/svg+xml")
        if p == "/empty":
            return self.send(200, b"", "text/plain")
        if p == "/proto":
            return self.send(200, b"hello", "constructor")
        if p == "/bidi":
            return self.send(200, "{\"x\": \"a\u202eb\"}".encode(), "application/json", [("X-Evil", "a\u202eb".encode().decode("latin-1"))])
        return self.send(404, b'{"error": "not found"}')

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = do_PURGE = handle_any


ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer.handle_error = lambda self, request, address: None  # curl hangs up on purpose (size limit, cancel)
SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{SERVER.server_port}"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def readf(path, mode="r"):
    with open(path, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        return f.read()


def validate(data):
    assert isinstance(data.get("items"), list), data
    uids = set()
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert "\n" not in it["title"] and "\n" not in it.get("subtitle", ""), it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        assert "uid" in it and it["uid"] not in uids, it
        uids.add(it["uid"])
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m
            if m.get("valid") is not False and it.get("variables"):
                assert "variables" in m, (it, m)


def find(items, prefix):
    for i in items:
        if i["title"].startswith(prefix):
            return i
    raise AssertionError(f"no item starting with {prefix!r}: {[i['title'] for i in items]}")


def titles(items):
    return [i["title"] for i in items]


class Env:
    """A fresh cache and data folder per test, with spaces in the paths like Alfred's."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="http-test-")
        self.cache = os.path.join(self.dir, "Caches", "com.runningwithcrayons.Alfred", "Workflow Data", "io.github.x-o-r-r-o.http")
        self.data = os.path.join(self.dir, "Application Support", "Alfred", "Workflow Data", "io.github.x-o-r-r-o.http")
        self.clip_out = os.path.join(self.dir, "clipboard-out.txt")
        self.keychain = os.path.join(self.dir, "Keychain stand-in")

    def vars(self, **extra):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("http_", "HTTP_"))}
        e.update(alfred_workflow_cache=self.cache, alfred_workflow_data=self.data,
                 alfred_workflow_bundleid="io.github.x-o-r-r-o.http", alfred_workflow_version="1.0.0",
                 HTTP_TEST_CLIPBOARD="", HTTP_TEST_CLIPBOARD_OUT=self.clip_out, HTTP_TEST_NOOPEN="1",
                 HTTP_TEST_KEYCHAIN=self.keychain,
                 HTTP_SYNC="1", timeout="5")
        e.update({k: str(v) for k, v in extra.items()})
        return e

    def sf(self, query="", **extra):
        out = subprocess.run(["/bin/bash", "-c", SF_SCRIPT, "bash", query], cwd=SRC, env=self.vars(**extra),
                             capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        data = json.loads(out.stdout)
        validate(data)
        return data

    def items(self, query="", **extra):
        return self.sf(query, **extra)["items"]

    def act(self, item_or_mod, **extra):
        """Run the action for a row (or one of its mods) with its arg and variables, as Alfred would."""
        v = dict(item_or_mod.get("variables") or {})
        v.update(extra)
        out = subprocess.run(["/bin/bash", "-c", ACT_SCRIPT, "bash", item_or_mod["arg"]], cwd=SRC,
                             env=self.vars(**v), capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    def send(self, query, **extra):
        """Type a request, press ↩ (and ↩ again on the confirmation), return the response view."""
        items = self.items(query, **extra)
        row = items[0]
        if row.get("valid") is False and row.get("autocomplete", "").startswith("!"):
            row = self.items(row["autocomplete"], **extra)[0]
        out = self.act(row, **extra)
        m = re.match(r"^sent ([a-z0-9-]+)$", out)
        assert m, out
        return m.group(1), self.items("=" + m.group(1), **extra)

    def meta(self, rid):
        with open(os.path.join(self.cache, "resp", rid, "meta.json")) as f:
            return json.load(f)

    def clipboard(self):
        with open(self.clip_out, encoding="utf-8") as f:
            return f.read()

    def history(self):
        p = os.path.join(self.data, "history.json")
        return json.loads(readf(p))["items"] if os.path.exists(p) else []


def keychain_dump(env):
    """Everything in the test stand-in for the Keychain."""
    if not os.path.isdir(env.keychain):
        return ""
    return "".join(readf(os.path.join(env.keychain, f)) for f in sorted(os.listdir(env.keychain)))


def all_args(items):
    """Every arg Alfred would pass to the next object (a process argument, visible in ps)."""
    out = []
    for i in items:
        out.append(i.get("arg", ""))
        out.extend(m.get("arg", "") for m in (i.get("mods") or {}).values())
    return json.dumps(out, ensure_ascii=False)


def js(cmd, inputs):
    out = subprocess.run(["osascript", "-l", "JavaScript", "./http.js", cmd], cwd=SRC, input=json.dumps(inputs),
                         capture_output=True, text=True, timeout=120,
                         env=dict(os.environ, alfred_workflow_cache=tempfile.mkdtemp(prefix="http-js-")))
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def parse(lines):
    return js("parse", lines)


class Base(unittest.TestCase):
    def setUp(self):
        Mock.requests = []
        self.env = Env()

    def tearDown(self):
        shutil.rmtree(self.env.dir, ignore_errors=True)


# ---------------------------------------------------------------------------------------------
class RequestLineTests(unittest.TestCase):
    def test_methods_urls_and_items(self):
        r = parse([
            "get api.github.com/users/octocat",
            "api.github.com",
            "localhost:3000/x",
            ":8080/health",
            "POST httpbin.org/post name=Ada age:=36 admin:=true",
            "post httpbin.org/post {\"a\": 1, \"b\": [1, 2]}",
            "https://example.com/a  H:Authorization=Bearer x",
            "example.com Accept:text/html q==hello%20world page==2",
            "put example.com/x -f name=Ada 'city=New York'",
            "delete example.com/items/1",
            "example.com -u user:pa:ss",
            "example.com -d a=1&b=2",
            "PURGE example.com/cache",
            "example.com/ünïcode path?q=a b",
            "192.168.1.10/api",
            "example.com H:X-Token=abc== H:Y=1",
            "[::1]:8080/x",
        ])
        self.assertEqual((r[0]["method"], r[0]["url"]), ("GET", "https://api.github.com/users/octocat"))
        self.assertEqual(r[1]["url"], "https://api.github.com")
        self.assertEqual(r[2]["url"], "http://localhost:3000/x")
        self.assertEqual(r[3]["url"], "http://localhost:8080/health")
        self.assertEqual(r[4]["method"], "POST")
        self.assertEqual(json.loads(r[4]["body"]["text"]), {"name": "Ada", "age": 36, "admin": True})
        self.assertIn(["Content-Type", "application/json"], r[4]["headers"])
        self.assertEqual(r[5]["body"], {"kind": "json", "text": "{\"a\": 1, \"b\": [1, 2]}"})
        self.assertEqual(r[5]["method"], "POST")
        self.assertEqual(r[6]["headers"], [["Authorization", "Bearer x"]])
        self.assertEqual(r[7]["url"], "https://example.com?q=hello%2520world&page=2")
        self.assertEqual(r[7]["headers"], [["Accept", "text/html"]])
        self.assertEqual(r[8]["body"], {"kind": "form", "text": "name=Ada&city=New%20York"})
        self.assertEqual(r[8]["method"], "PUT")
        self.assertEqual(r[9]["method"], "DELETE")
        self.assertEqual(r[10]["auth"], "user:pa:ss")
        self.assertEqual(r[11]["body"]["kind"], "form")
        self.assertEqual(r[11]["body"]["text"], "a=1&b=2")
        self.assertEqual(r[12]["method"], "PURGE")
        self.assertEqual(r[13]["url"], "https://example.com/%C3%BCn%C3%AFcode")  # the space ends the URL
        self.assertEqual(r[14]["url"], "http://192.168.1.10/api")
        self.assertEqual(r[15]["headers"], [["X-Token", "abc=="], ["Y", "1"]])
        self.assertEqual(r[16]["url"], "http://[::1]:8080/x")

    def test_errors(self):
        r = parse(["file:///etc/passwd", "ftp://example.com", "get", "notaurl", "example.com oops",
                   "example.com a:=notjson", "example.com a=1 {\"b\":2}", "example.com -H 'X: a\nb'", "example.com:99999",
                   "javascript:alert(1)"])
        for x in r:
            self.assertIn("error", x, x)
        self.assertIn("http://", r[0]["error"])
        self.assertIn("quote values", r[4]["error"])

    def test_invalid_json_body_is_a_note(self):
        r = parse(["post example.com {\"a\": }"])[0]
        self.assertTrue(any("isn’t valid JSON" in n for n in r["notes"]), r)


class CurlParserTests(unittest.TestCase):
    CHROME_BASH = r"""curl 'https://api.example.com/v1/items?id=5' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'accept-language: en-US,en;q=0.9' \
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret' \
  -H 'content-type: application/json' \
  -b 'sid=s3cr3t; theme=dark' \
  -H 'accept-encoding: gzip, deflate, br, zstd' \
  --data-raw $'{"name":"O\'Brien","note":"line1\\nline2","emoji":"\u2713"}'"""

    CHROME_CMD = r"""curl ^"https://api.example.com/v1/items?id=5^&x=1^" ^
  -H ^"accept: application/json^" ^
  -H ^"content-type: application/json^" ^
  --data-raw ^"^{^\^"name^\^":^\^"Ada^\^"^}^" """

    FIREFOX = """curl 'https://example.com/api' -X POST -H 'User-Agent: Mozilla/5.0' -H 'Content-Type: application/x-www-form-urlencoded' --data-raw 'a=1&b=two'"""

    def test_browser_commands(self):
        r = parse([self.CHROME_BASH, self.CHROME_CMD, self.FIREFOX])
        a = r[0]
        self.assertEqual(a["method"], "POST")
        self.assertEqual(a["url"], "https://api.example.com/v1/items?id=5")
        self.assertEqual(json.loads(a["body"]["text"]), {"name": "O'Brien", "note": "line1\nline2", "emoji": "✓"})
        self.assertIn(["Cookie", "sid=s3cr3t; theme=dark"], a["headers"])
        self.assertFalse(any(k.lower() == "accept-encoding" for k, v in a["headers"]))
        self.assertEqual(r[1]["url"], "https://api.example.com/v1/items?id=5&x=1")
        self.assertEqual(r[1]["body"]["text"], '{"name":"Ada"}')
        self.assertEqual(r[2]["method"], "POST")
        self.assertEqual(r[2]["body"], {"kind": "form", "text": "a=1&b=two"})

    def test_options(self):
        r = parse([
            "curl -X PUT https://e.com -H 'X-A: 1' -d 'x' -d 'y'",
            "curl -sSL -XDELETE https://e.com/1",
            "curl -I https://e.com",
            "curl -G https://e.com -d q=1 --data-urlencode 'name=a b'",
            "curl https://e.com -u user:pass -k",
            "curl https://e.com --json '{\"a\":1}'",
            "curl https://e.com -F 'name=Ada' --form-string 'x=@notafile'",
            "curl https://e.com -A 'Agent/1' -e https://ref.example --oauth2-bearer tok",
            "curl example.com",
            "curl https://e.com -H 'X-Empty;' -H 'X-Removed:'",
            "curl --url https://e.com/a https://e.com/b",
            "curl https://e.com -o out.json -w '%{http_code}' --max-time 5 --compressed",
            "curl https://e.com | jq .",
            "curl https://e.com && rm -rf /",
            "curl https://e.com > file.txt 2>&1",
            "curl -H \"Authorization: Bearer $TOKEN\" https://e.com",
            "curl --data-binary 'a\nb' https://e.com",
            "curl -X post https://e.com",
        ])
        self.assertEqual((r[0]["method"], r[0]["body"]["text"]), ("PUT", "x&y"))
        self.assertEqual(r[1]["method"], "DELETE")
        self.assertEqual((r[2]["method"], r[2]["body"]), ("HEAD", None))
        self.assertEqual(r[3]["url"], "https://e.com?q=1&name=a%20b")
        self.assertEqual(r[3]["method"], "GET")
        self.assertEqual((r[4]["auth"], r[4]["insecure"]), ("user:pass", True))
        self.assertIn(["Content-Type", "application/json"], r[5]["headers"])
        self.assertEqual(r[6]["body"], {"kind": "multipart", "text": "", "fields": [["name", "Ada"], ["x", "@notafile"]]})
        self.assertIn(["Authorization", "Bearer tok"], r[7]["headers"])
        self.assertIn(["Referer", "https://ref.example"], r[7]["headers"])
        self.assertEqual(r[8]["url"], "http://example.com")  # curl's default scheme
        self.assertEqual(r[9]["headers"], [["X-Empty", ""]])
        self.assertEqual(r[10]["url"], "https://e.com/a")
        self.assertTrue(any("first URL" in n for n in r[10]["notes"]))
        self.assertEqual(r[11]["method"], "GET")
        for i in (12, 13, 14):
            self.assertEqual(r[i]["url"], "https://e.com")
            self.assertTrue(any("Ignored everything" in n for n in r[i]["notes"]), r[i])
        self.assertEqual(r[15]["headers"], [["Authorization", "Bearer $TOKEN"]])
        self.assertTrue(any("not expanded" in n for n in r[15]["notes"]))
        self.assertEqual(r[16]["body"]["text"], "a\nb")
        self.assertEqual(r[17]["method"], "POST")

    def test_refuses_local_files(self):
        r = parse([
            "curl -d @/etc/passwd https://e.com",
            "curl --data-binary @secret.txt https://e.com",
            "curl -F 'f=@/etc/passwd' https://e.com",
            "curl -F 'f=</etc/passwd' https://e.com",
            "curl -K /tmp/config",
            "curl -T /etc/passwd https://e.com",
            "curl --data-urlencode 'x@/etc/passwd' https://e.com",
            "curl -H @/etc/headers https://e.com",
            "curl --unix-socket /var/run/docker.sock http://localhost/containers",
            "curl file:///etc/passwd",
            "curl --expand-url 'https://{{host}}'",
            "curl",
            "curl -X",
            "curl 'unclosed",
            "wget https://e.com",
        ])
        for x in r:
            self.assertIn("error", x, x)
        self.assertIn("local file", r[0]["error"])


class TokenizerFuzzTests(unittest.TestCase):
    """Random argv → quoted the way shells and browsers quote → the tokenizer gives the argv back."""

    ALPHABET = string.ascii_letters + string.digits + " \t\n'\"\\$`!#&|;<>(){}[]*?~=%@:,./-_^" + "éü✓😀"

    def rand_word(self, rng):
        return "".join(rng.choice(self.ALPHABET) for _ in range(rng.randint(0, 12)))

    @staticmethod
    def ansi_c(s):
        out = []
        for ch in s:
            o = ord(ch)
            if ch == "\\":
                out.append("\\\\")
            elif ch == "'":
                out.append("\\'")
            elif ch == "\n":
                out.append("\\n")
            elif ch == "\t":
                out.append("\\t")
            elif o > 0xFFFF:
                out.append("\\U%08x" % o)
            elif o > 127:
                out.append("\\u%04x" % o)
            else:
                out.append(ch)
        return "$'" + "".join(out) + "'"

    @staticmethod
    def dq(s):
        return '"' + re.sub(r'([\\"$`])', r"\\\1", s) + '"'

    def test_roundtrip(self):
        rng = random.Random(20260928)
        cases, expected = [], []
        for n in range(600):
            argv = ["curl"] + [self.rand_word(rng) for _ in range(rng.randint(0, 6))]
            style = n % 4
            if style == 0:
                cmd = " ".join(shlex.quote(a) for a in argv)
            elif style == 1:
                cmd = " ".join(self.ansi_c(a) for a in argv)
            elif style == 2:
                cmd = " ".join(self.dq(a) for a in argv)
            else:
                cmd = " \\\n  ".join(rng.choice([shlex.quote, self.ansi_c, self.dq])(a) for a in argv)
            cases.append(cmd)
            expected.append(argv)
        got = js("tokenize", cases)
        for cmd, want, g in zip(cases, expected, got):
            self.assertNotIn("crash", g, cmd)
            self.assertNotIn("error", g, cmd)
            self.assertEqual(g["words"], want, cmd)

    def test_garbage_never_crashes(self):
        rng = random.Random(7)
        pieces = ["curl ", "-X ", "-H ", "-d ", "--data-raw ", "-F ", "-u ", "--json ", "'", '"', "$'", "\\", "\\\n",
                  "^", "^\"", "https://e.com", "@", "=", ":", ";", "|", "&", "&&", ">", "`", "$(", "{", "[", "\n", " ",
                  "-", "--", "-sSLk", "--url ", "\\x41", "\\u00e9", "\\U0001F600", "\\777", "\\c", "é", "\x00", "\x7f"]
        cases = []
        for _ in range(800):
            s = "".join(rng.choice(pieces) for _ in range(rng.randint(1, 14)))
            cases.append(s if rng.random() < 0.5 else "curl " + s)
        t0 = time.time()
        got = js("parse", cases)
        self.assertLess(time.time() - t0, 60)
        for c, g in zip(cases, got):
            self.assertNotIn("crash", g, repr(c))
            if "error" not in g:
                self.assertRegex(g["url"], r"^https?://")
                self.assertRegex(g["method"], r"^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$")
                for k, v in g["headers"]:
                    self.assertNotRegex(v, r"[\r\n\x00]")

    def test_curl_options_fuzz(self):
        rng = random.Random(99)
        opts = ["-X POST", "-X PATCH", "-H 'A: b'", "-H 'Authorization: Bearer t'", "-d x=1", "--data-raw '{\"a\":1}'",
                "--json '[1]'", "-F a=b", "-G", "-I", "-L", "-k", "-s", "-u u:p", "-b 'c=d'", "--compressed", "-o /tmp/x",
                "--max-time 3", "-A ua", "--url https://f.com", "-e r", "--http2", "--bogus", "-Z", "-#", "--",
                "--data-urlencode 'a=b c'", "--url-query 'q=1'", "-x proxy:1", "--resolve a:1:2"]
        cases = []
        for _ in range(400):
            parts = ["curl"] + rng.sample(opts, rng.randint(0, 6))
            parts.insert(rng.randint(1, len(parts)), "https://e.com/p")
            cases.append(" ".join(parts))
        for c, g in zip(cases, js("parse", cases)):
            self.assertNotIn("crash", g, c)


class ConverterTests(unittest.TestCase):
    LINES = [
        "get api.github.com/users/octocat",
        "post httpbin.org/post {\"name\": \"O'Brien\", \"n\": 12345678901234567890}",
        "put example.com/x H:Authorization=Bearer abc -f a=1 'b=two words'",
        "delete example.com/items/1 -u user:pa'ss",
        "patch example.com -d 'line1\nline2 $HOME `id`'",
        "head example.com",
        "curl https://e.com -F 'name=Ada' -F 'bio=hi there'",
        "example.com X-Empty: -k",
    ]

    def test_curl_roundtrip(self):
        reqs = parse(self.LINES)
        conv = js("convert", self.LINES)
        back = parse([c["curl"] for c in conv])
        for line, a, b in zip(self.LINES, reqs, back):
            self.assertNotIn("error", b, (line, b))
            for k in ("method", "url", "auth", "insecure"):
                self.assertEqual(a.get(k), b.get(k), (line, k))
            self.assertEqual(a["body"], b["body"], line)
            self.assertEqual(a["headers"], b["headers"], line)

    def test_generated_code_is_valid(self):
        conv = js("convert", self.LINES)
        for line, c in zip(self.LINES, conv):
            compile(c["python"], "<converted>", "exec")
            for k in ("curl", "httpie", "wget"):
                if c.get(k):
                    shlex.split(c[k].replace("\\\n", " "))
            self.assertIn("await fetch(", c["fetch"])
        self.assertIsNone(conv[6]["wget"])  # wget can't send multipart
        self.assertIn("requests.put(", conv[2]["python"])
        self.assertIn("auth=(\"user\", \"pa'ss\")", conv[3]["python"])
        self.assertIn("--raw", conv[1]["httpie"])
        self.assertIn("--method=PATCH", conv[4]["wget"])
        # fetch code is valid JavaScript
        src = json.dumps([c["fetch"] for c in conv])
        out = subprocess.run(["osascript", "-l", "JavaScript", "-e",
                              f"const a = {src}; a.map(c => {{ new Function('return (async () => {{' + c + '}})'); return 1; }}).length"],
                             capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), str(len(conv)), out.stderr)

    def test_python_body_exact(self):
        conv = js("convert", [self.LINES[1]])[0]["python"]
        ns = {}
        exec(conv.split("\n\nresponse")[0].replace("import requests", ""), ns)
        self.assertEqual(ns["data"], "{\"name\": \"O'Brien\", \"n\": 12345678901234567890}".encode())


class PrettyTests(unittest.TestCase):
    def pretty(self, s):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./http.js", "pretty"], cwd=SRC, input=s,
                             capture_output=True, text=True)
        return out.stdout.rstrip("\n")

    def test_literals_kept(self):
        self.assertEqual(self.pretty(BIGNUM.decode()),
                         '{\n  "n": 12345678901234567890,\n  "f": 1.0,\n  "e": {},\n  "a": [],\n  "s": "x\\"y"\n}')
        self.assertEqual(self.pretty('[{"a":[1,{"b":null}]}, "x,y:{"]'),
                         '[\n  {\n    "a": [\n      1,\n      {\n        "b": null\n      }\n    ]\n  },\n  "x,y:{"\n]')


# ---------------------------------------------------------------------------------------------
class FilterTests(Base):
    def test_empty_shows_hints(self):
        items = self.env.items("")
        self.assertEqual(titles(items), ["Type a request", "Paste a curl command", "Look up a status code"])

    def test_request_row_and_converters(self):
        items = self.env.items("get api.github.com/users/octocat")
        row = items[0]
        self.assertEqual(row["title"], "GET api.github.com/users/octocat")
        self.assertEqual(row["arg"], "send")
        self.assertEqual(row["variables"]["http_action"], "send")
        self.assertEqual(json.loads(row["variables"]["http_req"])["url"], "https://api.github.com/users/octocat")
        self.assertEqual(row["mods"]["cmd"]["arg"], "httpvar:")
        self.assertEqual(row["mods"]["cmd"]["variables"]["http_text"], "curl https://api.github.com/users/octocat")
        for name in ("curl", "JavaScript fetch", "Python requests", "HTTPie", "wget"):
            find(items, f"Copy as {name}")

    def test_secrets_masked_in_titles_but_copied_real(self):
        items = self.env.items("get example.com/x?api_key=SECRETKEY H:Authorization=Bearer SECRETTOKEN Cookie:sid=SECRETSID")
        shown = json.dumps([{k: i.get(k) for k in ("title", "subtitle")} for i in items] +
                           [i.get("text", {}).get("largetype") for i in items], ensure_ascii=False)
        self.assertNotIn("SECRET", shown)
        self.assertIn("Bearer •••", shown)
        self.assertIn("sid=•••", shown)
        self.assertIn("api_key=•••", items[0]["title"])
        curl = find(items, "Copy as curl")
        self.assertIn("SECRETTOKEN", curl["variables"]["http_text"])
        self.assertIn("SECRETTOKEN", items[0]["mods"]["cmd"]["variables"]["http_text"])
        self.assertEqual(self.env.act(curl), "")
        self.assertIn("SECRETTOKEN", self.env.clipboard())

    def test_non_get_needs_confirmation(self):
        items = self.env.items('post httpbin.org/post {"a":1}')
        row = items[0]
        self.assertIs(row["valid"], False)
        self.assertEqual(row["autocomplete"], '!post httpbin.org/post {"a":1}')
        self.assertIn("Review before sending", row["subtitle"])
        confirm = self.env.items(row["autocomplete"])
        self.assertEqual(confirm[0]["title"], "Send POST httpbin.org/post")
        self.assertEqual(confirm[0]["variables"]["http_action"], "send")
        self.assertEqual(confirm[1]["title"], "Cancel")
        self.assertEqual(confirm[1]["autocomplete"], 'post httpbin.org/post {"a":1}')
        self.assertEqual(self.env.items("!req:00000000000000")[0]["title"], "This request is no longer available")
        self.assertEqual(self.env.items("!hist:zzzzzzzz-zzzz")[0]["title"], "This request is no longer available")
        self.assertIn("doesn’t look like a URL", self.env.items("!nonsense")[0]["title"])

    def test_confirmation_can_be_turned_off(self):
        for v in ("0", " 0 ", "false"):
            row = self.env.items("delete example.com/1", confirm_writes=v)[0]
            self.assertEqual(row["variables"]["http_action"], "send", v)
        self.assertIs(self.env.items("delete example.com/1", confirm_writes="")[0]["valid"], False)

    def test_status_codes(self):
        items = self.env.items("404")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "404 Not Found")
        self.assertEqual(items[0]["arg"], "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/404")
        self.assertEqual(items[0]["variables"]["http_action"], "open")
        self.assertEqual(titles(self.env.items("42")), ["420 Enhance Your Calm", "421 Misdirected Request",
                                                        "422 Unprocessable Content", "423 Locked", "424 Failed Dependency",
                                                        "425 Too Early", "426 Upgrade Required", "428 Precondition Required",
                                                        "429 Too Many Requests"])
        self.assertIn("Cloudflare", self.env.items("522")[0]["subtitle"])
        self.assertEqual(self.env.items("522")[0]["variables"]["http_action"], "copy")
        self.assertEqual(len(self.env.items("5xx")), len([1 for i in self.env.items("5") if i["title"][0] == "5"]))
        self.assertIn("isn’t a known status code", self.env.items("600")[0]["title"])
        self.assertIn("418 I’m a teapot", titles(self.env.items("teapot")))

    def test_parse_errors_and_search(self):
        self.assertEqual(self.env.items("file:///etc/passwd")[0]["title"], "Only http:// and https:// URLs can be sent, not file://")
        self.assertIn("No saved or recent requests match", self.env.items("zzzz")[0]["title"])
        items = self.env.items("curl -d @/etc/passwd https://e.com")
        self.assertEqual(len(items), 1)
        self.assertIn("local file", items[0]["title"])

    def test_clipboard_curl_and_url(self):
        items = self.env.items("", HTTP_TEST_CLIPBOARD=CurlParserTests.CHROME_BASH)
        self.assertEqual(items[0]["title"], "POST api.example.com/v1/items?id=5")
        self.assertIn("curl command in the clipboard", items[0]["subtitle"])
        self.assertNotIn("eyJ", json.dumps([(i["title"], i["subtitle"], i.get("text", {}).get("largetype")) for i in items]))
        items = self.env.items("", HTTP_TEST_CLIPBOARD="https://example.com/page")
        self.assertEqual(items[0]["title"], "GET example.com/page")
        items = self.env.items("", HTTP_TEST_CLIPBOARD="curl -d @/etc/passwd https://e.com")
        self.assertIn("Couldn’t read the curl command in the clipboard", items[0]["title"])
        items = self.env.items("", HTTP_TEST_CLIPBOARD="just some text")
        self.assertEqual(items[0]["title"], "Type a request")

    def test_curl_in_query_multiline(self):
        items = self.env.items(CurlParserTests.CHROME_CMD)
        self.assertEqual(items[0]["title"], "POST api.example.com/v1/items?id=5&x=1")

    def test_copy_action_and_large_text(self):
        body = "x" * 60000
        items = self.env.items("post example.com -d " + body)
        conv = find(items, "Copy as curl")
        self.assertTrue(conv["arg"].startswith("httpfile:"))
        self.assertEqual(self.env.act(conv), "")
        self.assertIn(body, self.env.clipboard())
        # ⌘↩: resolve.sh reads it back for the paste object
        out = subprocess.run(["/bin/bash", "-c", RESOLVE_SCRIPT, "bash", conv["mods"]["cmd"]["arg"]], cwd=SRC,
                             env=self.env.vars(), capture_output=True, text=True)
        self.assertIn(body, out.stdout)
        # anything else that looks like a cache path is passed through untouched
        for arg in ["httpfile:/etc/passwd", f"httpfile:{self.env.cache}/out/../../../../etc/passwd"]:
            out = subprocess.run(["/bin/bash", "-c", RESOLVE_SCRIPT, "bash", arg], cwd=SRC, env=self.env.vars(),
                                 capture_output=True, text=True)
            self.assertEqual(out.stdout, arg)
            self.assertEqual(self.env.act({"arg": arg, "variables": {"http_action": "copy"}}), "")
            self.assertEqual(self.env.clipboard(), arg)


# ---------------------------------------------------------------------------------------------
class SendTests(Base):
    def test_get_json(self):
        rid, items = self.env.send(f"get {BASE}/anything?x=1 X-Test:yes")
        self.assertRegex(items[0]["title"], r"^200 OK · (<1 ms|[\d.]+ (ms|s)) · [\d.]+ (B|KB)$")
        self.assertEqual(Mock.requests[0]["headers"]["X-Test"], "yes")
        self.assertTrue(Mock.requests[0]["headers"]["User-Agent"].startswith("alfred-http/"))
        m = self.env.meta(rid)
        self.assertEqual(m["kind"], "json")
        self.assertTrue(m["previewFile"].endswith("preview.json"))
        body = find(items, "{")
        self.assertIn("JSON", body["subtitle"])
        self.assertEqual(body["quicklookurl"], m["previewFile"])
        self.assertIn('"method": "GET"', readf(m["previewFile"]))
        find(items, "DNS ")
        find(items, "Headers (")
        find(items, "Send again")
        # ↩ on the status row copies the body
        self.assertEqual(self.env.act(items[0]), "")
        self.assertIn('"method": "GET"', self.env.clipboard())
        h = self.env.history()
        self.assertEqual((h[0]["id"], h[0]["status"]), (rid, 200))

    def test_methods_and_bodies(self):
        body = '{"q": "it\'s \\"quoted\\"", "nl": "a\\nb", "u": "ü✓", "at": "@/etc/passwd"}'
        for method in ("post", "put", "patch", "delete", "options"):
            Mock.requests = []
            rid, items = self.env.send(f"{method} {BASE}/anything {body}")
            r = Mock.requests[-1]
            self.assertEqual(r["method"], method.upper())
            self.assertEqual(r["body"].decode(), body)
            self.assertEqual(r["headers"]["Content-Type"], "application/json")
        rid, items = self.env.send(f"head {BASE}/anything")
        self.assertEqual(Mock.requests[-1]["method"], "HEAD")
        self.assertTrue(items[0]["title"].startswith("200 OK"))
        rid, items = self.env.send(f"post {BASE}/anything -f name=Ada 'city=New York'")
        self.assertEqual(Mock.requests[-1]["body"], b"name=Ada&city=New%20York")
        rid, items = self.env.send(f"curl -X PURGE {BASE}/anything -F a=1 -F 'b=two words'")
        r = Mock.requests[-1]
        self.assertEqual(r["method"], "PURGE")
        self.assertIn(b'name="b"\r\n\r\ntwo words', r["body"])
        rid, items = self.env.send(f"get {BASE}/anything -u 'us er:p@ss:w'")
        self.assertEqual(Mock.requests[-1]["headers"]["Authorization"], "Basic " + base64.b64encode(b"us er:p@ss:w").decode())

    def test_redirects(self):
        rid, items = self.env.send(f"get {BASE}/redirect/3")
        self.assertTrue(items[0]["title"].startswith("200 OK"))
        r = find(items, "Redirected 3×")
        self.assertEqual(r["subtitle"], "302 → 302 → 302 → 200 · ↩ Copy the final URL")
        rid, items = self.env.send(f"get {BASE}/redirect/3", follow_redirects="0")
        self.assertTrue(items[0]["title"].startswith("302 Found"))

    def test_redirect_to_file_is_refused(self):
        for target in ("file:///etc/passwd", "ftp://127.0.0.1/x", "dict://127.0.0.1:11211/stat"):
            rid, items = self.env.send(f"get {BASE}/redirect-to?url={urllib.parse.quote(target, safe='')}")
            m = self.env.meta(rid)
            self.assertEqual(m["error"]["code"], 1, m)
            self.assertIn("only http:// and https://", items[0]["subtitle"] + items[0]["title"])
            self.assertFalse(os.path.exists(os.path.join(self.env.cache, "resp", rid, "body.txt")) and
                             "root:" in readf(os.path.join(self.env.cache, "resp", rid, "body.txt")))

    def test_gzip_chunked_and_slow_body(self):
        rid, items = self.env.send(f"get {BASE}/gzip")
        self.assertIn('"gzipped": true', readf(self.env.meta(rid)["previewFile"]))
        rid, items = self.env.send(f"get {BASE}/chunked")
        self.assertEqual(readf(self.env.meta(rid)["bodyFile"]), "one,two,three")
        rid, items = self.env.send(f"get {BASE}/slow-body")
        self.assertEqual(self.env.meta(rid)["size"], 500)

    def test_size_limit(self):
        # Content-Length known: curl refuses before downloading
        rid, items = self.env.send(f"get {BASE}/bytes/{2 * 1024 * 1024}", max_size="1")
        m = self.env.meta(rid)
        self.assertEqual(m["error"]["code"], 63)
        self.assertTrue(m["truncated"])
        self.assertIn("larger than the 1.0 MB limit", json.dumps(items, ensure_ascii=False))
        # chunked (no Content-Length): streaming stops at the limit
        rid, items = self.env.send(f"get {BASE}/stream-bytes/{3 * 1024 * 1024}", max_size="1")
        m = self.env.meta(rid)
        self.assertTrue(m["truncated"])
        self.assertEqual(os.path.getsize(m["bodyFile"]), 1024 * 1024)
        self.assertIn("(stopped)", items[0]["title"])
        find(items, "Stopped at 1.0 MB")
        # under the limit
        rid, items = self.env.send(f"get {BASE}/bytes/5000", max_size="1")
        self.assertFalse(self.env.meta(rid).get("truncated"))

    def test_binary_and_images(self):
        rid, items = self.env.send(f"get {BASE}/image.png")
        m = self.env.meta(rid)
        self.assertEqual((m["kind"], os.path.basename(m["bodyFile"])), ("image", "body.png"))
        self.assertEqual(items[0]["variables"]["http_action"], "openfile")
        self.assertEqual(self.env.act(items[0]), f"open {m['bodyFile']}")
        rid, items = self.env.send(f"get {BASE}/image-untyped")
        self.assertEqual(self.env.meta(rid)["kind"], "image")
        rid, items = self.env.send(f"get {BASE}/binary")
        m = self.env.meta(rid)
        self.assertEqual((m["kind"], os.path.basename(m["bodyFile"])), ("binary", "body.bin"))
        self.assertEqual(items[0]["variables"]["http_action"], "reveal")
        find(items, "Binary data · 1.0 KB · application/octet-stream")
        with open(m["bodyFile"], "rb") as f:
            self.assertEqual(f.read(), bytes(range(256)) * 4)
        # an action never opens files outside the response folders, or HTML
        self.assertEqual(self.env.act({"arg": "/etc/passwd", "variables": {"http_action": "openfile"}}), "")
        rid, items = self.env.send(f"get {BASE}/html")
        m = self.env.meta(rid)
        self.assertEqual(self.env.act({"arg": m["bodyFile"], "variables": {"http_action": "openfile"}}), f"reveal {m['bodyFile']}")

    def test_encodings(self):
        rid, items = self.env.send(f"get {BASE}/latin1")
        m = self.env.meta(rid)
        self.assertEqual(m["encoding"], "ISO-8859-1")
        self.assertIn("café naïve", readf(m["previewFile"]))
        self.assertIn("decoded from ISO-8859-1", " ".join(i["subtitle"] for i in items))
        rid, items = self.env.send(f"get {BASE}/latin1-nocharset")
        m = self.env.meta(rid)
        self.assertEqual(m["encoding"], "Windows-1252")
        self.assertEqual(readf(m["previewFile"]), "crème brûlée")
        rid, items = self.env.send(f"get {BASE}/sjis")
        self.assertIn("こんにちは", readf(self.env.meta(rid)["previewFile"]))
        rid, items = self.env.send(f"get {BASE}/utf8-nocharset")
        m = self.env.meta(rid)
        self.assertEqual((m["kind"], m["encoding"]), ("text", "UTF-8"))
        rid, items = self.env.send(f"get {BASE}/json-untyped")
        self.assertEqual(self.env.meta(rid)["kind"], "json")

    def test_big_numbers_kept(self):
        rid, items = self.env.send(f"get {BASE}/bignum")
        text = readf(self.env.meta(rid)["previewFile"])
        self.assertIn('"n": 12345678901234567890', text)
        self.assertIn('"f": 1.0', text)

    def test_errors(self):
        rid, items = self.env.send(f"get {BASE}/slow?s=3", timeout="1")
        self.assertEqual(items[0]["title"], "Couldn’t get a response within 1 s")
        port = free_port()
        rid, items = self.env.send(f"get 127.0.0.1:{port}/x")
        self.assertEqual(items[0]["title"], "Can’t reach 127.0.0.1: the connection was refused")
        self.assertEqual(items[0]["icon"]["path"], "icons/offline.png")
        self.assertEqual(self.env.history()[0]["error"], items[0]["title"])
        rid, items = self.env.send(f"get {BASE}/status/404")
        self.assertTrue(items[0]["title"].startswith("404 Not Found"))
        rid, items = self.env.send(f"get {BASE}/status/204")
        self.assertTrue(items[0]["title"].startswith("204 No Content"))
        rid, items = self.env.send(f"get {BASE}/empty")
        self.assertTrue(items[0]["title"].startswith("200 OK"))

    def test_response_secrets_masked(self):
        rid, items = self.env.send(f"get {BASE}/cookies")
        row = find(items, "Set-Cookie:")
        self.assertEqual(row["title"], "Set-Cookie: session=•••; Path=/; HttpOnly")
        self.assertEqual(row["variables"]["http_text"], "session=abc123secret; Path=/; HttpOnly")
        self.assertEqual(self.env.act(row), "")
        self.assertEqual(self.env.clipboard(), "session=abc123secret; Path=/; HttpOnly")
        self.assertNotIn("abc123secret", items[0]["text"]["largetype"])

    def test_history_and_secrets(self):
        rid, items = self.env.send(f"get {BASE}/anything H:Authorization=Bearer SECRET1 -u me:SECRET2", keep_secrets="1")
        home = self.env.items("", keep_secrets="1")
        self.assertTrue(home[0]["title"].startswith("GET http://127.0.0.1"))
        self.assertIn("200 OK", home[0]["subtitle"])
        self.assertNotIn("SECRET", json.dumps([(i["title"], i["subtitle"], i["text"]["largetype"]) for i in home]))
        # the history file has no secrets; the Keychain has them
        self.assertNotIn("SECRET", json.dumps(self.env.history()))
        self.assertIn("SECRET1", keychain_dump(self.env))
        self.assertNotIn("SECRET", home[0]["text"]["copy"])
        self.assertIn("Authorization: •••", home[0]["text"]["copy"])
        # ⌘↩ builds the real command only when pressed
        self.assertTrue(home[0]["mods"]["cmd"]["arg"].startswith("httpref:curl:hist:"))
        out = subprocess.run(["/bin/bash", "-c", RESOLVE_SCRIPT, "bash", home[0]["mods"]["cmd"]["arg"]], cwd=SRC,
                             env=self.env.vars(), capture_output=True, text=True)
        self.assertIn("Authorization: Bearer SECRET1", out.stdout)
        self.assertIn("me:SECRET2", out.stdout)
        self.assertFalse(out.stdout.endswith("\n"))
        # send again from the history
        Mock.requests = []
        out = self.env.act(home[0], keep_secrets="1")
        self.assertTrue(out.startswith("sent "))
        self.assertEqual(Mock.requests[-1]["headers"]["Authorization"], "Bearer SECRET1")
        self.assertEqual(len(self.env.history()), 1)  # the same request moves to the top
        # ⌥↩ shows the last response, ⌃↩ removes it
        home = self.env.items("")
        self.assertEqual(self.env.act(home[0]["mods"]["alt"]), f"show {home[0]['mods']['alt']['arg']}")
        self.assertEqual(self.env.act(home[0]["mods"]["ctrl"]), "Removed from the history")
        self.assertEqual(self.env.history(), [])
        self.assertEqual(keychain_dump(self.env), "")  # its secrets went with it
        # without "Remember secrets" (the default), history drops them
        self.env.send(f"get {BASE}/anything H:Authorization=Bearer SECRET3 -u me:SECRET4")
        dump = json.dumps(self.env.history())
        self.assertNotIn("SECRET3", dump)
        self.assertNotIn("SECRET4", dump)
        for d in os.listdir(os.path.join(self.env.cache, "resp")):
            self.assertNotIn("SECRET3", readf(os.path.join(self.env.cache, "resp", d, "request.json")))
        self.assertEqual(keychain_dump(self.env), "")
        home = self.env.items("")
        self.assertIn("secrets weren’t kept", find(home, "GET http://127.0.0.1")["subtitle"])
        Mock.requests = []
        self.env.act(find(home, "GET http://127.0.0.1"))
        # sent without them, as the row says: the user name stays, with an empty password
        self.assertEqual(Mock.requests[-1]["headers"]["Authorization"], "Basic " + base64.b64encode(b"me:").decode())

    def test_history_filter_and_saved(self):
        self.env.send(f"get {BASE}/anything/alpha")
        self.env.send(f"get {BASE}/anything/beta")
        self.assertEqual(len(self.env.items("alpha")), 1)
        items = self.env.items("save Beta")
        row = find(items, "Save “Beta”: GET http://127.0.0.1")
        self.assertIn("beta", row["title"])
        self.assertEqual(self.env.act(row), "Saved “Beta”")
        items = self.env.items(f"save Gamma post {BASE}/anything a=1")
        self.assertEqual(self.env.act(items[0]), "Saved “Gamma”")
        home = self.env.items("")
        self.assertTrue(home[0]["title"].startswith("Gamma · POST"))
        self.assertTrue(home[1]["title"].startswith("Beta · GET"))
        self.assertEqual(self.env.items("gam")[0]["title"], home[0]["title"])
        self.assertIs(home[0]["valid"], False)  # POST: confirmation first
        Mock.requests = []
        self.assertTrue(self.env.act(home[1]).startswith("sent "))
        self.assertTrue(Mock.requests[-1]["path"].endswith("/beta"))
        self.assertIn("replaces", self.env.items("save beta")[0]["subtitle"])
        self.assertEqual(self.env.act(home[1]["mods"]["ctrl"]), "Deleted “Beta”")
        self.assertFalse(any(t.startswith("Beta") for t in titles(self.env.items(""))))

    def test_clear(self):
        self.env.send(f"get {BASE}/anything")
        items = self.env.items("clear")
        self.assertEqual(self.env.act(items[0]), "Cleared the request history")
        self.assertEqual(self.env.act(items[1]), "Cleared cached responses")
        self.assertEqual(self.env.history(), [])
        self.assertFalse(os.path.exists(os.path.join(self.env.cache, "resp")))

    def test_bidi_and_control_characters(self):
        rid, items = self.env.send(f"get {BASE}/bidi")
        for i in items:
            self.assertNotIn("\u202e", i["title"] + i.get("subtitle", ""))

    def test_curlrc_is_ignored(self):
        home = tempfile.mkdtemp(prefix="http-home-")
        with open(os.path.join(home, ".curlrc"), "w") as f:
            f.write('header = "X-From-Curlrc: 1"\nproxy = "http://127.0.0.1:9"\n')
        rid, items = self.env.send(f"get {BASE}/anything", HOME=home)
        self.assertTrue(items[0]["title"].startswith("200 OK"))
        self.assertNotIn("X-From-Curlrc", Mock.requests[-1]["headers"])
        shutil.rmtree(home)


class BackgroundTests(Base):
    """The real path: act spawns a detached sender, the Script Filter shows it waiting, then the result."""

    def wait_meta(self, rid, timeout=20):
        p = os.path.join(self.env.cache, "resp", rid, "meta.json")
        t0 = time.time()
        while not os.path.exists(p):
            self.assertLess(time.time() - t0, timeout)
            time.sleep(0.1)
        return self.env.meta(rid)

    def test_detached_send(self):
        row = self.env.items(f"get {BASE}/slow?s=1.5", HTTP_SYNC="0")[0]
        out = self.env.act(row, HTTP_SYNC="0")
        rid = out.split()[1]
        waiting = self.env.sf("=" + rid, HTTP_SYNC="0")
        self.assertEqual(waiting.get("rerun"), 0.3)
        self.assertTrue(waiting["items"][0]["title"].startswith("Sending GET"))
        self.assertEqual(self.wait_meta(rid)["status"], 200)
        self.assertTrue(self.env.items("=" + rid)[0]["title"].startswith("200 OK"))

    def test_cancel(self):
        row = self.env.items(f"get {BASE}/slow?s=8", HTTP_SYNC="0", timeout="30")[0]
        rid = self.env.act(row, HTTP_SYNC="0", timeout="30").split()[1]
        time.sleep(1.0)
        waiting = self.env.items("=" + rid)[0]
        self.assertEqual(waiting["variables"]["http_action"], "cancel")
        self.assertEqual(self.env.act(waiting), "Cancelled the request")
        self.assertEqual(self.env.meta(rid)["error"]["message"], "Cancelled")
        self.assertEqual(self.env.items("=" + rid)[0]["title"], "Cancelled")
        time.sleep(0.5)
        ps = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
        self.assertNotIn(rid, ps)

    def test_missing_and_bad_ids(self):
        self.assertEqual(self.env.items("=zzzzzzzz-zzzz")[0]["title"], "This response is no longer cached")
        items = self.env.items("=../../etc")
        self.assertNotEqual(items[0]["title"], "This response is no longer cached")


class AlfredRuntimeTests(Base):
    """Alfred runs scripts without LANG and with a bare PATH."""

    def test_env_minus_i(self):
        e = {"HOME": os.environ["HOME"], "USER": os.environ.get("USER", ""), "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
             "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        e.update(alfred_workflow_cache=self.env.cache, alfred_workflow_data=self.env.data, HTTP_TEST_CLIPBOARD="",
                 HTTP_TEST_NOOPEN="1", HTTP_SYNC="1", HTTP_TEST_CLIPBOARD_OUT=self.env.clip_out)
        for q in ["", f"get {BASE}/latin1 H:X=ü", "404", "curl 'https://e.com' -H 'a: b'"]:
            out = subprocess.run(["/bin/bash", "-c", SF_SCRIPT, "bash", q], cwd=SRC, env=e, capture_output=True, text=True, timeout=30)
            validate(json.loads(out.stdout))
        row = json.loads(subprocess.run(["/bin/bash", "-c", SF_SCRIPT, "bash", f"get {BASE}/latin1"], cwd=SRC, env=e,
                                        capture_output=True, text=True).stdout)["items"][0]
        out = subprocess.run(["/bin/bash", "-c", ACT_SCRIPT, "bash", row["arg"]], cwd=SRC, env=dict(e, **row["variables"]),
                             capture_output=True, text=True, timeout=30)
        rid = out.stdout.split()[1]
        self.assertIn("café", readf(self.env.meta(rid)["previewFile"]))

    def test_config_values(self):
        for t in ("", " ", "abc", "0", "-5", " 2 "):
            rid, items = self.env.send(f"get {BASE}/anything", timeout=t, max_size=" ", follow_redirects="")
            self.assertTrue(items[0]["title"].startswith("200 OK"), (t, items[0]))
        items = self.env.items("", keyword_http="  ")
        self.assertTrue(items)

    def test_fresh_install_and_damaged_files(self):
        os.makedirs(self.env.data)
        for name in ("history.json", "saved.json"):
            with open(os.path.join(self.env.data, name), "w") as f:
                f.write('{"items": [1, null, {"id": "x"}, {"id": "abcdefgh-abcd", "req": {"method": "GET", "url": "file:///etc/passwd"}}]')
        self.assertEqual(titles(self.env.items("")), ["Type a request", "Paste a curl command", "Look up a status code"])
        with open(os.path.join(self.env.data, "history.json"), "w") as f:
            f.write("[]")
        self.assertTrue(self.env.items(""))

    def test_filter_speed(self):
        self.env.send(f"get {BASE}/anything")
        for q in ["", "get api.github.com/users/octocat", "404", CurlParserTests.CHROME_BASH]:
            t0 = time.time()
            self.env.items(q)
            self.assertLess(time.time() - t0, 1.5, q)  # osascript startup included


class Audit1RegressionTests(Base):
    def test_user_without_password(self):
        r = parse(["example.com -u alice", "curl -u alice https://e.com", "curl -u alice:pw https://e.com"])
        self.assertEqual(r[0]["auth"], "alice:")
        self.assertTrue(any("empty one" in n for n in r[0]["notes"]))
        self.assertEqual(r[1]["auth"], "alice:")
        self.assertTrue(any("empty one" in n for n in r[1]["notes"]))
        self.assertEqual(r[2]["auth"], "alice:pw")

    def test_shell_quoting_for_zsh(self):
        conv = js("convert", ["example.com -d ^abc", "example.com -d =abc", "example.com -d ~abc"])
        self.assertIn("--data-raw '^abc'", conv[0]["curl"])
        self.assertIn("--data-raw '=abc'", conv[1]["curl"])
        self.assertIn("--data-raw '~abc'", conv[2]["curl"])

    def test_json_parts_are_concatenated(self):
        r = parse(["curl https://e.com --json '{\"a\":' --json '1}'", "curl https://e.com -d a=1 -d b=2"])
        self.assertEqual(r[0]["body"]["text"], '{"a":1}')
        self.assertEqual(r[1]["body"]["text"], "a=1&b=2")

    def test_home_view_prunes_old_stashes(self):
        self.env.items("post example.com/one -d " + "x" * 70000, confirm_writes="0")  # too large for a variable
        stash = os.path.join(self.env.cache, "req")
        old = [os.path.join(stash, f) for f in os.listdir(stash)]
        self.assertEqual(len(old), 1)
        t = time.time() - 3 * 86400
        os.utime(old[0], (t, t))
        self.env.items("")
        self.assertFalse(os.path.exists(old[0]))


class Audit2RegressionTests(Base):
    def test_typing_writes_no_secrets_to_disk(self):
        for q in ["get example.com H:Authorization=Bearer SECRETTYPED", "post example.com token=SECRETTYPED",
                  "!post example.com token=SECRETTYPED", "save x get example.com H:X-Api-Key=SECRETTYPED"]:
            self.env.items(q)
        for base, dirs, files in os.walk(self.env.dir):
            for f in files:
                self.assertNotIn(b"SECRETTYPED", readf(os.path.join(base, f), "rb"), f)

    def test_review_step_sends_what_it_shows(self):
        row = self.env.items(f"post {BASE}/anything a=1")[0]
        self.assertEqual(row["autocomplete"], f"!post {BASE}/anything a=1")
        confirm = self.env.items(row["autocomplete"])
        self.assertEqual(confirm[1]["autocomplete"], f"post {BASE}/anything a=1")  # Cancel
        self.assertTrue(self.env.act(confirm[0]).startswith("sent "))
        self.assertEqual(Mock.requests[-1]["body"], b'{"a": "1"}')
        # the clipboard is read again in the review step
        clip = f"curl -X DELETE {BASE}/anything/9"
        row = self.env.items("", HTTP_TEST_CLIPBOARD=clip)[0]
        self.assertEqual(row["autocomplete"], "!clip")
        confirm = self.env.items("!clip", HTTP_TEST_CLIPBOARD=clip)
        self.assertEqual(confirm[0]["title"], "Send DELETE http://127.0.0.1:%d/anything/9" % SERVER.server_port)
        self.assertEqual(confirm[1]["autocomplete"], "")
        self.assertEqual(self.env.items("!clip", HTTP_TEST_CLIPBOARD="hello")[0]["title"], "This request is no longer available")
        # history and saved rows review by reference
        self.env.act(confirm[0])
        home = self.env.items("")
        hist = find(home, "DELETE")
        self.assertRegex(hist["autocomplete"], r"^!hist:[a-z0-9]+-[a-z0-9]+$")
        self.assertEqual(self.env.items(hist["autocomplete"])[0]["title"], confirm[0]["title"])

    def test_send_again_without_history(self):
        rid, items = self.env.send(f"post {BASE}/anything b=2")
        self.env.act({"arg": "history", "variables": {"http_action": "clear"}})
        again = find(self.env.items("=" + rid), "Send again")
        self.assertEqual(again["autocomplete"], f"!resp:{rid}")
        confirm = self.env.items(again["autocomplete"])
        self.assertTrue(self.env.act(confirm[0]).startswith("sent "))
        self.assertEqual(Mock.requests[-1]["body"], b'{"b": "2"}')

    def test_cancel_stops_the_sender_first(self):
        src = readf(os.path.join(SRC, "http.js"))
        self.assertIn('for (const f of ["pid", "curlpid"])', src)


class Audit3RegressionTests(Base):
    def test_long_copy_text_says_it_was_cut(self):
        body = "y" * 60000
        items = self.env.items("post example.com -d " + body)
        conv = find(items, "Copy as curl")
        self.assertTrue(conv["text"]["copy"].endswith("press ↩ to copy all of it)"))
        self.assertTrue(items[0]["text"]["copy"].endswith("press ↩ to copy all of it)"))
        rid, items = self.env.send(f"get {BASE}/bytes/9000")
        body_row = find(items, "aaaa")
        self.assertTrue(body_row["text"]["copy"].endswith("press ↩ to copy all of it)"))
        self.assertEqual(self.env.act(body_row), "")
        self.assertEqual(self.env.clipboard(), "a" * 9000)
        rid, items = self.env.send(f"get {BASE}/bytes/100")
        self.assertEqual(find(items, "aaaa")["text"]["copy"], "a" * 100)


class HistorySizeTests(Base):
    def test_huge_bodies_stay_out_of_history(self):
        big = "z" * 300000
        rid, items = self.env.send(f"post {BASE}/anything -d {big}")
        self.assertEqual(len(Mock.requests[-1]["body"]), 300000)
        h = self.env.history()[0]
        self.assertTrue(h["req"]["bodyDropped"])
        self.assertIsNone(h["req"]["body"])
        self.assertLess(os.path.getsize(os.path.join(self.env.data, "history.json")), 10000)
        row = find(self.env.items(""), "POST")
        self.assertIn("too large to keep", row["subtitle"])
        confirm = self.env.items(row["autocomplete"])
        self.assertTrue(self.env.act(confirm[0]).startswith("sent "))
        self.assertEqual(len(Mock.requests[-1]["body"]), 300000)  # sent again from the response folder


class PrototypeTests(Base):
    def test_server_and_user_strings_never_hit_object_prototype(self):
        rid, items = self.env.send(f"get {BASE}/proto")
        m = self.env.meta(rid)
        self.assertEqual((m["kind"], os.path.basename(m["bodyFile"])), ("binary", "body.bin"))
        items = self.env.items("curl -X constructor https://e.com", confirm_writes="0")
        self.assertEqual(items[0]["icon"]["path"], "icons/method.png")


class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        p = PLIST
        uids = [o["uid"] for o in p["objects"]]
        self.assertEqual(len(uids), len(set(uids)))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
        for o in p["objects"]:
            kw = o["config"].get("keyword")
            if kw:
                self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
        self.assertTrue(p["readme"].startswith("## Usage"))
        self.assertEqual(p["bundleid"], "io.github.x-o-r-r-o.http")
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)

    def test_no_runtime_dependencies(self):
        for f in os.listdir(SRC):
            self.assertFalse(f.endswith((".py", ".rb", ".node")), f)
        src = readf(os.path.join(SRC, "http.js"))
        for tool in re.findall(r'"(/usr/bin/[\w-]+|/bin/\w+)"', src):
            self.assertTrue(os.path.exists(tool), tool)

    def test_icons_exist(self):
        src = readf(os.path.join(SRC, "http.js"))
        names = set(re.findall(r'icon\("(\w+)"\)', src)) | set(re.findall(r'info\([^)]*?"(\w+)"(?:, \{|\))', src))
        names |= set(re.findall(r'"(s[2-5]xx|get|post|put|patch|delete|method)"', src))
        for n in names:
            self.assertTrue(os.path.exists(os.path.join(SRC, "icons", n + ".png")), n)


# ---------------------------------------------------------------------------------------------
class Audit4RegressionTests(Base):
    """Independent audit: secrets at rest, secrets in process arguments, Quick Look, curl options."""

    SECRET_REQ = "get {base}/status/200?api_key=SECRETKEY H:Authorization=Bearer SECRETTOKEN Cookie:sid=SECRETSID -u me:SECRETPW"

    def tree(self):
        for root in (self.env.cache, self.env.data):
            for d, dirs, files in os.walk(root):
                yield d, True
                for f in files:
                    yield os.path.join(d, f), False

    def test_files_are_private_and_hold_no_secrets(self):
        for keep in ("0", "1"):
            self.env.send(self.SECRET_REQ.format(base=BASE), keep_secrets=keep)
        self.env.act(self.env.items(f"save Mine post {BASE}/status/200 password=SECRETBODY H:X-Api-Key=SECRETAPI")[0])
        seen = 0
        for path, is_dir in self.tree():
            mode = os.stat(path).st_mode & 0o777
            self.assertEqual(mode, 0o700 if is_dir else 0o600, path)
            if not is_dir:
                seen += 1
                self.assertNotIn("SECRET", readf(path, "rb").decode("utf-8", "replace"), path)
                self.assertNotIn(os.path.basename(path), ("send.json", "stderr.txt", "headers.txt"))
        self.assertGreater(seen, 5)
        kc = keychain_dump(self.env)
        for secret in ("SECRETTOKEN", "SECRETSID", "SECRETPW", "SECRETKEY", "SECRETBODY", "SECRETAPI"):
            self.assertIn(secret, kc)

    def test_saved_requests_send_their_secrets(self):
        out = self.env.act(self.env.items(f"save Login post {BASE}/anything?token=SECRETQ password=SECRETP H:Authorization=Bearer SECRETH")[0])
        self.assertEqual(out, "Saved “Login”")
        saved = readf(os.path.join(self.env.data, "saved.json"))
        self.assertNotIn("SECRET", saved)
        row = find(self.env.items(""), "Login · POST")
        self.assertNotIn("SECRET", json.dumps(row, ensure_ascii=False))
        confirm = self.env.items(row["autocomplete"])
        self.assertIn("SECRETH", find(confirm, "Copy as curl")["variables"]["http_text"])
        self.assertNotIn("SECRET", all_args(confirm))
        Mock.requests = []
        self.assertTrue(self.env.act(confirm[0]).startswith("sent "))
        r = Mock.requests[-1]
        self.assertEqual(r["headers"]["Authorization"], "Bearer SECRETH")
        self.assertIn("token=SECRETQ", r["path"])
        self.assertEqual(json.loads(r["body"]), {"password": "SECRETP"})
        self.assertEqual(self.env.act(find(self.env.items(""), "Login · POST")["mods"]["ctrl"]), "Deleted “Login”")
        self.assertEqual(keychain_dump(self.env), "")

    def test_no_secret_in_any_process_argument(self):
        q = self.SECRET_REQ.format(base=BASE)
        self.assertNotIn("SECRET", all_args(self.env.items(q)))
        self.assertNotIn("SECRET", all_args(self.env.items("!post " + q[4:])))
        rid, items = self.env.send(q.replace("/status/200", "/cookies"), keep_secrets="1")
        self.assertNotIn("SECRET", all_args(items))
        self.assertIn("SECRETTOKEN", find(items, "Copy as curl")["variables"]["http_text"])  # still copied for real
        self.assertNotIn("SECRET", all_args(self.env.items("", keep_secrets="1")))
        self.assertNotIn("abc123secret", all_args(items))  # a response's Set-Cookie too

    def test_history_dedupe_ignores_secrets(self):
        self.env.send(f"get {BASE}/anything H:Authorization=Bearer ONE", keep_secrets="1")
        self.env.send(f"get {BASE}/anything H:Authorization=Bearer TWO", keep_secrets="1")
        h = self.env.history()
        self.assertEqual(len(h), 1)  # the same request with a new token replaces the old one
        kc = keychain_dump(self.env)
        self.assertIn("TWO", kc)
        self.assertNotIn("ONE", kc)
        self.assertEqual(self.env.act(find(self.env.items("clear"), "Clear the request history")), "Cleared the request history")
        self.assertEqual(keychain_dump(self.env), "")

    def test_test_mode_never_falls_back_to_real_services(self):
        v = self.env.vars()
        for name in ("HTTP_TEST_CLIPBOARD", "HTTP_TEST_KEYCHAIN"):
            e = dict(v, keep_secrets="1")
            del e[name]
            out = subprocess.run(["/bin/bash", "-c", SF_SCRIPT, "bash", ""], cwd=SRC, env=e, capture_output=True, text=True)
            if name == "HTTP_TEST_CLIPBOARD":
                self.assertIn(name, out.stdout)
        e = dict(v, keep_secrets="1", http_action="send", http_req=json.dumps(parse([f"get {BASE}/x H:Authorization=Bearer X"])[0]))
        del e["HTTP_TEST_KEYCHAIN"]
        out = subprocess.run(["/bin/bash", "-c", ACT_SCRIPT, "bash", "send"], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertIn("HTTP_TEST_KEYCHAIN", out.stdout)
        e = dict(v, http_action="copy", http_text="x")
        del e["HTTP_TEST_CLIPBOARD_OUT"]
        out = subprocess.run(["/bin/bash", "-c", ACT_SCRIPT, "bash", "httpvar:"], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertIn("HTTP_TEST_CLIPBOARD_OUT", out.stdout)

    def test_quick_look_never_loads_remote_content(self):
        rid, items = self.env.send(f"get {BASE}/evil-html")
        ql = items[0]["quicklookurl"]
        self.assertTrue(ql.endswith("/quicklook.html"), ql)
        page = readf(ql)
        self.assertNotIn("/track", page)
        for bad in ("<script", "<link", "<iframe", "<object", "<base", "http-equiv", "onclick", "background=", "<svg", "srcset"):
            self.assertNotIn(bad, page.lower())
        self.assertIn("<h1>Hello &amp; <i>world</i>", page)
        self.assertIn('<td colspan="2">', page)
        self.assertEqual(find(items, "<!DOCTYPE")["quicklookurl"], ql)
        # ↩ still copies the page as it came
        self.env.act(items[0])
        self.assertIn(f"{BASE}/track/img", self.env.clipboard())
        rid, items = self.env.send(f"get {BASE}/svg")
        ql = items[0]["quicklookurl"]
        self.assertTrue(ql.endswith("/quicklook.html"), ql)
        self.assertIn('<img src="data:image/svg+xml;base64,', readf(ql))
        self.assertNotIn("/track", readf(ql))
        self.assertFalse(any(r["path"].startswith("/track") for r in Mock.requests))

    def test_every_curl_option_with_a_value_is_known(self):
        help_text = subprocess.run(["/usr/bin/curl", "--help", "all"], capture_output=True, text=True).stdout
        opts = re.findall(r"^\s*(?:-(\S), )?--([a-z0-9.-]+) <[^>]+>", help_text, re.M)
        extra = ["httpsig-algo", "httpsig-headers", "httpsig-key", "httpsig-keyid", "keepalive-cnt", "parallel-max-host", "ssl-sessions"]
        names = [o for _, o in opts if o not in ("help", "config", "variable", "upload-file", "netrc-file", "unix-socket",
                                                  "abstract-unix-socket", "url")] + extra
        self.assertGreater(len(names), 100)
        r = parse([f"curl --{o} value.example https://e.com/" for o in names])
        for o, x in zip(names, r):
            if "error" in x:
                self.assertRegex(x["error"], "local file|needs|name=value|isn’t supported", o)
            else:
                self.assertTrue(x["url"].startswith("https://e.com/"), (o, x["url"]))  # --url-query adds to it
        shorts = [sh for sh, o in opts if sh and o in names]
        r = parse([f"curl -{sh} value.example https://e.com/" for sh in shorts])
        for sh, x in zip(shorts, r):
            self.assertTrue("error" in x or x["url"] == "https://e.com/", (sh, x))

    def test_curl_file_and_auth_options_say_they_were_ignored(self):
        r = parse([
            "curl -o out.json https://e.com",
            "curl --output-dir /tmp -O https://e.com/f",
            "curl -D - -c jar.txt --trace t.txt --libcurl code.c --stderr e.txt --etag-save e https://e.com",
            "curl --digest -u a:b https://e.com",
            "curl --netrc https://e.com",
            "curl --aws-sigv4 aws:amz:us-east-1:s3 -u k:s https://e.com",
            "curl --frobnicate value.example https://e.com",
            "curl --frobnicate https://e.com",
            "curl -W value.example https://e.com",
        ])
        for x in r[:3]:
            self.assertTrue(any("files the command reads or writes" in n for n in x["notes"]), x)
            self.assertEqual(x["method"], "GET")
        self.assertTrue(any("--digest isn’t supported" in n for n in r[3]["notes"]))
        self.assertTrue(any("~/.netrc" in n for n in r[4]["notes"]))
        self.assertTrue(any("isn’t signed" in n for n in r[5]["notes"]))
        for x in r[6:]:
            self.assertIn("its value or the URL", x["error"])

    def test_httpie_nested_json_bearer_and_empty_headers(self):
        r = parse([
            "post e.com search[type]=id search[id]:=1 tags[]=a tags[]=b",
            "post e.com items[2]=x",
            "post e.com [0][name]=x [1][name]=y",
            "post e.com a:=[1] a[]=2",
            "post e.com foo\\[bar\\]:=1",
            "post e.com n[big]:=12345678901234567890 n[f]:=1.0",
            "post e.com a[]=1 a[k]=2",
            "post e.com a[b=1",
            "e.com -A bearer -a tok123",
            "e.com --auth-type=bearer --auth=tok",
            "e.com -A digest -a u:p",
            "e.com X-Empty; Accept:x",
            "e.com -A bearer -a t H:Authorization=x",
        ])
        self.assertEqual(json.loads(r[0]["body"]["text"]), {"search": {"type": "id", "id": 1}, "tags": ["a", "b"]})
        self.assertEqual(json.loads(r[1]["body"]["text"]), {"items": [None, None, "x"]})
        self.assertEqual(json.loads(r[2]["body"]["text"]), [{"name": "x"}, {"name": "y"}])
        self.assertEqual(json.loads(r[3]["body"]["text"]), {"a": [1, "2"]})
        self.assertEqual(json.loads(r[4]["body"]["text"]), {"foo[bar]": 1})
        self.assertEqual(r[5]["body"]["text"], '{"n": {"big": 12345678901234567890, "f": 1.0}}')
        self.assertIn("can’t use [k] on an array", r[6]["error"])
        self.assertIn("“]” is missing", r[7]["error"])
        self.assertEqual(r[8]["headers"], [["Authorization", "Bearer tok123"]])
        self.assertEqual(r[9]["headers"], [["Authorization", "Bearer tok"]])
        self.assertIn("isn’t supported", r[10]["error"])
        self.assertEqual(r[11]["headers"], [["X-Empty", ""], ["Accept", "x"]])
        self.assertIn("not both", r[12]["error"])

    def test_system_proxy(self):
        proxy = f"127.0.0.1:{SERVER.server_port}"  # the mock server answers proxy requests too
        rid, items = self.env.send("get http://proxied.invalid/anything?x=1", HTTP_TEST_PROXY=proxy)
        self.assertTrue(items[0]["title"].startswith("200 OK"), items[0])
        self.assertEqual(Mock.requests[-1]["path"], "http://proxied.invalid/anything?x=1")
        # local addresses never go through it
        rid, items = self.env.send(f"get {BASE}/anything", HTTP_TEST_PROXY=f"127.0.0.1:{free_port()}")
        self.assertTrue(items[0]["title"].startswith("200 OK"), items[0])

    def test_truncation_never_splits_an_emoji(self):
        items = self.env.items("get example.com X-Emoji:" + "😀" * 300)
        for i in items:
            for k in ("title", "subtitle"):
                self.assertNotIn("�", i.get(k, ""), i[k])


if __name__ == "__main__":
    unittest.main(verbosity=1)
