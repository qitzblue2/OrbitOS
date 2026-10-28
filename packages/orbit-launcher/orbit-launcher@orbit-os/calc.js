// Tiny safe arithmetic evaluator (no eval): + - * / % ^ parentheses, decimals.
export function evaluate(src) {
    const s = src.replace(/\s+/g, '').replace(/,/g, '.');
    if (!/^[0-9.+\-*/%^()]+$/.test(s) || !/[0-9]/.test(s) || !/[+\-*/%^]/.test(s))
        return null;
    let i = 0;
    const peek = () => s[i];
    const num = () => {
        const m = /^\d*\.?\d+/.exec(s.slice(i));
        if (!m) throw new Error('number');
        i += m[0].length;
        return parseFloat(m[0]);
    };
    const atom = () => {
        if (peek() === '(') {
            i++;
            const v = expr();
            if (s[i++] !== ')') throw new Error(')');
            return v;
        }
        if (peek() === '-') { i++; return -atom(); }
        return num();
    };
    const pow = () => {
        const b = atom();
        if (peek() === '^') { i++; return b ** pow(); }
        return b;
    };
    const term = () => {
        let v = pow();
        while ('*/%'.includes(peek() ?? 'x')) {
            const op = s[i++], r = pow();
            v = op === '*' ? v * r : op === '/' ? v / r : v % r;
        }
        return v;
    };
    const expr = () => {
        let v = term();
        while ('+-'.includes(peek() ?? 'x')) {
            const op = s[i++], r = term();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    };
    try {
        const v = expr();
        return i === s.length && Number.isFinite(v) ? Math.round(v * 1e10) / 1e10 : null;
    } catch {
        return null;
    }
}
