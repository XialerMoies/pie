export interface DisconnectableObserver {
  disconnect(): void;
}

export class ObserverOwner {
  private current: DisconnectableObserver | null = null;

  replace(next: DisconnectableObserver): void {
    this.clear();
    this.current = next;
  }

  clear(): void {
    this.current?.disconnect();
    this.current = null;
  }
}
