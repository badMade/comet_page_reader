import createLogger from './logger.js';

const logger = createLogger({ name: 'cost-tracker' });

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
   */
  constructor(limitUsd = DEFAULT_LIMIT_USD, usage = undefined) {
    this.limitUsd = limitUsd;
    this.usage = usage || {
      totalCostUsd: 0,
      requests: [],
      lastReset: Date.now(),
    };
    logger.info('Cost tracker initialised.', {
      limitUsd: this.limitUsd,
      preloadedRequests: this.usage.requests.length,
      totalCostUsd: this.usage.totalCostUsd,
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
    const promptCost = (promptTokens / 1000) * (pricing.prompt || 0);
    const completionCost = (completionTokens / 1000) * (pricing.completion || 0);
    const amount = promptCost + completionCost;
    this.usage.totalCostUsd += amount;
    this.usage.requests.push({
      model,
      promptTokens,
      completionTokens,
      costUsd: amount,
      timestamp: Date.now(),
      ...metadata,
    });
    logger.info('Recorded token usage event.', {
      model,
      promptTokens,
      completionTokens,
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
    this.usage.totalCostUsd += amountUsd;
    this.usage.requests.push({
      model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: amountUsd,
      timestamp: Date.now(),
      ...metadata,
    });
    logger.info('Recorded flat usage event.', {
      model,
      amountUsd,
      totalCostUsd: this.usage.totalCostUsd,
    });
    return amountUsd;
  }

  /**
   * Resets accumulated usage and timestamps the reset moment for audit
   * purposes.
   */
  reset() {
    this.usage.totalCostUsd = 0;
    this.usage.requests = [];
    this.usage.lastReset = Date.now();
    logger.warn('Cost tracker reset invoked.', { timestamp: this.usage.lastReset });
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
  return new CostTracker(limitUsd, usage);
}

export { DEFAULT_LIMIT_USD, MODEL_PRICING };
