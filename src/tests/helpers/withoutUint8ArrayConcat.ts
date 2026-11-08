export default async function withoutUint8ArrayConcat<T>(run: () => Promise<T>) {
  const concatDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'concat');
  delete (Uint8Array.prototype as any).concat;

  try {
    return await run();
  } finally {
    if(concatDescriptor) Object.defineProperty(Uint8Array.prototype, 'concat', concatDescriptor);
  }
}
