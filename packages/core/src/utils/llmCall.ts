import type {
  ClassifyRequest,
  ClassifyResponse,
  WikiDiagnosticOperation,
  WikiDiagnosticTrigger,
  WikiOptions,
} from '../types';
import { emitDiagnostic } from './diagnostics';
import { estimateTokens, UsageMeter, type UsageRecord } from './usage';

/**
 * Output allowance held for a classify call beyond its input estimate. A
 * `choice` answer echoes a probability per option (`ClassifierAnswer`), so the
 * output is of the order of the question's own size, which the input estimate
 * includes. Same precedent as RESOLVE_RESERVE_FACTOR. Admission still tests
 * the estimate alone (specs/meter-reservation §1, §3).
 */
export const CLASSIFY_HOLD_FACTOR = 2;

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
 * The one place core calls the host's text model (spec §6.3). Reserves the
 * prompt estimate on the meter, prefers generateTextWithUsage, settles real
 * usage (releases on failure), and optionally reports it. Method-call syntax keeps `this` bound to
 * the provider.
 */
export async function callLlm(
  options: WikiOptions,
  ctx: LlmCallContext,
  prompts: { systemPrompt: string; userPrompt: string },
): Promise<string> {
  const promptEstimate = estimateTokens(prompts.systemPrompt) + estimateTokens(prompts.userPrompt);
  const provider = options.llmProvider;
  const params = { systemPrompt: prompts.systemPrompt, userPrompt: prompts.userPrompt };
  let text: string;
  let record: UsageRecord;
  const reservation = ctx.meter?.reserve(promptEstimate);
  try {
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
    record = reported
      ? { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, estimated: false }
      : { inputTokens: promptEstimate, outputTokens: estimateTokens(text), estimated: true };
  } catch (err) {
    if (ctx.meter && reservation) ctx.meter.release(reservation);
    throw err;
  }
  if (ctx.meter && reservation) ctx.meter.settle(reservation, record);

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
 * provider.classify call: reserves the input estimate (with a hold) on the meter,
 * settles usage (reported when well-formed, estimated otherwise; releases on failure), and emits
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
  const provider = options.llmProvider;
  let response: ClassifyResponse;
  let record: UsageRecord;
  const reservation = ctx.meter?.reserve(inputEstimate, inputEstimate * CLASSIFY_HOLD_FACTOR);
  try {
    if (typeof provider.classify !== 'function') {
      throw new TypeError('callClassify requires a provider with classify()');
    }
    response = await provider.classify(request);

    const reported = validUsage(response?.usage) ? response.usage : undefined;
    const outputEstimate = estimateTokens(JSON.stringify(response?.answers ?? {}));
    record = reported
      ? { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, estimated: false }
      : { inputTokens: inputEstimate, outputTokens: outputEstimate, estimated: true };
  } catch (err) {
    if (ctx.meter && reservation) ctx.meter.release(reservation);
    throw err;
  }
  if (ctx.meter && reservation) ctx.meter.settle(reservation, record);

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
