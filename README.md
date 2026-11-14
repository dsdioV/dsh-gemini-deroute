# dsh-gemini-deroute

Rewrites the harness prompt fingerprints an upstream router matches on, and logs
every observation of the flash-lite fallback it is trying to avoid.

## Why

A Gemini flagship request (`gemini-4-hydrogen`) sent through a third-party
relay sometimes comes back served by `3.1-flash-lite-05-2026` instead — a cheaper
fallback node. The observable effect is shorter answers, no reasoning, and
poorer tool use. The evidence that this is prompt-driven rather than
traffic-driven comes from the switch that fixed it: a regex rewrite of the
system prompt in an intermediate gateway made the degradation stop, and turning
that rewrite off brought it back.

## What it does

**Rewrite.** Registers one unscoped `system-prompt/assemble` waterfall. After
the rest of the chain has assembled the prompt, it replaces five sentences this
harness emits verbatim on every deployment:

| id | source package | sentence |
|---|---|---|
| `file-reference` | `@deepseek-ai/dsh-file-reference` | `Tokens prefixed with @ are paths…` |
| `harness-checkout` | `@deepseek-ai/dsh-harness-dev-context` | `The runtime context names the DeepSeek-Harness implementation checkout.` |
| `web-surface` | `@deepseek-ai/dsh-harness-dev-context` | `You are interacting with the user through the DeepSeek-Harness Web GUI…` |
| `agent-teams` | `@deepseek-ai/dsh-experimental-tool-agent-team` | `Agent Teams is available in this session\n\nThe Team Lead and all teammates share…` |
| `harness-identity` | `@deepseek-ai/dsh-system-prompt` | `You are an AI agent powered by DeepSeek Harness.` |

Each replacement keeps the sentence's meaning and every tool or identifier name;
only the wording that is identical on every DSH deployment changes. The rewrite
applies only when the step's model matches `modelPattern` (default `gemini`), so
a DeepSeek or Claude session is unaffected.

**Observe.** Listens to `agent/assistant-stream` and reads the terminal
`finish` chunk's `replayState.response.responseModel` — the upstream's actual
model, which the harness's own log records per step. A response whose model
matches `flash-lite` while the requested model does not is logged at warn level
as `DEGRADED`; any other reroute is logged at info as `rerouted`.

## Why not retry

A degraded answer is an ordinary HTTP 200, so it never reaches
`agent/request-error` (that hook fires only for `finish.kind === 'error' |
'aborted'`). And the agent loop renders the prompt once per step, outside its
attempt loop, so a retry re-sends a byte-identical prompt — which gets a
byte-identical routing decision back. Retrying cannot change the outcome; only
changing the bytes can.

## Install

Install directly from GitHub in DeepSeek Harness (no npm registry needed):

```bash
dsh plugin --profile desktop add git+https://github.com/dsdioV/dsh-gemini-deroute.git
```

Or in the Web GUI / Plugin Manager, paste `github:dsdioV/dsh-gemini-deroute` or
`https://github.com/dsdioV/dsh-gemini-deroute`.

## Config

```yaml
- id: gemini-deroute
  name: dsh-gemini-deroute
  config:
    enabled: true          # master switch
    rewrite: true          # the fingerprint rewrite
    observe: true          # log every upstream reroute / degradation
    debug: false           # log each rewrite with byte counts
    modelPattern: 'gemini' # only rewrite for models matching this regex
```

`modelPattern` is compiled as a case-insensitive unanchored regular expression
(`new RegExp(modelPattern, 'i')`), so model names with channel or capability
suffixes (e.g. `gemini-4-hydrogen-单u1M支持工具` or
`gemini-4-hydrogen-xhigh-原生1M支持工具`) match out of the box. You only need
to change it if your custom model alias does not contain `gemini` at all (for
example, set `modelPattern: 'gemini|hydrogen'`).

## Verifying it works

Watch the host log for `[gemini-deroute]`. With `debug: true` each assembly logs
the sections and contexts it changed.

To confirm the rewrite reached the model, open the session's
`session.v4.jsonl.zstd` (a concatenation of zstd frames — decompress frame by
frame) and check the `system/message` event: it should contain `An at-sign at the
start of a token…` and no occurrence of `DeepSeek-Harness` or
`DeepSeek Harness`.

## Known limits

- Rewrite coverage is a whitelist. A sentence added upstream is not covered until
  it is added here.
- The observation hook cannot tell a deliberate model alias from a downgrade on
  any family except `flash-lite`; that is why the family test is anchored on
  both the requested and the answered model.
- Nothing here can affect a session already recording a degraded route: the
  rewrite changes future requests, not the conversation history already sent.
