/**
 * Inactivity timeout: `signal` aborts once `touch()` has not been called for `stallMs`.
 * Long work that keeps reporting progress is never cut off; work that goes silent is.
 */
export class StallTimer {
	readonly #controller = new AbortController();
	readonly #stallMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(stallMs: number) {
		this.#stallMs = stallMs;
		this.touch();
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get stalled(): boolean {
		return this.#controller.signal.aborted;
	}

	/** record activity and restart the inactivity window */
	touch(): void {
		if (this.stalled) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#controller.abort(new DOMException(`No activity for ${this.#stallMs}ms`, "TimeoutError"));
		}, this.#stallMs);
	}

	/** stop the clock while waiting on work that enforces its own limits; the next `touch()` restarts it */
	pause(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	dispose(): void {
		this.pause();
	}
}
