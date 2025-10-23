/**
 * CLI utility that verifies connectivity to the configured npm registry. The
 * script honours proxy environment variables and reports HTTP status codes for
 * diagnostics.
 *
 * @module scripts/verifyNpmRegistry
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

import createLogger, { createCorrelationId, loadLoggingConfig, setGlobalContext, withCorrelation } from '../utils/logger.js';
import { createCliCorrelationId, registerCliErrorHandlers } from './cliProcessHandlers.js';

const scriptName = 'verify-npm-registry';
const logger = createLogger({ name: scriptName, component: 'cli', context: { script: scriptName } });
setGlobalContext({ script: scriptName });
registerCliErrorHandlers(logger, {
  scriptName,
  uncaughtExceptionMessage: 'Fatal uncaught exception while verifying npm registry.',
  unhandledRejectionMessage: 'Fatal unhandled rejection while verifying npm registry.',
});

function parseArguments(rawArgs) {
  let registry = process.env.NPM_REGISTRY_URL ?? 'https://registry.npmjs.org/';
  let resource = 'xmlchars/';
  let timeout = Number.parseInt(process.env.NPM_REGISTRY_TIMEOUT_MS ?? '10000', 10);

  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];

    if (argument === '--registry' && rawArgs[index + 1]) {
      registry = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (argument === '--resource' && rawArgs[index + 1]) {
      resource = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (argument === '--timeout' && rawArgs[index + 1]) {
      timeout = Number.parseInt(rawArgs[index + 1], 10);
      index += 1;
      continue;
    }

    if (!argument.startsWith('--')) {
      resource = argument;
    }
  }

  return {
    registry,
    resource,
    timeout,
  };
}

function resolveTarget(registry, resource) {
  try {
    return new URL(resource, registry);
  } catch (error) {
    throw new Error(`Unable to resolve registry URL from registry "${registry}" and resource "${resource}": ${error.message}`);
  }
}

function selectAgent(target) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

  if (!proxyUrl) {
    return undefined;
  }

  try {
    if (target.protocol === 'http:') {
      return new HttpProxyAgent(proxyUrl);
    }

    return new HttpsProxyAgent(proxyUrl);
  } catch (error) {
    throw new Error(`Failed to configure proxy from "${proxyUrl}": ${error.message}`);
  }
}

function selectTransport(protocol) {
  if (protocol === 'http:') {
    return http;
  }

  if (protocol === 'https:') {
    return https;
  }

  throw new Error(`Unsupported protocol: ${protocol}`);
}

function verify(target, timeout, agent) {
  const transport = selectTransport(target.protocol);
  const correlationId = createCorrelationId('verify-request');
  const correlationMeta = withCorrelation(correlationId);

  return new Promise((resolve, reject) => {
    logger.debug('Initiating registry verification request.', {
      target: target.href,
      timeout,
      usingProxy: Boolean(agent),
      ...correlationMeta,
    });
    const request = transport.request(target, { agent, method: 'GET' }, (response) => {
      const { statusCode = 0, statusMessage = '' } = response;

      if (statusCode >= 200 && statusCode < 400) {
        response.resume();
        logger.debug('Received successful response from registry.', { statusCode, statusMessage, ...correlationMeta });
        resolve({ statusCode, statusMessage });
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        logger.warn('Unexpected response while verifying registry.', {
          statusCode,
          statusMessage,
          body,
          target: target.href,
          ...correlationMeta,
        });
        reject(new Error(`Unexpected response ${statusCode} ${statusMessage} from ${target.href}. Body: ${body}`));
      });
    });

    request.on('error', (error) => {
      logger.error('Network error while verifying registry.', { error, target: target.href, ...correlationMeta });
      reject(new Error(`Network error while contacting ${target.href}: ${error.message}`));
    });

    request.setTimeout(timeout, () => {
      logger.warn('Registry verification request timed out.', { timeout, target: target.href, ...correlationMeta });
      request.destroy(new Error(`Timed out after ${timeout}ms while contacting ${target.href}`));
    });

    request.end();
  });
}

async function main() {
  try {
    await loadLoggingConfig().catch(() => {});
    const { registry, resource, timeout } = parseArguments(process.argv.slice(2));
    const target = resolveTarget(registry, resource);
    const agent = selectAgent(target);
    logger.info('Verifying npm registry reachability.', {
      registry: target.href,
      timeout,
      usingProxy: Boolean(agent),
    });
    const { statusCode, statusMessage } = await verify(target, timeout, agent);

    const resultMessage = [`Successfully reached ${target.href}`];
    resultMessage.push(`status ${statusCode}`);
    if (statusMessage) {
      resultMessage.push(`(${statusMessage})`);
    }

    await logger.info(resultMessage.join(' ') + '.', {
      registry: target.href,
      statusCode,
      statusMessage,
    });
  } catch (error) {
    await logger.error('Registry verification failed.', { error });
    process.exitCode = 1;
  }
}

const run = logger.wrapAsync(main, () => ({
  logger,
  component: logger.component,
  ...withCorrelation(createCliCorrelationId('verify-run', { scriptName })),
  errorMessage: null,
}));

await run();

