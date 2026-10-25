// One entry per public operation. Window references live only while undoable.
export class OperationHistory {
    constructor(limit = 20) {
        this._limit = limit;
        this._entries = [];
        this._signals = new Map();
    }

    get size() {
        return this._entries.length;
    }

    push(entry) {
        if (!entry.length)
            return;
        this._entries.push(entry);
        if (this._entries.length > this._limit)
            this._entries.shift();
        this._syncSignals();
    }

    pop() {
        const entry = this._entries.pop() ?? [];
        this._syncSignals();
        return entry;
    }

    forget(win) {
        this._entries = this._entries.map(entry => entry.filter(state => state.win !== win))
            .filter(entry => entry.length);
        this._syncSignals();
    }

    clear() {
        this._entries = [];
        this._syncSignals();
    }

    _syncSignals() {
        const retained = new Set(this._entries.flatMap(entry => entry.map(state => state.win)));
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
