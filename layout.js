// Pure validation, geometry and matching. No GNOME objects or side effects.
// New layouts belong here so conditions and actions always use the same plan.
export const MAX_WINDOWS = 100;
const GEOMETRY = ['x', 'y', 'width', 'height'];
function integer(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${label} must be an integer from ${min} to ${max}`);
    return value;
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

export function planActive(action, rect, wa, sourceArea = null) {
    const width = action.width == null ? rect.width : resolveSize(action.width, wa.width);
    const height = action.height == null ? rect.height : resolveSize(action.height, wa.height);
    if (width < 50 || height < 50)
        throw new Error('Resolved size must be at least 50 pixels');
    const keptX = sourceArea ? wa.x + Math.max(0, Math.min(rect.x - sourceArea.x, wa.width - width)) : rect.x;
    const keptY = sourceArea ? wa.y + Math.max(0, Math.min(rect.y - sourceArea.y, wa.height - height)) : rect.y;
    const x = action.x == null ? keptX : wa.x + resolvePosition(action.x, wa.width, width);
    const y = action.y == null ? keptY : wa.y + resolvePosition(action.y, wa.height, height);
    return validateRect({x, y, width, height});
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
    if (typeof options.layout !== 'string' || !Object.hasOwn(LAYOUTS, options.layout))
        throw new Error('Unknown layout');
    return LAYOUTS[options.layout](options, count, wa).map(rect => validateRect(rect));
}

// GJS marshals coordinates to signed 32-bit integers. Validate before any
// window is unmaximized or any undo entry is added, including computed edges.
export function validateRect(rect, minSize = 50) {
    for (const key of ['x', 'y'])
        integer(rect[key], -2147483648, 2147483647, key);
    for (const key of ['width', 'height'])
        integer(rect[key], minSize, 2147483647, key);
    integer(rect.x + rect.width, -2147483648, 2147483647, 'Right edge');
    integer(rect.y + rect.height, -2147483648, 2147483647, 'Bottom edge');
    return rect;
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
