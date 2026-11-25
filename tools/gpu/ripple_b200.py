#!/usr/bin/env python3
"""Ripple-65B on a rented Vast.ai B200: the same vLLM server as ripple_vllm.py (nightly, NVFP4, ripple parsers, DFlash2).

    python3 tools/gpu/ripple_b200.py whoami                 # the account that will be billed
    python3 tools/gpu/ripple_b200.py offers                 # cheapest single-B200 offers (read-only)
    python3 tools/gpu/ripple_b200.py rent <offer-id>        # starts billing; prints the new instance id
    python3 tools/gpu/ripple_b200.py status <instance>      # state, address, $/hr
    python3 tools/gpu/ripple_b200.py config <instance>      # once running: the swarm.config.json lines for it
    python3 tools/gpu/ripple_b200.py stop|start <instance>  # stop keeps the disk (~$0.05/hr); the GPU can be taken meanwhile
    python3 tools/gpu/ripple_b200.py destroy <instance>     # deletes it; billing ends

Keys stay out of the repo:
  VAST_API_KEY_FILE   your Vast key (default ~/.config/vastai/vast_api_key, where the vastai CLI keeps it).
  RIPPLE_GPU_API_KEY  a random string you choose; vLLM rejects requests without it. Senju sends the same value.
"""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

API = "https://console.vast.ai/api/v0"
KEY_FILE = pathlib.Path(os.environ.get("VAST_API_KEY_FILE", "~/.config/vastai/vast_api_key")).expanduser()

VLLM_ARGS = [
    "ricursiveAI/Ripple-65B-Preview-NVFP4",
    "--served-model-name", "ricursiveai/ripple-65b-preview",
    "--host", "0.0.0.0", "--port", "8000",
    "--tensor-parallel-size", "1",
    "--max-model-len", "131072",
    "--reasoning-parser", "ripple",
    "--enable-auto-tool-choice", "--tool-call-parser", "ripple",
    "--speculative-config", json.dumps({"method": "dflash", "model": "ricursiveAI/Ripple-65B-Preview-DFlash2", "num_speculative_tokens": 15}),
    "--enable-prefix-caching", "--max-num-seqs", "64",
]


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + KEY_FILE.read_text().strip(), "content-type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read().decode(), strict=False)
    except urllib.error.HTTPError as e:
        return {"success": False, "http": e.code, "body": e.read().decode()[:300]}


def instance(iid):
    d = call("GET", f"/instances/{iid}/")
    i = d.get("instances", d)
    return i[0] if isinstance(i, list) and i else i


def base_url(i):
    p = (i.get("ports") or {}).get("8000/tcp")
    ip = (i.get("public_ipaddr") or "").strip()
    return f"http://{ip}:{p[0]['HostPort']}/v1" if p and ip else None


def server_key():
    key = os.environ.get("RIPPLE_GPU_API_KEY", "").strip()
    if not key:
        sys.exit("set RIPPLE_GPU_API_KEY to a random string first (vLLM requires it on every request)")
    return key


def main(cmd, arg=None):
    if cmd == "whoami":
        u = call("GET", "/users/current/")
        print({k: u.get(k) for k in ("id", "is_team", "credit") if k in u})
    elif cmd == "offers":
        d = call("POST", "/bundles/", {"gpu_name": {"eq": "B200"}, "rentable": {"eq": True}, "rented": {"eq": False},
                                        "num_gpus": {"eq": 1}, "order": [["dph_total", "asc"]], "type": "on-demand", "limit": 8})
        for o in d.get("offers", []):
            print(f"{o['id']}  ${o['dph_total']:.2f}/hr  {o.get('inet_down', 0):.0f} Mbps  {o.get('geolocation', '')}  reliability {o.get('reliability2', 0):.3f}")
    elif cmd == "rent":
        body = {"client_id": "me", "image": "vllm/vllm-openai:nightly", "disk": 200, "label": "ripple-b200",
                "runtype": "args", "args": VLLM_ARGS, "env": {"-p 8000:8000": "1", "VLLM_API_KEY": server_key()}}
        r = call("PUT", f"/asks/{arg}/", body)
        print({k: r.get(k) for k in ("success", "new_contract", "msg", "error", "http", "body") if r.get(k) is not None})
    elif cmd == "status":
        i = instance(arg)
        print(i.get("actual_status"), "->", i.get("intended_status"), f"${i.get('dph_total', 0):.2f}/hr", base_url(i) or "(no address yet)")
    elif cmd == "config":
        url = base_url(instance(arg))
        if not url:
            sys.exit("no address yet; is it running?")
        model = "ripple-gpu:ricursiveai/ripple-65b-preview"
        print(json.dumps({
            "model": model,
            "providers": {"ripple-gpu": {"label": "Ripple on our B200", "baseURL": url, "keyEnv": "RIPPLE_GPU_API_KEY"}},
            "models": {model: {"context": 131072, "price": {"input": 0, "output": 0}}},
        }, indent=2))
    elif cmd in ("stop", "start"):
        print(call("PUT", f"/instances/{arg}/", {"state": "stopped" if cmd == "stop" else "running"}))
    elif cmd == "destroy":
        print(call("DELETE", f"/instances/{arg}/"))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    if len(sys.argv) < 2 or (sys.argv[1] not in ("offers", "whoami") and len(sys.argv) < 3):
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
