// Frozen public v1 parsers. Preserve accepted notation and defaults here.
// New syntax must not import these parsers. Execution and numeric geometry are shared.
const SCOPE = 'current-workspace-monitor';
const GEOMETRY = ['x', 'y', 'width', 'height'];
const CASCADE = ['width', 'height', 'offsetX', 'offsetY'];

function object(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !allowed.includes(key)))
        throw new Error(`Invalid ${label} fields`);
}

function integer(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${label} must be an integer from ${min} to ${max}`);
    return value;
}

function percentage(value, min = 0) {
    return typeof value === 'string' && /^(100|[0-9]{1,2})%$/.test(value) &&
        Number(value.slice(0, -1)) >= min;
}

function geometryValue(key, value, nullable) {
    if (nullable && value === null)
        return;
    const size = key === 'width' || key === 'height';
    if (percentage(value, size ? 1 : 0))
        return;
    if (!size && (key === 'x' ? ['left', 'center', 'middle', 'right'] :
        ['top', 'center', 'middle', 'bottom']).includes(value))
        return;
    integer(value, size ? 50 : -2147483647, 2147483647, key);
}

function tolerance(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 4096)
        throw new Error('Tolerance must be between 0 and 4096');
    return value;
}

export function parseJSON(json, limit = 65536) {
    if (typeof json !== 'string' || json.length > limit)
        throw new Error(`Expected a JSON string of at most ${limit} characters`);
    return JSON.parse(json);
}

function descriptor(value, condition = false) {
    object(value, ['target', 'monitor', 'layout', 'gap', ...GEOMETRY, 'offsetX', 'offsetY',
        ...(condition ? ['tolerance'] : ['bringToFront'])], 'placement');
    if (!['active', 'same-app'].includes(value.target))
        throw new Error('Target must be active or same-app');
    if (Object.hasOwn(value, 'bringToFront') &&
        (value.target !== 'active' || value.bringToFront !== 'same-app'))
        throw new Error('bringToFront must be same-app on an active action');
    if (Object.hasOwn(value, 'tolerance'))
        tolerance(value.tolerance);
    if (Object.hasOwn(value, 'monitor'))
        integer(value.monitor, 0, 2147483647, 'Monitor');
    if (value.target === 'active') {
        object(value, ['target', 'monitor', ...GEOMETRY, ...(condition ? ['tolerance'] : ['bringToFront'])], 'active');
        if (!Object.hasOwn(value, 'monitor') && !GEOMETRY.some(key => Object.hasOwn(value, key)))
            throw new Error('Active placement needs monitor or at least one geometry field');
        for (const key of GEOMETRY) {
            if (Object.hasOwn(value, key))
                geometryValue(key, value[key], !condition);
        }
        return {...value};
    }
    if (condition && !Object.hasOwn(value, 'layout') && Object.hasOwn(value, 'monitor')) {
        object(value, ['target', 'monitor', 'tolerance'], 'monitor condition');
        return {...value};
    }
    const layout = value.layout;
    if (typeof layout !== 'string' || !['grid', 'columns', 'rows', 'cascade'].includes(layout))
        throw new Error('Unknown layout');
    const fields = layout === 'cascade' ? [...CASCADE, 'gap'] : ['gap'];
    object(value, ['target', 'monitor', 'layout', ...fields, ...(condition ? ['tolerance'] : [])], layout);
    const gap = integer(value.gap ?? 12, 0, 4096, 'Gap');
    // Explicit null is invalid, whereas omitted options receive defaults.
    if (Object.hasOwn(value, 'gap'))
        integer(value.gap, 0, 4096, 'Gap');
    const result = {...value, gap};
    if (layout === 'cascade') {
        for (const [key, fallback] of Object.entries({width: '70%', height: '75%', offsetX: 40, offsetY: 40})) {
            const item = Object.hasOwn(value, key) ? value[key] : fallback;
            if (key.startsWith('offset'))
                integer(item, 0, 4096, key);
            else
                geometryValue(key, item, false);
            result[key] = item;
        }
    }
    return result;
}

export function parseRules(json) {
    const value = parseJSON(json);
    object(value, ['scope', 'tolerance', 'rules'], 'rule set');
    const scope = Object.hasOwn(value, 'scope') ? value.scope : SCOPE;
    if (scope !== SCOPE)
        throw new Error('Unsupported scope');
    const delta = tolerance(Object.hasOwn(value, 'tolerance') ? value.tolerance : 20);
    if (!Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 100)
        throw new Error('Expected 1 to 100 rules');
    const rules = value.rules.map(rule => {
        object(rule, ['when', 'then'], 'rule');
        return {
            when: Object.hasOwn(rule, 'when') ? descriptor(rule.when, true) : null,
            then: descriptor(rule.then),
        };
    });
    return {scope, tolerance: delta, rules};
}

export function parseArrangement(json) {
    const value = parseJSON(json, 4096);
    object(value, ['scope', 'layout', 'gap', ...CASCADE], 'arrangement');
    const {scope = SCOPE, layout = 'grid', ...options} = value;
    if (scope !== SCOPE)
        throw new Error('Unsupported scope');
    return descriptor({target: 'same-app', layout, ...options});
}

// Number-like strings are number
export function normalizeNullable(value) {
    if (value === null || value === 'null')
        return null;

    if (!isNaN(value))
        return Number(value);

    return value;
}

// positional vocabulary
export function resolvePosition(value, total, windowSize) {
    if (typeof value === 'number')
        return value;

    if (typeof value !== 'string')
        throw new Error(`Invalid position value: ${value}`);

    switch (value) {
        case 'left':
        case 'top':
            return 0;

        case 'center':
        case 'middle':
            return Math.floor((total - windowSize) / 2);

        case 'right':
        case 'bottom':
            return Math.max(0, total - windowSize);
    }

    if (value.endsWith('%')) {
        const n = parseInt(value, 10);
        if (!isNaN(n))
            return Math.floor((total - windowSize) * n / 100);
    }

    throw new Error(`Unknown position keyword: ${value}`);
}

// Size Vocabulary
export function resolveSize(value, total) {
    if (typeof value === 'number')
        return value;

    if (typeof value !== 'string')
        throw new Error(`Invalid size value: ${value}`);

    if (value.endsWith('%')) {
        const n = parseInt(value, 10);
        if (!isNaN(n))
            return Math.floor(total * n / 100);
    }

    if (!isNaN(value))
        return Number(value);

    throw new Error(`Unknown size value: ${value}`);
}

