export type Job<T> = () => Promise<T>;

export class JobQueue {
  private current: Promise<unknown> = Promise.resolve();

  public enqueue<T>(job: Job<T>): Promise<T> {
    const next = this.current.then(() => job(), () => job());
    this.current = next.catch(() => {});
    return next;
  }
}
