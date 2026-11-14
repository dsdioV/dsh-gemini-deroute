/**
 * dsh-gemini-deroute — rewrite the harness prompt fingerprints that make an
 * upstream router answer a Gemini flagship request from a cheap flash-lite
 * node, and record every observation of that fallback.
 *
 * ## Why a rewrite and not a retry
 *
 * A degraded answer is an ordinary HTTP 200 with ordinary content, so it never
 * reaches `agent/request-error` — that hook fires only for
 * `finish.kind === 'error' | 'aborted'`. Worse, the agent loop renders the
 * system prompt ONCE per step, outside its `while (true)` attempt loop:
 *
 *     const renderedPrompt = renderPrompt(assembly)   // above the loop
 *     let firstAttempt = true
 *     while (true) { ... llm.stream(request) ... }
 *
 * So a retry re-sends a byte-identical prompt, and this upstream answers a
 * byte-identical prompt with a byte-identical routing decision. Retrying cannot
 * change the outcome; only changing the bytes can.
 *
 * ## Where the rewrite happens
 *
 * `system-prompt/assemble` is a waterfall that runs once per step, and its
 * result is what the loop renders into that single prompt. Rewriting section
 * and context text there is the only point that reaches the request without
 * mutating a deep-frozen one.
 *
 * ## What it rewrites
 *
 * Four sentences this harness emits verbatim and identically on every
 * deployment, which is exactly what makes them matchable upstream. Each
 * replacement preserves the meaning and every tool or identifier name; only the
 * fixed wording changes. See README.md for provenance.
 *
 * @module dsh-gemini-deroute
 */

/** Cordis plugin name. */
export const name = 'gemini-deroute'

/** The prompt registry this plugin contributes to. */
export const inject = ['systemPrompt']

/**
 * One fingerprint rewrite.
 *
 * `from` anchors on the leading clause and runs to the end of the sentence
 * group, because these sentences change in the middle across harness releases
 * (the file-reference guidance gained a clause; the Agent Teams policy gained
 * `interrupt_agent`). A byte-exact `from` would silently stop applying.
 */
const REWRITES = [
  {
    id: 'file-reference',
    // @deepseek-ai/dsh-file-reference — FILE_REFERENCE_PROMPT.
    from: /Tokens prefixed with @ are (?:workspace )?paths (?:that )?the user explicitly referenced[\s\S]*?quotes a path containing spaces\./g,
    to: 'An at-sign at the start of a token names a path the user deliberately pointed at. ' +
      'A relative path starts at the project root; an absolute one names a file or folder on this machine. ' +
      'A trailing slash means the target is a folder, so list it whenever its contents matter. ' +
      'Anything else is a file: reading it needs the read tool, and nothing may be said about what a path holds ' +
      'before it has actually been opened. A quoted form wraps a path that itself contains spaces.',
  },
  {
    id: 'harness-checkout',
    // @deepseek-ai/dsh-harness-dev-context — HARNESS_SOURCE_PROMPT.
    from: /The runtime context names the DeepSeek-Harness implementation checkout\.[\s\S]*?inspect or extend DSH itself\./g,
    to: 'The runtime context names the implementation checkout serving this session. ' +
      'The checkout location and the current working directory are separate values and may differ, ' +
      'so the working directory is never inferred from that path. Use pwd to determine the current ' +
      'working directory. Use this checkout only to inspect or extend the harness itself.',
  },
  {
    id: 'web-surface',
    // @deepseek-ai/dsh-harness-dev-context — WEB_SURFACE_PROMPT.
    from: /You are interacting with the user through the DeepSeek-Harness Web GUI[\s\S]*?verify that watcher before promising automatic updates\./g,
    to: 'The user is interacting through this harness Web GUI, whose URL the runtime context names. ' +
      'When the user says "this page", "this GUI", or "this app" without naming another target, ' +
      'they mean this GUI. The browser supplies no implicit DOM, route, or screenshot context. ' +
      'The client-plugin HMR receiver is active, but client-plugin changes reload without a page ' +
      'refresh only while the client bundle watcher runs from the same checkout; verify that ' +
      'watcher before promising automatic updates.',
  },
  {
    id: 'agent-teams',
    // @deepseek-ai/dsh-experimental-tool-agent-team — teamPolicy().
    from: /Agent Teams is available in this session\n\s*\nThe Team Lead and all teammates share the same working directory and filesystem\.[\s\S]*?Write-scope overlap is advisory, not a lock\./g,
    to: 'A team can run inside this session.\n\n' +
      'The Lead and every member work on one shared directory and one shared filesystem, so an edit ' +
      'one of them makes is instantly visible to the others. When spreading write work across ' +
      'members, give each a non-overlapping scope, note the expected scopes on the shared task ' +
      'records, and chain tasks through dependencies wherever order matters. Two members writing ' +
      'into the same scope are not blocked: that overlap is a warning to coordinate, not a mutex.',
  },
  {
    id: 'harness-identity',
    // @deepseek-ai/dsh-system-prompt — the fixed opening line (order -1000).
    // dsh 0.2.2-rc.3 replaced rc.2's "You are an AI coding assistant running
    // through an API relay" with this sentence, which names the product
    // outright. Measured at 48 bytes on rc.3.
    //
    // The model-naming sentence that follows it ("You are a coding agent powered
    // by the <model> model.") is generated per step with the live model id, so it
    // is not matched here: it is not a fixed fingerprint and rewriting it would
    // hide which model actually served the step.
    from: /You are an AI agent powered by DeepSeek Harness\./g,
    to: 'You are an AI coding agent serving this session.',
  },
]

/**
 * Same-name section replacements.
 *
 * `harness:source` and `app:web-surface` are registered BOTH as a section and
 * as a runtime context by @deepseek-ai/dsh-harness-dev-context. The context
 * copy is short (it carries the resolved checkout path / GUI URL) and is
 * re-resolved by `refreshContext()` after the assembly is accepted, so a
 * waterfall edit to it is discarded. The long sentences live on the SECTION,
 * which the waterfall does reach — but shadowing the section with the same
 * name in this plugin's own layer is more robust than matching its text,
 * because it does not depend on how the upstream words the sentence.
 */

const REPLACEMENT_SECTIONS = [
  {
    name: 'harness:source',
    orderName: 'HARNESS_SOURCE',
    text:
      'The runtime context names the implementation checkout serving this session. ' +
      'The checkout location and the current working directory are separate values and may differ, ' +
      'so the working directory is never inferred from that path. Use pwd to determine the current ' +
      'working directory. Use this checkout only to inspect or extend the harness itself.',
  },
  {
    name: 'app:web-surface',
    orderName: 'WEB_SURFACE',
    text:
      'The user is interacting through this harness Web GUI, whose URL the runtime context names. ' +
      'When the user says "this page", "this GUI", or "this app" without naming another target, ' +
      'they mean this GUI. The browser supplies no implicit DOM, route, or screenshot context. ' +
      'The client-plugin HMR receiver is active, but client-plugin changes reload without a page ' +
      'refresh only while the client bundle watcher runs from the same checkout; verify that ' +
      'watcher before promising automatic updates.',
  },
]

/**
 * The upstream fallback family a flagship request is degraded onto.
 *
 * Matched as a family, never as an exact id: the routed model carries a date
 * stamp (`3.1-flash-lite-05-2026`) that moves whenever the upstream rolls its
 * fallback. The guard on the REQUESTED model is what keeps this honest — a
 * caller who deliberately picked a lite model is not being degraded.
 */
const FALLBACK_FAMILY = /flash-lite/i

/** Rewrite every fingerprint occurrence in one piece of text. */
function rewriteText(text) {
  let out = text
  let hits = 0
  for (const rule of REWRITES) {
    rule.from.lastIndex = 0
    out = out.replace(rule.from, () => {
      hits += 1
      return rule.to
    })
  }
  return { text: out, hits }
}

/** Resolve the row config, tolerating a partial one. */
function resolveConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    rewrite: config.rewrite !== false,
    observe: config.observe !== false,
    debug: config.debug === true,
    modelPattern:
      typeof config.modelPattern === 'string' && config.modelPattern.length > 0
        ? new RegExp(config.modelPattern, 'i')
        : /gemini/i,
  }
}

/**
 * Install the rewrite waterfall and the fallback observer.
 * @param ctx - plugin context.
 * @param config - row config from the bundle patch.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const log = ctx.logger

  if (!resolved.enabled) {
    log.info('[gemini-deroute] disabled by config; nothing is rewritten or observed')
    return
  }

  if (resolved.rewrite) {
    // The waterfall is the last word on SECTION text: a section's text is
    // evaluated once per assembly, so rewriting it there reaches the request.
    ctx.effect(
      () => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const result = await next()
        const model = context?.modelSelection?.model
        if (typeof model === 'string' && model.length > 0 && !resolved.modelPattern.test(model)) {
          return result
        }
        let total = 0
        for (const section of result.sections) {
          if (typeof section.text !== 'string' || section.text.length === 0) continue
          const { text, hits } = rewriteText(section.text)
          if (hits === 0) continue
          if (resolved.debug) {
            log.info('[gemini-deroute] section %s: %d occurrence(s), %d -> %d bytes', section.name, hits, section.text.length, text.length)
          }
          section.text = text
          total += hits
        }
        if (resolved.debug && total > 0) log.info('[gemini-deroute] rewrote %d occurrence(s) in sections', total)
        return result
      }),
      'gemini-deroute: prompt section rewrite',
    )

    // Same-scope registrations succeed the global ones, and duplicates are
    // rejected only WITHIN one layer, so this is how a replacement wins instead
    // of colliding.
    ctx.effect(
      () => {
        const disposers = []
        for (const repl of REPLACEMENT_SECTIONS) {
          try {
            disposers.push(
              ctx.systemPrompt.section({
                name: repl.name,
                order: ctx.systemPrompt.getSectionOrder(repl.orderName),
                interpolate: false,
                text: repl.text,
              }),
            )
          } catch (error) {
            // A section of the same name already lives in THIS layer, which is
            // where @deepseek-ai/dsh-harness-dev-context mounts on the host
            // plane. Shadowing cannot win a same-layer collision, so report it
            // and let the text-matching rule below cover the sentence instead.
            log.warn(
              '[gemini-deroute] cannot shadow section %s (%s); falling back to text matching',
              repl.name,
              error && error.message ? error.message : String(error),
            )
          }
        }
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      },
      'gemini-deroute: prompt section replacement',
    )

    log.info('[gemini-deroute] fingerprint rewrite active for models matching %s', String(resolved.modelPattern))
  }
  if (resolved.observe) {
    // The only place the upstream's actual model reaches a listener: the adapter
    // attaches it to the terminal `finish` chunk's replayState, and every chunk
    // is published verbatim by AssistantStreamAttempt.push().
    let degradedSteps = 0
    let reroutedSteps = 0
    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type !== 'finish') return
      const response = chunk.replayState?.response
      const actual = response?.responseModel
      if (typeof actual !== 'string' || actual.length === 0) return
      const requested = response?.model
      const degraded =
        FALLBACK_FAMILY.test(actual) && !FALLBACK_FAMILY.test(String(requested ?? ''))
      if (degraded) {
        degradedSteps += 1
        log.warn(
          '[gemini-deroute] DEGRADED: %s answered by %s (fallback family); degraded steps so far: %d',
          String(requested), actual, degradedSteps,
        )
      } else {
        reroutedSteps += 1
        log.info(
          '[gemini-deroute] rerouted: %s answered by %s (not the fallback family); reroutes so far: %d',
          String(requested), actual, reroutedSteps,
        )
      }
    })
    log.info('[gemini-deroute] fallback observation active')
  }
}

export default { name, inject, apply }