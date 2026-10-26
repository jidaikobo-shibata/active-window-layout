// One entry per public operation. An arrangement keeps its full stacking snapshot
// until geometry restoration and the final stacking pass have both completed.
export class OperationHistory {
    constructor(limit = 20) {
        this._limit = limit;
        this._entries = [];
        this._signals = new Map();
    }

    get size() {
        return this._entries.length;
    }

    push(states) {
        if (!states.length)
            return;
        this._entries.push({states: [...states], stacking: states.filter(state => state.restoreStack)});
        if (this._entries.length > this._limit)
            this._entries.shift();
        this._syncSignals();
    }

    peekOperation() {
        return this._entries.at(-1) ?? null;
    }

    peek() {
        return [...(this.peekOperation()?.states ?? [])];
    }

    has(operation) {
        return this._entries.includes(operation);
    }

    consume(operation, state, restored) {
        if (!this.has(operation))
            return;
        operation.states = operation.states.filter(item => item !== state);
        // A skipped target (e.g. manually moved to another workspace) must not
        // be raised later when the rest of the operation is retried.
        if (!restored)
            operation.stacking = operation.stacking.filter(item => item !== state);
        this._prune();
    }

    skipStackState(operation, state) {
        operation.stacking = operation.stacking.filter(item => item !== state);
        this._prune();
    }

    completeStack(operation) {
        operation.stacking = [];
        this._prune();
    }

    forget(win) {
        for (const operation of this._entries) {
            operation.states = operation.states.filter(state => state.win !== win);
            operation.stacking = operation.stacking.filter(state => state.win !== win);
        }
        this._prune();
    }

    clear() {
        this._entries = [];
        this._syncSignals();
    }

    _prune() {
        this._entries = this._entries.filter(operation =>
            operation.states.length || operation.stacking.length);
        this._syncSignals();
    }

    _syncSignals() {
        const retained = new Set(this._entries.flatMap(operation =>
            [...operation.states, ...operation.stacking].map(state => state.win)));
        for (const [win, id] of this._signals) {
            if (!retained.has(win)) {
                win.disconnect(id);
                this._signals.delete(win);
            }
        }
        for (const win of retained) {
            if (!this._signals.has(win))
                this._signals.set(win, win.connect('unmanaged', () => this.forget(win)));
        }
    }
}
