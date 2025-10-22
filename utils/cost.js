import createLogger from './logger.js';

const logger = createLogger({ name: 'cost-tracker' });

/**
 * Default monthly token limit enforced by the extension when tracking API
 * usage. The figure is intentionally conservative and roughly mirrors the
 * previous USD-based ceiling when converted using the legacy exchange rate
 * defined in {@link LEGACY_TOKENS_PER_USD}.
 */
const DEFAULT_TOKEN_LIMIT = 18000;

/** Default number of completion tokens assumed when estimating usage. */
const DEFAULT_COMPLETION_TOKEN_ESTIMATE = 400;

/**
 * Conversion rate used for translating legacy USD totals into token estimates.
 * The ratio favours caution so that existing budgets remain protective after
 * migrating to the token model.
 */
const LEGACY_TOKENS_PER_USD = 3000;

const MODEL_COMPLETION_OVERRIDES = Object.freeze({
  'gemini-1.5-flash': 350,
  'gemini-1.5-flash-latest': 350,
  'gemini-1.5-pro': 600,
  'gemini-1.5-pro-latest': 600,
  'gpt-4o-mini': 450,
});

function normaliseTimestamp(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function toInteger(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed));
    }
  }
  return fallback;
}

function cloneRequestMetadata(entry = {}) {
  return Object.entries(entry).reduce((acc, [key, value]) => {
    if (['model', 'promptTokens', 'completionTokens', 'totalTokens', 'timestamp', 'excludedFromLimit'].includes(key)) {
      return acc;
    }
    if (key === 'costUsd' && typeof value === 'number' && Number.isFinite(value)) {
      acc.legacyCostUsd = value;
      return acc;
    }
    acc[key] = value;
    return acc;
  }, {});
}

/**
 * Converts a USD figure into an approximate token count using the legacy
 * exchange rate. The result is deliberately rounded to an integer.
 *
 * @param {number} amountUsd - Legacy USD value.
 * @returns {number} Estimated token count.
 */
export function estimateTokensFromUsd(amountUsd) {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(amountUsd * LEGACY_TOKENS_PER_USD));
}

/**
 * Provides a conservative token estimate for the supplied text. Mirrors the
 * logic used by the cost tracker so that other modules can reuse the same
 * heuristic without needing an instantiated tracker.
 *
 * @param {string} text - Input text.
 * @returns {number} Estimated token count.
 */
export function estimateTokensFromText(text) {
  if (!text) {
    logger.trace('Estimating tokens for empty text.');
    return 0;
  }
  const words = String(text).trim().split(/\s+/).length;
  return Math.max(1, Math.round(words * 1.3));
}

function normaliseRequest(entry = {}) {
  const promptTokens = toInteger(entry.promptTokens, 0);
  const completionTokens = toInteger(entry.completionTokens, 0);
  let totalTokens = toInteger(entry.totalTokens, promptTokens + completionTokens);
  const excludedFromLimit = entry.excludedFromLimit === true;
  if (excludedFromLimit && totalTokens === 0) {
    totalTokens = promptTokens + completionTokens;
  }
  const metadata = cloneRequestMetadata(entry);
  const timestamp = normaliseTimestamp(entry.timestamp);
  const model = typeof entry.model === 'string' && entry.model ? entry.model : null;
  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    timestamp,
    excludedFromLimit,
    ...metadata,
  };
}

function sumTokens(requests, selector) {
  return requests.reduce((acc, request) => acc + selector(request), 0);
}

function deriveCompletionEstimate(model) {
  if (typeof model === 'string' && MODEL_COMPLETION_OVERRIDES[model]) {
    return MODEL_COMPLETION_OVERRIDES[model];
  }
  return DEFAULT_COMPLETION_TOKEN_ESTIMATE;
}

function deriveUsageTotals(requests) {
  const included = requests.filter(request => !request.excludedFromLimit);
  return {
    prompt: sumTokens(included, request => request.promptTokens || 0),
    completion: sumTokens(included, request => request.completionTokens || 0),
    total: sumTokens(included, request => request.totalTokens || 0),
  };
}

function deriveCumulativeTotals(requests) {
  return {
    prompt: sumTokens(requests, request => request.promptTokens || 0),
    completion: sumTokens(requests, request => request.completionTokens || 0),
    total: sumTokens(requests, request => request.totalTokens || 0),
  };
}

function normaliseUsageSnapshot(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const requests = Array.isArray(usage.requests) ? usage.requests.map(normaliseRequest) : [];
  const totals = deriveUsageTotals(requests);
  const cumulativeTotals = deriveCumulativeTotals(requests);
  let totalPromptTokens = toInteger(usage.totalPromptTokens, totals.prompt);
  let totalCompletionTokens = toInteger(usage.totalCompletionTokens, totals.completion);
  let totalTokens = toInteger(usage.totalTokens, totals.total);
  const cumulativePromptTokens = toInteger(
    usage.cumulativePromptTokens,
    cumulativeTotals.prompt,
  );
  const cumulativeCompletionTokens = toInteger(
    usage.cumulativeCompletionTokens,
    cumulativeTotals.completion,
  );
  const cumulativeTotalTokens = toInteger(
    usage.cumulativeTotalTokens,
    cumulativeTotals.total,
  );
  const metadata = { ...usage.metadata };

  if (typeof usage.totalCostUsd === 'number' && Number.isFinite(usage.totalCostUsd)) {
    const legacyTokenEstimate = estimateTokensFromUsd(usage.totalCostUsd);
    if (totalTokens === 0 && legacyTokenEstimate > 0) {
      totalTokens = legacyTokenEstimate;
    }
    metadata.legacyTotalCostUsd = usage.totalCostUsd;
    metadata.legacyTokenEstimate = legacyTokenEstimate;
  }

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    cumulativePromptTokens,
    cumulativeCompletionTokens,
    cumulativeTotalTokens,
    requests,
    lastReset: normaliseTimestamp(usage.lastReset),
    metadata,
  };
}

/**
 * Tracks AI provider usage across multiple API calls to enforce a configurable
 * token ceiling. The tracker records every request for display in the popup UI.
 */
export class CostTracker {
  /**
   * Constructs a cost tracker instance with an optional pre-populated usage
   * snapshot.
   *
   * @param {number} [limitTokens=DEFAULT_TOKEN_LIMIT] - Token ceiling.
   * @param {object} [usage] - Previously persisted usage state.
   */
  constructor(limitTokens = DEFAULT_TOKEN_LIMIT, usage = undefined) {
    this.limitTokens = Number.isFinite(limitTokens) && limitTokens >= 0
      ? Math.round(limitTokens)
      : DEFAULT_TOKEN_LIMIT;
    this.usage = normaliseUsageSnapshot(usage) || {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      cumulativePromptTokens: 0,
      cumulativeCompletionTokens: 0,
      cumulativeTotalTokens: 0,
      requests: [],
      lastReset: Date.now(),
      metadata: {},
    };
    this.syncCumulativeMetadata();
    logger.info('Cost tracker initialised.', {
      limitTokens: this.limitTokens,
      preloadedRequests: this.usage.requests.length,
      totalTokens: this.usage.totalTokens,
    });
  }

  syncCumulativeMetadata() {
    if (!this.usage.metadata || typeof this.usage.metadata !== 'object') {
      this.usage.metadata = {};
    }
    this.usage.metadata.cumulativePromptTokens = this.usage.cumulativePromptTokens;
    this.usage.metadata.cumulativeCompletionTokens = this.usage.cumulativeCompletionTokens;
    this.usage.metadata.cumulativeTotalTokens = this.usage.cumulativeTotalTokens;
  }

  /**
   * Determines whether the requested amount can be spent without breaching the
   * configured token ceiling.
   *
   * @param {number} tokens - Additional token usage.
   * @returns {boolean} True when the spend is permitted.
   */
  canSpend(tokens) {
    const additional = toInteger(tokens, 0);
    const allowed = this.limitTokens === 0
      ? additional === 0
      : this.limitTokens < 0
        ? true
        : this.usage.totalTokens + additional <= this.limitTokens;
    logger.debug('Cost tracker spend check.', {
      tokens: additional,
      currentTotal: this.usage.totalTokens,
      limitTokens: this.limitTokens,
      allowed,
    });
    return allowed;
  }

  /**
   * Records a usage event for a token-based model and accumulates the
   * calculated token totals.
   *
   * @param {string} model - Model identifier.
   * @param {number} promptTokens - Tokens submitted in the request.
   * @param {number} completionTokens - Tokens returned by the response.
   * @param {Object} [metadata={}] - Additional contextual information.
   * @returns {number} Total tokens recorded for the event.
   */
  record(model, promptTokens, completionTokens, metadata = {}) {
    const safePrompt = toInteger(promptTokens, 0);
    const safeCompletion = toInteger(completionTokens, 0);
    const totalTokens = safePrompt + safeCompletion;
    const cleanedMetadata = { ...metadata };
    const excluded = cleanedMetadata.excludedFromLimit === true;
    delete cleanedMetadata.promptTokens;
    delete cleanedMetadata.completionTokens;
    delete cleanedMetadata.totalTokens;
    delete cleanedMetadata.excludedFromLimit;
    const entry = {
      model: typeof model === 'string' ? model : null,
      promptTokens: safePrompt,
      completionTokens: safeCompletion,
      totalTokens,
      timestamp: Date.now(),
      excludedFromLimit: excluded,
      ...cleanedMetadata,
    };
    this.usage.requests.push(entry);
    this.usage.cumulativePromptTokens += safePrompt;
    this.usage.cumulativeCompletionTokens += safeCompletion;
    this.usage.cumulativeTotalTokens += totalTokens;
    if (!excluded) {
      this.usage.totalPromptTokens += safePrompt;
      this.usage.totalCompletionTokens += safeCompletion;
      this.usage.totalTokens += totalTokens;
    }
    this.syncCumulativeMetadata();
    logger.info('Recorded token usage event.', {
      model,
      promptTokens: safePrompt,
      completionTokens: safeCompletion,
      totalTokens,
      excludedFromLimit: excluded,
      totalUsageTokens: this.usage.totalTokens,
    });
    return totalTokens;
  }

  /**
   * Records a usage event for models that bill on a flat-fee basis such as
   * speech synthesis and transcription.
   *
   * @param {string} model - Logical model group to attribute the tokens to.
   * @param {number|object} descriptor - Token count or descriptor object.
   * @param {Object} [metadata={}] - Additional contextual metadata.
   * @returns {number} Recorded token total.
   */
  recordFlat(model, descriptor, metadata = {}) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let excludedFromLimit = false;
    let extraMetadata = {};

    if (typeof descriptor === 'number' && Number.isFinite(descriptor)) {
      totalTokens = toInteger(descriptor, 0);
    } else if (descriptor && typeof descriptor === 'object') {
      promptTokens = toInteger(descriptor.promptTokens, 0);
      completionTokens = toInteger(descriptor.completionTokens, 0);
      totalTokens = toInteger(descriptor.totalTokens, promptTokens + completionTokens);
      excludedFromLimit = descriptor.excludedFromLimit === true;
      extraMetadata = descriptor.metadata && typeof descriptor.metadata === 'object'
        ? descriptor.metadata
        : {};
    }

    if (totalTokens > 0 && promptTokens + completionTokens === 0) {
      completionTokens = totalTokens;
    }

    if (totalTokens === 0 && !excludedFromLimit) {
      excludedFromLimit = true;
    }

    const entryMetadata = {
      ...extraMetadata,
      ...metadata,
    };

    if (excludedFromLimit) {
      entryMetadata.excludedFromLimit = true;
      if (!entryMetadata.exclusionReason) {
        entryMetadata.exclusionReason = 'no-token-estimate';
      }
    }

    return this.record(model, promptTokens, completionTokens, {
      totalTokens,
      excludedFromLimit,
      ...entryMetadata,
    });
  }

  /**
   * Resets accumulated usage and timestamps the reset moment for audit
   * purposes.
   */
  reset() {
    this.usage.totalPromptTokens = 0;
    this.usage.totalCompletionTokens = 0;
    this.usage.totalTokens = 0;
    this.usage.cumulativePromptTokens = 0;
    this.usage.cumulativeCompletionTokens = 0;
    this.usage.cumulativeTotalTokens = 0;
    this.usage.requests = [];
    this.usage.lastReset = Date.now();
    this.usage.metadata = {};
    this.syncCumulativeMetadata();
    logger.warn('Cost tracker reset invoked.', { timestamp: this.usage.lastReset });
  }

  /**
   * Provides a rough token estimate based on the word count. Used for
   * projecting tokens when a provider does not return usage data.
   *
   * @param {string} text - Input text.
   * @returns {number} Estimated token count.
   */
  estimateTokensFromText(text) {
    return estimateTokensFromText(text);
  }

  /**
   * Estimates the token usage for generating a summary when only the source
   * text is known.
   *
   * @param {string} model - Model identifier used for overrides.
   * @param {string} text - Source text that will be summarised.
   * @param {number} [responseLength] - Expected completion length in tokens.
   * @returns {{promptTokens: number, completionTokens: number, totalTokens: number}}
   *   Estimated token breakdown.
   */
  estimateTokenUsage(model, text, responseLength = undefined) {
    const promptTokens = this.estimateTokensFromText(text);
    const completionTokens = toInteger(
      responseLength,
      deriveCompletionEstimate(model),
    );
    const totalTokens = promptTokens + completionTokens;
    logger.debug('Estimated tokens for text.', {
      model,
      promptTokens,
      completionTokens,
      totalTokens,
    });
    return { promptTokens, completionTokens, totalTokens };
  }

  /**
   * Serialises the tracker state so it can be persisted.
   *
   * @returns {Object} Plain JSON representation of the usage snapshot.
   */
  toJSON() {
    logger.trace('Serialising cost tracker snapshot.', {
      requestCount: this.usage.requests.length,
      totalTokens: this.usage.totalTokens,
    });
    const tokens = {
      prompt: this.usage.totalPromptTokens,
      completion: this.usage.totalCompletionTokens,
      total: this.usage.totalTokens,
      lastReset: this.usage.lastReset,
    };
    return {
      ...this.usage,
      limitTokens: this.limitTokens,
      tokens,
    };
  }

  /**
   * Returns the most recent token totals that count towards the configured
   * limit. This snapshot mirrors the values displayed in the popup usage panel.
   *
   * @returns {{promptTokens: number, completionTokens: number, totalTokens: number}}
   *   Aggregated token usage.
   */
  getUsageTotals() {
    return {
      promptTokens: this.usage.totalPromptTokens,
      completionTokens: this.usage.totalCompletionTokens,
      totalTokens: this.usage.totalTokens,
    };
  }

  /**
   * Provides cumulative token totals including entries marked as excluded from
   * the enforcement limit. Useful for long-term analytics and reporting.
   *
   * @returns {{promptTokens: number, completionTokens: number, totalTokens: number}}
   *   Lifetime token usage snapshot.
   */
  getCumulativeTotals() {
    return {
      promptTokens: this.usage.cumulativePromptTokens,
      completionTokens: this.usage.cumulativeCompletionTokens,
      totalTokens: this.usage.cumulativeTotalTokens,
    };
  }
}

/**
 * Factory helper used by the service worker to create a tracker instance.
 *
 * @param {number} limitTokens - Token limit.
 * @param {Object} [usage] - Pre-populated usage state.
 * @returns {CostTracker} Configured tracker instance.
 */
export function createCostTracker(limitTokens, usage) {
  logger.debug('Creating cost tracker via factory.', {
    limitTokens,
    hasUsage: Boolean(usage),
  });
  const usageSnapshot = usage && typeof usage === 'object'
    ? { ...usage }
    : usage;
  return new CostTracker(limitTokens, usageSnapshot);
}

export { DEFAULT_TOKEN_LIMIT };
