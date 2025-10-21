import createLogger from './logger.js';

const logger = createLogger({ name: 'cost-tracker' });

function normaliseNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function normaliseUsageSnapshot(snapshot) {
  const now = Date.now();
  const base = {
    totalCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: [],
    lastReset: now,
  };

  if (!snapshot || typeof snapshot !== 'object') {
    return base;
  }

  const usage = {
    ...base,
    ...snapshot,
  };

  usage.totalCostUsd = normaliseNumber(snapshot.totalCostUsd, base.totalCostUsd);
  usage.promptTokens = normaliseNumber(snapshot.promptTokens, base.promptTokens);
  usage.completionTokens = normaliseNumber(snapshot.completionTokens, base.completionTokens);
  usage.totalTokens = normaliseNumber(
    snapshot.totalTokens,
    usage.promptTokens + usage.completionTokens,
  );
  usage.lastReset = normaliseNumber(snapshot.lastReset, base.lastReset);
  usage.requests = Array.isArray(snapshot.requests) ? snapshot.requests.map(request => ({ ...request })) : [];

  return usage;
}

/**
 * Cost tracking helpers shared by the background worker and popup UI.
 *
 * @module utils/cost
 */

/**
 * Default monthly spending limit enforced by the extension when tracking API
 * usage. The value is intentionally conservative to provide safe defaults for
 * new users.
 */
const DEFAULT_LIMIT_USD = 5;

/**
 * Pricing table expressed in USD per 1K tokens for prompt and completion usage
 * alongside flat rates used by speech subsystems.
 */
const MODEL_PRICING = {
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'gpt-4o-realtime-preview': { prompt: 0.0005, completion: 0.0015 },
  'gpt-4o-audio-preview': { prompt: 0.00025, completion: 0.001 },
  'gemini-pro': { prompt: 0.0005, completion: 0.0015 },
  'gemini-1.0-pro': { prompt: 0.0005, completion: 0.0015 },
  'gemini-1.5-pro': { prompt: 0.0035, completion: 0.0105 },
  'gemini-1.5-pro-latest': { prompt: 0.0035, completion: 0.0105 },
  'gemini-1.5-flash': { prompt: 0.00035, completion: 0.00105 },
  'gemini-1.5-flash-latest': { prompt: 0.00035, completion: 0.00105 },
  stt: { prompt: 0.0002, completion: 0 },
  tts: { prompt: 0.0004, completion: 0 },
};

/**
 * Tracks AI provider usage across multiple API calls to enforce a configurable cost
 * ceiling. The tracker records every request for display in the popup UI.
 */
export class CostTracker {
  /**
   * Constructs a cost tracker instance with an optional pre-populated usage
   * snapshot.
   *
   * @param {number} [limitUsd=DEFAULT_LIMIT_USD] - Spending ceiling in USD.
   * @param {object} [usage] - Previously persisted usage state.
   * @param {number} [usage.totalCostUsd] - The total accumulated cost in USD.
   * @param {Array<object>} [usage.requests] - A list of recorded API requests.
   * @param {number} [usage.lastReset] - Timestamp of the last usage reset.
   * @param {number} [usage.promptTokens] - Aggregated prompt tokens consumed.
   * @param {number} [usage.completionTokens] - Aggregated completion tokens consumed.
   * @param {number} [usage.totalTokens] - Aggregated total tokens consumed.
   */
  constructor(limitUsd = DEFAULT_LIMIT_USD, usage = undefined) {
    this.limitUsd = limitUsd;
    this.usage = usage ? normaliseUsageSnapshot(usage) : normaliseUsageSnapshot();
    logger.info('Cost tracker initialised.', {
      limitUsd: this.limitUsd,
      preloadedRequests: this.usage.requests.length,
      totalCostUsd: this.usage.totalCostUsd,
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
    });
  }

  /**
   * Determines whether the requested amount can be spent without breaching the
   * configured cost ceiling.
   *
   * @param {number} amountUsd - Additional cost in USD.
   * @returns {boolean} True when the spend is permitted.
   */
  canSpend(amountUsd) {
    const allowed = this.usage.totalCostUsd + amountUsd <= this.limitUsd;
    logger.debug('Cost tracker spend check.', {
      amountUsd,
      currentTotal: this.usage.totalCostUsd,
      limitUsd: this.limitUsd,
      allowed,
    });
    return allowed;
  }

  /**
   * Records a usage event for a token-based model and accumulates the
   * calculated cost.
   *
   * @param {string} model - Model identifier used for lookup in MODEL_PRICING.
   * @param {number} promptTokens - Tokens submitted in the request.
   * @param {number} completionTokens - Tokens returned by the response.
   * @param {Object} [metadata={}] - Additional contextual information.
   * @returns {number} USD amount recorded for the event.
   */
  record(model, promptTokens, completionTokens, metadata = {}) {
    const pricing = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini'];
    const safePromptTokens = normaliseNumber(promptTokens);
    const safeCompletionTokens = normaliseNumber(completionTokens);
    const promptCost = (safePromptTokens / 1000) * (pricing.prompt || 0);
    const completionCost = (safeCompletionTokens / 1000) * (pricing.completion || 0);
    const amount = promptCost + completionCost;
    this.usage.totalCostUsd += amount;
    this.usage.promptTokens += safePromptTokens;
    this.usage.completionTokens += safeCompletionTokens;
    this.usage.totalTokens = this.usage.promptTokens + this.usage.completionTokens;
    this.usage.requests.push({
      model,
      promptTokens: safePromptTokens,
      completionTokens: safeCompletionTokens,
      totalTokens: safePromptTokens + safeCompletionTokens,
      costUsd: amount,
      timestamp: Date.now(),
      ...metadata,
    });
    logger.info('Recorded token usage event.', {
      model,
      promptTokens: safePromptTokens,
      completionTokens: safeCompletionTokens,
      totalPromptTokens: this.usage.promptTokens,
      totalCompletionTokens: this.usage.completionTokens,
      totalTokens: this.usage.totalTokens,
      amount,
      totalCostUsd: this.usage.totalCostUsd,
    });
    return amount;
  }

  /**
   * Records a usage event for models that bill on a flat-fee basis such as
   * speech synthesis and transcription.
   *
   * @param {string} model - Logical model group to attribute the cost to.
   * @param {number} amountUsd - Flat USD amount spent.
   * @param {Object} [metadata={}] - Additional contextual metadata.
   * @returns {number} Recorded USD amount.
   */
  recordFlat(model, amountUsd, metadata = {}) {
    const safeAmount = normaliseNumber(amountUsd);
    this.usage.totalCostUsd += safeAmount;
    this.usage.totalTokens = this.usage.promptTokens + this.usage.completionTokens;
    this.usage.requests.push({
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: safeAmount,
      timestamp: Date.now(),
      ...metadata,
    });
    logger.info('Recorded flat usage event.', {
      model,
      amountUsd: safeAmount,
      totalCostUsd: this.usage.totalCostUsd,
    });
    return safeAmount;
  }

  /**
   * Resets accumulated usage and timestamps the reset moment for audit
   * purposes.
   */
  reset() {
    this.usage.totalCostUsd = 0;
    this.usage.promptTokens = 0;
    this.usage.completionTokens = 0;
    this.usage.totalTokens = 0;
    this.usage.requests = [];
    this.usage.lastReset = Date.now();
    logger.warn('Cost tracker reset invoked.', { timestamp: this.usage.lastReset });
  }

  /**
   * Retrieves aggregate usage totals without mutating state.
   *
   * @returns {{
   *   totalCostUsd: number,
   *   promptTokens: number,
   *   completionTokens: number,
   *   totalTokens: number,
   * }}
   */
  getUsageTotals() {
    return {
      totalCostUsd: this.usage.totalCostUsd,
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
      totalTokens: this.usage.totalTokens,
    };
  }

  /**
   * Retrieves the cumulative cost in USD.
   *
   * @returns {number}
   */
  getTotalCostUsd() {
    return this.usage.totalCostUsd;
  }

  /**
   * Retrieves the cumulative prompt tokens consumed.
   *
   * @returns {number}
   */
  getTotalPromptTokens() {
    return this.usage.promptTokens;
  }

  /**
   * Retrieves the cumulative completion tokens consumed.
   *
   * @returns {number}
   */
  getTotalCompletionTokens() {
    return this.usage.completionTokens;
  }

  /**
   * Retrieves the cumulative total tokens consumed.
   *
   * @returns {number}
   */
  getTotalTokens() {
    return this.usage.totalTokens;
  }

  /**
   * Provides a rough token estimate based on the word count. Used for
   * projecting costs when a provider does not return token usage data.
   *
   * @param {string} text - Input text.
   * @returns {number} Estimated token count.
   */
  estimateTokensFromText(text) {
    if (!text) {
      logger.trace('Estimating tokens for empty text.');
      return 0;
    }
    const words = text.trim().split(/\s+/).length;
    return Math.max(1, Math.round(words * 1.3));
  }

  /**
   * Estimates the cost for generating a summary when only the source text is
   * known.
   *
   * @param {string} model - Model identifier used for pricing lookup.
   * @param {string} text - Source text that will be summarised.
   * @param {number} [responseLength=400] - Expected completion length in tokens.
   * @returns {number} Estimated USD amount.
   */
  estimateCostForText(model, text, responseLength = 400) {
    const promptTokens = this.estimateTokensFromText(text);
    const completionTokens = responseLength;
    const pricing = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini'];
    const estimatedCost = (
      (promptTokens / 1000) * (pricing.prompt || 0) +
      (completionTokens / 1000) * (pricing.completion || 0)
    );
    logger.debug('Estimated cost for text.', {
      model,
      promptTokens,
      completionTokens,
      estimatedCost,
    });
    return estimatedCost;
  }

  /**
   * Serialises the tracker state so it can be persisted.
   *
   * @returns {Object} Plain JSON representation of the usage snapshot.
   */
  toJSON() {
    logger.trace('Serialising cost tracker snapshot.', {
      requestCount: this.usage.requests.length,
      totalCostUsd: this.usage.totalCostUsd,
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
      totalTokens: this.usage.totalTokens,
    });
    return { ...this.usage, limitUsd: this.limitUsd };
  }
}

/**
 * Factory helper used by the service worker to create a tracker instance.
 *
 * @param {number} limitUsd - Spending limit.
 * @param {Object} [usage] - Pre-populated usage state.
 * @returns {CostTracker} Configured tracker instance.
 */
export function createCostTracker(limitUsd, usage) {
  logger.debug('Creating cost tracker via factory.', {
    limitUsd,
    hasUsage: Boolean(usage),
  });
  const snapshot = usage ? normaliseUsageSnapshot(usage) : undefined;
  return new CostTracker(limitUsd, snapshot);
}

export { DEFAULT_LIMIT_USD, MODEL_PRICING };
