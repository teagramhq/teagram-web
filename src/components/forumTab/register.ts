type RegisterEntry<ToCheck, Payload> = {
  check: (value: ToCheck) => boolean;
} & (
  | {payload: Payload}
  | {load: () => Promise<Payload>}
);

export class Register<ToCheck, Payload> {
  private entries: RegisterEntry<ToCheck, Payload>[] = [];

  addEntry(entry: RegisterEntry<ToCheck, Payload>): void {
    this.entries.push(entry);
  }

  private getEntryObject(value: ToCheck) {
    return this.entries.find(entry => entry.check(value));
  }

  hasEntryFor(value: ToCheck): boolean {
    return !!this.getEntryObject(value);
  }

  getEntry(value: ToCheck): Payload | undefined {
    const entry = this.getEntryObject(value);
    return entry && 'payload' in entry ? entry.payload : undefined;
  }

  async getEntryAsync(value: ToCheck): Promise<Payload | undefined> {
    const entry = this.getEntryObject(value);
    if(!entry) return;

    return 'load' in entry ? entry.load() : entry.payload;
  }
}
