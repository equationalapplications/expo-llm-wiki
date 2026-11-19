import type {
  ClassifyRequest,
  ClassifyResponse,
  WikiDiagnosticOperation,
  WikiDiagnosticTrigger,
  WikiOptions,
} from '../types';
import { emitDiagnostic } from './diagnostics';
import { estimateTokens, UsageMeter, WikiBudgetExhausted, type UsageRecord } from './usage';

export interface LlmCallContext {
  operation: WikiDiagnosticOperation;
  entityId: string;
  trigger: WikiDiagnosticTrigger;
  meter?: UsageMeter;
}

export function validUsage(u: unknown): u is { inputTokens: number; outputTokens: number } {
  if (!u || typeof u !== 'object') return false;
  const { inputTokens, outputTokens } = u as Record<string, unknown>;
  return [inputTokens, outputTokens].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

/**
 * The one place core calls the host's text model (spec §6.3). Pre-flights the
 * prompt estimate against the meter, prefers generateTextWithUsage, records
 * usage, and optionally reports it. Method-call syntax keeps `this` bound to
 * the provider.
 */
export async function callLlm(
  options: WikiOptions,
  ctx: LlmCallContext,
  prompts: { systemPrompt: string; userPrompt: string },
): Promise<string> {
  const promptEstimate = estimateTokens(prompts.systemPrompt) + estimateTokens(prompts.userPrompt);
  if (ctx.meter && !ctx.meter.fits(promptEstimate)) {
    throw new WikiBudgetExhausted(promptEstimate, ctx.meter.remaining);
  }

  const provider = options.llmProvider;
  const params = { systemPrompt: prompts.systemPrompt, userPrompt: prompts.userPrompt };
  let text: string;
  let reported: { inputTokens: number; outputTokens: number } | undefined;
  if (typeof provider.generateTextWithUsage === 'function') {
    const result = await provider.generateTextWithUsage(params);
    if (!result || typeof result.text !== 'string') {
      throw new TypeError('generateTextWithUsage() must resolve to { text: string, usage? }');
    }
    text = result.text;
    reported = validUsage(result.usage) ? result.usage : undefined;
  } else {
    text = await provider.generateText(params);
  }

  const record: UsageRecord = reported
    ? { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, estimated: false }
    : { inputTokens: promptEstimate, outputTokens: estimateTokens(text), estimated: true };
  ctx.meter?.record(record);

  if (options.config?.reportLlmUsage === true) {
    emitDiagnostic(options, {
      code: 'llm_usage',
      operation: ctx.operation,
      trigger: ctx.trigger,
      entityId: ctx.entityId,
      detail: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, estimated: record.estimated },
    });
  }
  return text;
}

/**
 * The one place core calls the host's classifier (errata E1). Wraps the
 * provider.classify call: pre-flights the input estimate against the meter,
 * records usage (reported when well-formed, estimated otherwise), and emits
 * llm_usage under reportLlmUsage. Every classify call site must go through
 * this wrapper.
 */
export async function callClassify(
  options: WikiOptions,
  ctx: LlmCallContext,
  request: ClassifyRequest,
): Promise<ClassifyResponse> {
  const inputEstimate =
    estimateTokens(request.state) + estimateTokens(JSON.stringify(request.questions));
  if (ctx.meter && !ctx.meter.fits(inputEstimate)) {
    throw new WikiBudgetExhausted(inputEstimate, ctx.meter.remaining);
  }

  const provider = options.llmProvider;
  if (typeof provider.classify !== 'function') {
    throw new TypeError('callClassify requires a provider with classify()');
  }
  const response = await provider.classify(request);

  const reported = validUsage(response?.usage) ? response.usage : undefined;
  const outputEstimate = estimateTokens(JSON.stringify(response?.answers ?? {}));
  const record: UsageRecord = reported
    ? { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, estimated: false }
    : { inputTokens: inputEstimate, outputTokens: outputEstimate, estimated: true };
  ctx.meter?.record(record);

  if (options.config?.reportLlmUsage === true) {
    emitDiagnostic(options, {
      code: 'llm_usage',
      operation: ctx.operation,
      trigger: ctx.trigger,
      entityId: ctx.entityId,
      detail: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, estimated: record.estimated },
    });
  }
  return response;
}
