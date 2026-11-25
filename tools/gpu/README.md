# Ripple on our own GPU (opt-in)

A Ripple-65B Preview endpoint we host ourselves with vLLM, on Modal (`ripple_vllm.py`) or on a rented Vast.ai B200 (`ripple_b200.py`). Nothing uses it unless you point a model at it: the default stays OpenRouter.

**Why:** measured on a B200 against OpenRouter for a realistic worker turn (`tools/gpu/bench.mjs`):

| | OpenRouter | Own B200 |
|---|---|---|
| One call at a time, median | 8.0 s (spikes to 32 s) | **1.4 to 4.8 s** |
| 4 calls at once | 6.0 s for all four | **3.6 to 4.9 s** |
| Time to first token | 0.6 s | **0.1 s** |
| Output speed | 25 to 47 tokens/s | **about 125 tokens/s** |
| Errors | bursts of 503 and 429 | none seen |

A swarm makes many short calls, so the per-call latency is most of a job's wall time.

## The server

Both scripts run the same vLLM setup (recipes.vllm.ai/ricursiveAI/Ripple-65B-Preview):

- **vLLM nightly image.** The `ripple` tool-call and reasoning parsers come from vLLM PR #65745. The 0.33 release doesn't have them (`invalid tool call parser: ripple`).
- **One B200** runs the official NVFP4 checkpoint (`Ripple-65B-Preview-NVFP4`, about 62 GB in GPU memory). Older GPUs on Modal (`RIPPLE_GPU=H100:2`) load BF16 and quantize to FP8.
- **The DFlash2 drafter** handles speculative decoding (7 tokens), with prefix caching on, so the shared system prompt and tool list are not recomputed every turn.
- **131K context** (`--max-model-len 131072`). Tell Senju so with `"context": 131072` under `models`, so it fits requests to that window.
- **Fails fast on Modal.** If vLLM exits, the container exits instead of holding a GPU until the startup timeout.

## Modal

```sh
modal secret create ripple-vllm VLLM_API_KEY=<random>              # the same value goes in RIPPLE_GPU_API_KEY
modal run tools/gpu/ripple_vllm.py::check                          # CPU only: does the image have the ripple parsers
RIPPLE_GPU=B200 modal run tools/gpu/ripple_vllm.py::download       # CPU only: weights into the ripple-cache volume
RIPPLE_GPU=B200 modal deploy tools/gpu/ripple_vllm.py              # prints https://<...>-ripple-vllm-b200-serve.modal.run
```

Modal bills only while a container runs, and scales to zero after 15 minutes idle. The first request after that waits for a cold start, and a B200 can take many minutes to be assigned (nothing bills meanwhile). Stop it: `modal app stop --yes ripple-vllm-b200`.

## Vast.ai

```sh
export RIPPLE_GPU_API_KEY=<random>
python3 tools/gpu/ripple_b200.py whoami          # check this is the account you mean to bill
python3 tools/gpu/ripple_b200.py offers          # about $7.50 to $12.50/hr
python3 tools/gpu/ripple_b200.py rent <offer>    # billing starts now; note the instance id
python3 tools/gpu/ripple_b200.py config <id>     # once running (about 7 min): the swarm.config.json lines
python3 tools/gpu/ripple_b200.py destroy <id>    # billing ends
```

Vast bills from rent until destroy, used or not. `stop` keeps the disk for about $0.05/hr, but someone else can take the GPU meanwhile.

## Point Senju at it

In `swarm.config.json` (the Modal URL plus `/v1`, or what `ripple_b200.py config` prints):

```json
"model": "ripple-gpu:ricursiveai/ripple-65b-preview",
"providers": { "ripple-gpu": { "label": "Ripple on our B200", "baseURL": "https://<...>.modal.run/v1", "keyEnv": "RIPPLE_GPU_API_KEY" } },
"models": { "ripple-gpu:ricursiveai/ripple-65b-preview": { "context": 131072, "price": { "input": 0, "output": 0 } } }
```

and give it the key as `RIPPLE_GPU_API_KEY`. The model keeps the Ripple profile (text only, tool calling, reasoning effort) because its id matches.

Measure: `RIPPLE_GPU_URL=<url>/v1 RIPPLE_GPU_API_KEY=... node tools/gpu/bench.mjs`, or with only `OPENROUTER_API_KEY` set for the OpenRouter baseline.
