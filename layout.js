// Pure validation, geometry and matching. No GNOME objects or side effects.
// New layouts belong here so conditions and actions always use the same plan.
export const MAX_WINDOWS = 100;
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
    object(value, ['target', 'layout', 'gap', ...GEOMETRY, 'offsetX', 'offsetY',
        ...(condition ? ['tolerance'] : [])], 'placement');
    if (!['active', 'same-app'].includes(value.target))
        throw new Error('Target must be active or same-app');
    if (Object.hasOwn(value, 'tolerance'))
        tolerance(value.tolerance);
    if (value.target === 'active') {
        object(value, ['target', ...GEOMETRY, ...(condition ? ['tolerance'] : [])], 'active');
        if (!GEOMETRY.some(key => Object.hasOwn(value, key)))
            throw new Error('Active placement needs at least one geometry field');
        for (const key of GEOMETRY) {
            if (Object.hasOwn(value, key))
                geometryValue(key, value[key], !condition);
        }
        return {...value};
    }
    const layout = value.layout;
    if (!Object.hasOwn(LAYOUTS, layout))
        throw new Error('Unknown layout');
    const fields = layout === 'cascade' ? [...CASCADE, 'gap'] : ['gap'];
    object(value, ['target', 'layout', ...fields, ...(condition ? ['tolerance'] : [])], layout);
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

export function resolveSize(value, total) {
    return typeof value === 'number' ? value : Math.floor(total * parseInt(value, 10) / 100);
}

export function resolvePosition(value, total, size) {
    if (typeof value === 'number')
        return value;
    switch (value) {
        case 'left': case 'top': return 0;
        case 'center': case 'middle': return Math.floor((total - size) / 2);
        case 'right': case 'bottom': return Math.max(0, total - size);
        default: return Math.floor((total - size) * parseInt(value, 10) / 100);
    }
}

export function planActive(action, rect, wa) {
    const width = action.width == null ? rect.width : resolveSize(action.width, wa.width);
    const height = action.height == null ? rect.height : resolveSize(action.height, wa.height);
    if (width < 50 || height < 50)
        throw new Error('Resolved size must be at least 50 pixels');
    const x = action.x == null ? rect.x : wa.x + resolvePosition(action.x, wa.width, width);
    const y = action.y == null ? rect.y : wa.y + resolvePosition(action.y, wa.height, height);
    return {x, y, width, height};
}

function grid(options, count, wa) {
    const columns = options.layout === 'rows' ? 1 :
        options.layout === 'columns' ? count : Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const width = wa.width - options.gap * (columns - 1);
    const height = wa.height - options.gap * (rows - 1);
    if (Math.floor(width / columns) < 50 || Math.floor(height / rows) < 50)
        throw new Error('Too many windows or too large a gap for this work area');
    return Array.from({length: count}, (_, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        const x = Math.floor(width * col / columns);
        const y = Math.floor(height * row / rows);
        return {x: wa.x + x + options.gap * col, y: wa.y + y + options.gap * row,
            width: Math.floor(width * (col + 1) / columns) - x,
            height: Math.floor(height * (row + 1) / rows) - y};
    });
}

function cascade(options, count, wa) {
    const width = resolveSize(options.width, wa.width);
    const height = resolveSize(options.height, wa.height);
    if (width < 50 || height < 50 || width > wa.width || height > wa.height)
        throw new Error('Cascade size must fit within the work area and be at least 50px');
    const slotsX = options.offsetX === 0 ? count : Math.floor((wa.width - width) / options.offsetX) + 1;
    const slotsY = options.offsetY === 0 ? count : Math.floor((wa.height - height) / options.offsetY) + 1;
    const slots = Math.min(count, slotsX, slotsY);
    return Array.from({length: count}, (_, i) => ({
        x: wa.x + (i % slots) * options.offsetX,
        y: wa.y + (i % slots) * options.offsetY, width, height,
    }));
}

const LAYOUTS = Object.freeze({grid, columns: grid, rows: grid, cascade});

export function planLayout(options, count, wa) {
    integer(count, 1, MAX_WINDOWS, 'Window count');
    return LAYOUTS[options.layout](options, count, wa);
}

export function matchesActive(condition, rect, wa, delta) {
    return GEOMETRY.every(key => {
        if (!Object.hasOwn(condition, key))
            return true;
        const expected = key === 'width' || key === 'height' ?
            resolveSize(condition[key], wa[key]) :
            wa[key] + resolvePosition(condition[key], wa[key === 'x' ? 'width' : 'height'],
                rect[key === 'x' ? 'width' : 'height']);
        return Math.abs(rect[key] - expected) <= delta;
    });
}

export function sameRect(a, b, delta = 0) {
    return GEOMETRY.every(key => Math.abs(a[key] - b[key]) <= delta);
}

// A one-to-one matching, not a greedy nearest-cell check. Overlapping tolerance
// ranges (and repeated cascade slots) must not assign two windows to one cell.
export function matchesLayout(rects, cells, delta) {
    if (rects.length !== cells.length || rects.length === 0)
        return false;
    const owners = Array(cells.length).fill(-1);
    const assign = (index, seen) => {
        for (let cell = 0; cell < cells.length; cell++) {
            if (seen.has(cell) || !sameRect(rects[index], cells[cell], delta))
                continue;
            seen.add(cell);
            if (owners[cell] === -1 || assign(owners[cell], seen)) {
                owners[cell] = index;
                return true;
            }
        }
        return false;
    };
    return rects.every((_, index) => assign(index, new Set()));
}
