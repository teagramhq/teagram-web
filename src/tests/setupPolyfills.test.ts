describe('test environment polyfills', () => {
  test('installs typed array concatenation', () => {
    expect(new Uint8Array([1]).concat(new Uint8Array([2]))).toEqual(new Uint8Array([1, 2]));
  });
});
