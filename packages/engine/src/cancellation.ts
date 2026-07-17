/** Internal control-flow error used to stop an executing client request. */
export class CancellationError extends Error {
  constructor() {
    super('The request was canceled.')
    this.name = 'CancellationError'
  }
}

export type ExecutionControl = {
  readonly signal: AbortSignal,
  /** Test/custom scheduler hook; production defaults to one event-loop turn. */
  readonly yield_?: () => Promise<void>
}

const eventLoopTurn =
  (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Yields for inbound Attention processing, then throws if cancellation won. */
export const checkpoint =
  async (control: ExecutionControl): Promise<void> => {
    if (control.signal.aborted) {
      throw new CancellationError()
    }
    await (control.yield_?.() ?? eventLoopTurn())
    if (control.signal.aborted) {
      throw new CancellationError()
    }
  }
