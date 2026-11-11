export function createServerEndpointBlock(labelText: Node, endpoint: string) {
  const block = document.createElement('div');
  block.className = 'server-picker__endpoint-group';

  const label = document.createElement('p');
  label.className = 'server-picker__endpoint-label';
  label.append(labelText);

  const value = document.createElement('code');
  value.className = 'server-picker__endpoint';
  value.dir = 'ltr';
  value.textContent = endpoint;

  block.append(label, value);
  return block;
}
