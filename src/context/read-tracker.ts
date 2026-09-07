export interface ReadRecord {
  path: string;
  mtimeMs: number;
  hash: string;
}

export interface ReadTracker {
  recordRead(record: ReadRecord): void;
  getRead(path: string): ReadRecord | undefined;
}

export class InMemoryReadTracker implements ReadTracker {
  private readonly records = new Map<string, ReadRecord>();

  recordRead(record: ReadRecord): void {
    this.records.set(record.path, record);
  }

  getRead(path: string): ReadRecord | undefined {
    return this.records.get(path);
  }
}
