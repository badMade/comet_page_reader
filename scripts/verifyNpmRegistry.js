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

  return new Promise((resolve, reject) => {
    const request = transport.request(target, { agent, method: 'GET' }, (response) => {
      const { statusCode = 0, statusMessage = '' } = response;

      if (statusCode >= 200 && statusCode < 400) {
        response.resume();
        resolve({ statusCode, statusMessage });
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        reject(new Error(`Unexpected response ${statusCode} ${statusMessage} from ${target.href}. Body: ${body}`));
      });
    });

    request.on('error', (error) => {
      reject(new Error(`Network error while contacting ${target.href}: ${error.message}`));
    });

    request.setTimeout(timeout, () => {
      request.destroy(new Error(`Timed out after ${timeout}ms while contacting ${target.href}`));
    });

    request.end();
  });
}

async function main() {
  try {
    const { registry, resource, timeout } = parseArguments(process.argv.slice(2));
    const target = resolveTarget(registry, resource);
    const agent = selectAgent(target);
    const { statusCode, statusMessage } = await verify(target, timeout, agent);

    const resultMessage = [`Successfully reached ${target.href}`];
    resultMessage.push(`status ${statusCode}`);
    if (statusMessage) {
      resultMessage.push(`(${statusMessage})`);
    }

    console.log(`${resultMessage.join(' ')}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

await main();

