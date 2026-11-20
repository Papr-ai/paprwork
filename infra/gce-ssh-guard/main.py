"""SOC 2 auto-fix: set block-project-ssh-keys=TRUE on any GCE VM created (or re-metadata'd) without it.
Fed by a Cloud Logging sink (audit log: compute.instances.insert / setMetadata, operation.last) -> Pub/Sub push.
Stdlib only. Returns 5xx on transient errors so Pub/Sub retries."""
import base64, json, os, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

API = "https://compute.googleapis.com/compute/v1/"
KEY = "block-project-ssh-keys"

def token():
    req = urllib.request.Request("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                                 headers={"Metadata-Flavor": "Google"})
    return json.load(urllib.request.urlopen(req, timeout=5))["access_token"]

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=20))

def fix(resource):  # resource = projects/P/zones/Z/instances/N
    for attempt in range(5):
        inst = call("GET", resource)
        md = inst.get("metadata", {})
        items = md.get("items", [])
        if any(i["key"] == KEY and str(i.get("value", "")).upper() == "TRUE" for i in items):
            return "compliant"
        items = [i for i in items if i["key"] != KEY] + [{"key": KEY, "value": "TRUE"}]
        try:
            call("POST", resource + "/setMetadata", {"fingerprint": md.get("fingerprint"), "items": items})
            return "fixed"
        except urllib.error.HTTPError as e:
            if e.code != 412:  # 412 = fingerprint race; re-read and retry
                raise
            time.sleep(1 + attempt)
    raise RuntimeError("fingerprint conflict persisted")

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            env = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            entry = json.loads(base64.b64decode(env["message"]["data"]))
            res = entry.get("protoPayload", {}).get("resourceName", "")
            if "/instances/" not in res or entry.get("severity") == "ERROR":
                result = "ignored"
            else:
                result = fix(res)
            print(json.dumps({"severity": "NOTICE" if result == "fixed" else "INFO", "message": f"{result} {res}",
                              "result": result, "instance": res, "actor": entry.get("protoPayload", {})
                              .get("authenticationInfo", {}).get("principalEmail")}), flush=True)
            self.send_response(200)
        except urllib.error.HTTPError as e:
            print(json.dumps({"severity": "ERROR", "message": f"HTTP {e.code}: {e.read()[:300]!r}"}), flush=True)
            self.send_response(200 if e.code == 404 else 500)  # deleted VM: drop; else retry
        except Exception as e:
            print(json.dumps({"severity": "ERROR", "message": repr(e)}), flush=True)
            self.send_response(500)
        self.end_headers()

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    HTTPServer(("", int(os.environ.get("PORT", "8080"))), H).serve_forever()
