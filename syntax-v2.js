// Strict versioned syntax. This module never imports the compatibility parsers.
// It produces descriptors consumed by the shared planner, not GNOME mutations.
const GEOMETRY = ['x', 'y', 'width', 'height'];
const LAYOUTS = ['grid', 'columns', 'rows', 'cascade'];
const SCOPE = 'current-workspace-monitor';

function fail(path, message) {
    throw new Error(`${path}: ${message}`);
}

function fields(value, allowed, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(path, 'expected an object');
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key))
            fail(`${path}.${key}`, 'unknown field');
    }
}

function integer(value, min, max, path) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        fail(path, `expected an integer from ${min} to ${max}`);
    return value;
}

function tolerance(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 4096)
        fail(path, 'expected a number from 0 to 4096');
    return value;
}

function geometry(value, path) {
    fields(value, GEOMETRY, path);
    if (!Object.keys(value).length)
        fail(path, 'expected at least one geometry field');
    for (const [key, item] of Object.entries(value)) {
        const size = key === 'width' || key === 'height';
        const keywords = key === 'x' ? ['left', 'center', 'right'] : ['top', 'center', 'bottom'];
        if (!size && keywords.includes(item))
            continue;
        if (typeof item === 'string' && item.trim() === item &&
            /^(100|[0-9]{1,2})%$/.test(item) &&
            (!size || Number(item.slice(0, -1)) >= 1))
            continue;
        integer(item, size ? 50 : -2147483648, 2147483647, `${path}.${key}`);
    }
    return {...value};
}

function layout(value, path) {
    fields(value, ['type', 'gap', 'width', 'height', 'offsetX', 'offsetY'], path);
    if (!LAYOUTS.includes(value.type))
        fail(`${path}.type`, 'expected grid, columns, rows or cascade');
    if (value.type !== 'cascade') {
        fields(value, ['type', 'gap'], path);
        return {layout: value.type, gap: Object.hasOwn(value, 'gap') ?
            integer(value.gap, 0, 4096, `${path}.gap`) : 12};
    }
    fields(value, ['type', 'width', 'height', 'offsetX', 'offsetY'], path);
    const sizes = geometry({width: value.width ?? '70%', height: value.height ?? '75%'}, path);
    // Explicit null must never silently select a default.
    for (const key of ['width', 'height']) {
        if (Object.hasOwn(value, key) && value[key] === null)
            fail(`${path}.${key}`, 'null is not supported; omit the field for its default');
    }
    return {layout: 'cascade', ...sizes,
        offsetX: Object.hasOwn(value, 'offsetX') ? integer(value.offsetX, 0, 4096, `${path}.offsetX`) : 40,
        offsetY: Object.hasOwn(value, 'offsetY') ? integer(value.offsetY, 0, 4096, `${path}.offsetY`) : 40};
}

function selection(value, path) {
    if (value !== 'active' && value !== 'same-app')
        fail(path, 'expected active or same-app');
    return value;
}

function condition(value, path) {
    fields(value, ['select', 'geometry', 'layout', 'monitor', 'tolerance'], path);
    const target = selection(value.select, `${path}.select`);
    const result = {target};
    if (Object.hasOwn(value, 'monitor'))
        result.monitor = integer(value.monitor, 0, 2147483647, `${path}.monitor`);
    if (Object.hasOwn(value, 'tolerance'))
        result.tolerance = tolerance(value.tolerance, `${path}.tolerance`);
    if (Object.hasOwn(value, 'geometry')) {
        if (target !== 'active')
            fail(`${path}.geometry`, 'only active selection supports geometry');
        Object.assign(result, geometry(value.geometry, `${path}.geometry`));
    }
    if (Object.hasOwn(value, 'layout')) {
        if (target !== 'same-app')
            fail(`${path}.layout`, 'only same-app selection supports a layout');
        Object.assign(result, layout(value.layout, `${path}.layout`));
    }
    if (!Object.hasOwn(value, 'monitor') && !Object.hasOwn(value, 'geometry') && !Object.hasOwn(value, 'layout'))
        fail(path, 'expected a monitor, geometry or layout condition');
    return result;
}

function action(value, path) {
    fields(value, ['select', 'geometry', 'layout', 'monitor', 'stacking'], path);
    const target = selection(value.select, `${path}.select`);
    const result = {target};
    if (Object.hasOwn(value, 'monitor'))
        result.monitor = integer(value.monitor, 0, 2147483647, `${path}.monitor`);
    if (Object.hasOwn(value, 'geometry')) {
        if (target !== 'active')
            fail(`${path}.geometry`, 'only active selection supports geometry');
        Object.assign(result, geometry(value.geometry, `${path}.geometry`));
    }
    if (Object.hasOwn(value, 'layout')) {
        if (target !== 'same-app')
            fail(`${path}.layout`, 'only same-app selection supports a layout');
        Object.assign(result, layout(value.layout, `${path}.layout`));
    }
    if (Object.hasOwn(value, 'stacking')) {
        if (target !== 'active' || value.stacking !== 'same-app')
            fail(`${path}.stacking`, 'expected same-app on an active action');
        result.bringToFront = 'same-app';
    }
    if (target === 'same-app' && !Object.hasOwn(value, 'layout'))
        fail(`${path}.layout`, 'same-app actions require a layout');
    if (target === 'active' && !['geometry', 'monitor', 'stacking'].some(key => Object.hasOwn(value, key)))
        fail(path, 'expected geometry, monitor or stacking');
    return result;
}

export function parse(json) {
    if (typeof json !== 'string' || json.length > 65536)
        fail('$', 'expected a JSON string of at most 65536 characters');
    let value;
    try {
        value = JSON.parse(json);
    } catch {
        fail('$', 'invalid JSON');
    }
    fields(value, ['version', 'scope', 'tolerance', 'rules'], '$');
    if (value.version !== 2)
        fail('version', 'expected 2');
    if (Object.hasOwn(value, 'scope') && value.scope !== SCOPE)
        fail('scope', `expected ${SCOPE}`);
    const delta = Object.hasOwn(value, 'tolerance') ? tolerance(value.tolerance, 'tolerance') : 20;
    if (!Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 100)
        fail('rules', 'expected 1 to 100 rules');
    const warnings = [];
    let fallback = false;
    const rules = value.rules.map((rule, index) => {
        const path = `rules[${index}]`;
        fields(rule, ['when', 'then'], path);
        if (fallback)
            warnings.push({path, message: 'unreachable after an unconditional rule'});
        const when = Object.hasOwn(rule, 'when') ? condition(rule.when, `${path}.when`) : null;
        if (!when)
            fallback = true;
        return {when, then: action(rule.then, `${path}.then`)};
    });
    return {scope: SCOPE, tolerance: delta, rules, warnings};
}

export function validate(json) {
    try {
        return {valid: true, warnings: parse(json).warnings};
    } catch (error) {
        return {valid: false, error: error.message, warnings: []};
    }
}
