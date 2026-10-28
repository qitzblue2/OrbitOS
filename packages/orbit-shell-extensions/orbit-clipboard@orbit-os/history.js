// Clipboard history model (no Shell imports: unit-tested with node/gjs).
export const MAX_TEXT = 100000;           // ignore huge copies (logs, files)
export const SECRET_HINTS = ['x-kde-passwordManagerHint', 'application/x-keepassxc-secret'];

export function looksSecret(mimetypes) {
    return mimetypes.some(m => SECRET_HINTS.includes(m));
}

export class History {
    constructor(limit = 50) {
        this.limit = limit;
        this.items = [];   // newest first: {text, pinned, time}
    }

    add(text, now = Date.now()) {
        if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT)
            return false;
        const old = this.items.find(i => i.text === text);
        this.items = this.items.filter(i => i.text !== text);
        this.items.unshift({text, pinned: old?.pinned ?? false, time: now});
        this._trim();
        return true;
    }

    _trim() {
        // pinned items never fall off; drop the oldest unpinned ones beyond the limit
        let unpinned = 0;
        this.items = this.items.filter(i => i.pinned || ++unpinned <= this.limit);
    }

    togglePin(text) {
        const it = this.items.find(i => i.text === text);
        if (it)
            it.pinned = !it.pinned;
        this._trim();
    }

    remove(text) {
        this.items = this.items.filter(i => i.text !== text);
    }

    clear(keepPinned = true) {
        this.items = keepPinned ? this.items.filter(i => i.pinned) : [];
    }

    search(q) {
        const s = q.trim().toLowerCase();
        const list = s ? this.items.filter(i => i.text.toLowerCase().includes(s)) : this.items;
        return [...list.filter(i => i.pinned), ...list.filter(i => !i.pinned)];
    }

    serialize(includeUnpinned) {
        return JSON.stringify(this.items.filter(i => includeUnpinned || i.pinned));
    }

    load(json) {
        try {
            const arr = JSON.parse(json);
            if (Array.isArray(arr))
                this.items = arr.filter(i => typeof i?.text === 'string').map(i => ({text: i.text, pinned: !!i.pinned, time: i.time ?? 0}));
        } catch {}
        this._trim();
    }
}

export function preview(text, n = 90) {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
