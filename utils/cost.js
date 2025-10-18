const DEFAULT_LIMIT_USD = 5;

const MODEL_PRICING = {
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'gpt-4o-realtime-preview': { prompt: 0.0005, completion: 0.0015 },
  'gpt-4o-audio-preview': { prompt: 0.00025, completion: 0.001 },
  stt: { prompt: 0.0002, completion: 0 },
  tts: { prompt: 0.0004, completion: 0 },
};

export class CostTracker {
  constructor(limitUsd = DEFAULT_LIMIT_USD, usage = undefined) {
    this.limitUsd = limitUsd;
    this.usage = usage || {
      totalCostUsd: 0,
      requests: [],
      lastReset: Date.now(),
    };
  }

  canSpend(amountUsd) {
    return this.usage.totalCostUsd + amountUsd <= this.limitUsd;
  }

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
    return amount;
  }

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
    return amountUsd;
  }

  reset() {
    this.usage.totalCostUsd = 0;
    this.usage.requests = [];
    this.usage.lastReset = Date.now();
  }

  estimateTokensFromText(text) {
    if (!text) {
      return 0;
    }
    const words = text.trim().split(/\s+/).length;
    return Math.max(1, Math.round(words * 1.3));
  }

  estimateCostForText(model, text, responseLength = 400) {
    const promptTokens = this.estimateTokensFromText(text);
    const completionTokens = responseLength;
    const pricing = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini'];
    return (
      (promptTokens / 1000) * (pricing.prompt || 0) +
      (completionTokens / 1000) * (pricing.completion || 0)
    );
  }

  toJSON() {
    return { ...this.usage, limitUsd: this.limitUsd };
  }
}

export function createCostTracker(limitUsd, usage) {
  return new CostTracker(limitUsd, usage);
}

export { DEFAULT_LIMIT_USD, MODEL_PRICING };
