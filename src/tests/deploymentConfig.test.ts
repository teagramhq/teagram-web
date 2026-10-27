import {describe, expect, it, vi} from 'vitest';
import {fetchTeagramDeploymentConfig, parseTeagramDeploymentConfig} from '@config/deploymentConfig';

describe('Teagram deployment config', () => {
  it('normalizes the configured host and enables only literal true', () => {
    expect(parseTeagramDeploymentConfig({server: ' DEMO.Teagram.io. ', autoGuest: true})).toEqual({
      server: 'demo.teagram.io',
      autoGuest: true
    });
    for(const autoGuest of [undefined, false, 'true', 1, null]) {
      expect(parseTeagramDeploymentConfig({server: 'demo.teagram.io', autoGuest}).autoGuest).toBe(false);
    }
  });

  it('treats a missing config file or an SPA HTML fallback as absent', async() => {
    await expect(fetchTeagramDeploymentConfig(async() => new Response('', {status: 404}))).resolves.toBeUndefined();
    await expect(fetchTeagramDeploymentConfig(async() => new Response('<!doctype html>', {
      headers: {'content-type': 'text/html'}
    }))).resolves.toBeUndefined();
  });

  it('rejects an invalid config, oversized document, and non-not-found server errors', async() => {
    expect(() => parseTeagramDeploymentConfig({server: 'https://demo.teagram.io', autoGuest: true})).toThrow();
    await expect(fetchTeagramDeploymentConfig(async() => new Response(' '.repeat(4097), {
      headers: {'content-type': 'application/json'}
    }))).rejects.toThrow('too large');
    await expect(fetchTeagramDeploymentConfig(async() => new Response('', {status: 503}))).rejects.toThrow('503');
  });

  it('cancels an oversized config stream before reading the rest of the body', async() => {
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if(pullCount++ === 0) controller.enqueue(new Uint8Array(4096));
        else if(pullCount === 2) controller.enqueue(new Uint8Array(1));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      }
    }, {highWaterMark: 0});
    const response = new Response(body, {headers: {'content-type': 'application/json'}});

    await expect(fetchTeagramDeploymentConfig(async() => response)).rejects.toThrow('too large');
    expect(pullCount).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('requests the runtime config without caching or following redirects', async() => {
    const fetcher = vi.fn(async() => new Response('{"server":"demo.teagram.io","autoGuest":true}', {
      headers: {'content-type': 'application/json'}
    }));

    await expect(fetchTeagramDeploymentConfig(fetcher)).resolves.toEqual({server: 'demo.teagram.io', autoGuest: true});
    expect(fetcher).toHaveBeenCalledWith('/teagram-config.json', expect.objectContaining({
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error'
    }));
  });
});
