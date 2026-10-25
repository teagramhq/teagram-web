import {normalizeServerHost} from '@config/serverSelection';

export const DEPLOYMENT_CONFIG_PATH = '/teagram-config.json';
export const DEPLOYMENT_CONFIG_MAX_BYTES = 4096;

export type TeagramDeploymentConfig = {
  server: string,
  autoGuest: boolean
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseTeagramDeploymentConfig(value: unknown): TeagramDeploymentConfig {
  if(!isRecord(value) || typeof value.server !== 'string') {
    throw new Error('Invalid Teagram deployment configuration');
  }

  return {
    server: normalizeServerHost(value.server),
    autoGuest: value.autoGuest === true
  };
}

export async function fetchTeagramDeploymentConfig(fetcher: typeof fetch = fetch): Promise<TeagramDeploymentConfig | undefined> {
  let response: Response;
  try {
    response = await fetcher(DEPLOYMENT_CONFIG_PATH, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {accept: 'application/json'}
    });
  } catch(error) {
    throw Object.assign(new Error('Could not load Teagram deployment configuration'), {cause: error});
  }

  if(response.status === 404 || (response.ok && /\btext\/html\b/i.test(response.headers.get('content-type') || ''))) {
    return undefined;
  }
  if(!response.ok) throw new Error(`Teagram deployment configuration failed (${response.status})`);

  const declaredLength = Number(response.headers.get('content-length'));
  if(Number.isFinite(declaredLength) && declaredLength > DEPLOYMENT_CONFIG_MAX_BYTES) {
    throw new Error('Teagram deployment configuration is too large');
  }

  const body = await response.text();
  if(new TextEncoder().encode(body).byteLength > DEPLOYMENT_CONFIG_MAX_BYTES) {
    throw new Error('Teagram deployment configuration is too large');
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch(error) {
    throw Object.assign(new Error('Teagram deployment configuration is invalid JSON'), {cause: error});
  }
  return parseTeagramDeploymentConfig(value);
}
