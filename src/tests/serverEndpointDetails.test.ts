import {describe, expect, it} from 'vitest';
import {createServerEndpointBlock} from '@components/serverEndpointDetails';

describe('server endpoint details', () => {
  it('renders the exact advertised WSS destination as selectable text', () => {
    const endpoint = 'wss://edge.example.org:8443/apiws';
    const block = createServerEndpointBlock(document.createTextNode('Advertised WSS endpoint'), endpoint);
    const label = block.querySelector('p');
    const value = block.querySelector('code');

    expect(label?.textContent).toBe('Advertised WSS endpoint');
    expect(value?.textContent).toBe(endpoint);
    expect(value?.getAttribute('dir')).toBe('ltr');
    expect(block.querySelector('a')).toBeNull();
  });
});
