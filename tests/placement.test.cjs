// Run with: node tests/placement.test.cjs
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {test} = require('node:test');
const vm = require('node:vm');

const layoutSource = readFileSync(`${__dirname}/../layout.js`, 'utf8').replace(/^export /gm, '');
const historySource = readFileSync(`${__dirname}/../history.js`, 'utf8').replace(/^export /gm, '');
const layoutContext = {};
vm.runInNewContext(`${layoutSource}\nthis.api = {MAX_WINDOWS, parseRules, parseArrangement, planActive, planLayout, matchesActive, matchesLayout, sameRect, validateRect};`, layoutContext);

const source = readFileSync(`${__dirname}/../extension.js`, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class', 'class');

class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    disconnect(id) {
        assert.ok(this.handlers.delete(id), `unknown signal ${id}`);
    }
    emit(name, ...args) {
        for (const [id, handler] of [...this.handlers]) {
            if (handler.name === name && this.handlers.has(id))
                handler.callback(this, ...args);
        }
    }
}

function fixture({synchronous = false, refuse = false, rounding = true, deferredMonitor = false, rect = {}} = {}) {
    let now = 0;
    let nextId = 1;
    const sources = new Map();
    const add = (delay, callback) => {
        const id = nextId++;
        sources.set(id, {at: now + delay, callback});
        return id;
    };
    const advance = ms => {
        const target = now + ms;
        for (;;) {
            const entry = [...sources].sort((a, b) => a[1].at - b[1].at)
                .find(([, item]) => item.at <= target);
            if (!entry)
                break;
            const [id, item] = entry;
            sources.delete(id);
            now = item.at;
            assert.equal(item.callback(), false);
        }
        now = target;
    };
    const GLib = {
        PRIORITY_DEFAULT: 0,
        PRIORITY_DEFAULT_IDLE: 200,
        SOURCE_REMOVE: false,
        idle_add: (_priority, callback) => add(0, callback),
        timeout_add: (_priority, delay, callback) => add(delay, callback),
        Source: {remove: id => assert.ok(sources.delete(id), `unknown source ${id}`)},
    };
    const wa = {x: 1920, y: 32, width: 1920, height: 1048};
    const workAreas = new Map([[1, wa], [0, {x: 0, y: 24, width: 1600, height: 876}]]);
    const workspace = {get_work_area_for_monitor: monitor => workAreas.get(monitor)};
    let activeWorkspace = workspace;
    const recentCalls = [];
    const win = new Signals();
    Object.assign(win, {
        rect: {x: 2000, y: 80, width: 800, height: 600, ...rect},
        monitor: 1,
        maximized: 0,
        fullscreen: false,
        moves: [],
        requests: [],
        monitorMoves: [],
        get_monitor() { return this.monitor; },
        get_frame_rect() { return {...this.rect}; },
        get_maximize_flags() { return this.maximized; },
        resizeable: true,
        is_fullscreen() { return this.fullscreen; },
        unmaximize() { this.maximized = 0; },
        maximize() { this.maximized = 3; },
        set_maximize_flags(flags) { this.maximized |= flags; },
        unmake_fullscreen() { this.fullscreen = false; },
        make_fullscreen() { this.fullscreen = true; },
        get_workspace: () => workspace,
        raise() {},
        raise_and_make_recent_on_workspace(workspace) {
            recentCalls.push({win: this, workspace});
            this.raise();
        },
        move_to_monitor(monitor) {
            this.monitorMoves.push(monitor);
            const arrive = () => {
                this.monitor = monitor;
                this.emit('notify::main-monitor');
                return false;
            };
            if (deferredMonitor)
                add(60, arrive);
            else
                arrive();
        },
        move_frame(_userOp, x, y) {
            this.moves.push({x, y});
            Object.assign(this.rect, {x, y});
            this.emit('position-changed');
        },
        move_resize_frame(_userOp, x, y, width, height) {
            this.requests.push({x, y, width, height});
            Object.assign(this.rect, {x, y});
            if (refuse || (width === this.rect.width && height === this.rect.height))
                return;
            const commit = () => {
                // A client rounds the requested size down by 9px/7px.
                this.commitSize(width - (rounding ? 9 : 0), height - (rounding ? 7 : 0));
                return false;
            };
            if (synchronous)
                commit();
            else
                add(40, commit);
        },
        commitSize(width, height) {
            Object.assign(this.rect, {width, height});
            this.emit('size-changed');
        },
    });
    const display = new Signals();
    display.get_focus_window = () => win;
    display.get_n_monitors = () => 2;
    display.sort_windows_by_stacking = windows => [...windows];
    const app = {get_windows: () => [win]};
    Object.assign(win, {
        get_window_type: () => 0,
        get_transient_for: () => null,
        located_on_workspace: candidate => candidate === workspace,
        allows_move: () => true,
        allows_resize() { return this.resizeable && this.maximized !== 3 && !this.fullscreen; },
        get_stable_sequence: () => 1,
    });
    const tracker = {get_window_app: () => app};
    const logs = [];
    const context = {
        console: {error: (...args) => logs.push(args)},
        Layout: layoutContext.api, GLib, Gio: {}, Meta: {MaximizeFlags: {BOTH: 3}, WindowType: {NORMAL: 0}},
        Shell: {WindowTracker: {get_default: () => tracker}}, Extension: class {},
        global: {
            display,
            workspace_manager: {get_active_workspace: () => activeWorkspace},
        },
    };
    vm.runInNewContext(`${historySource}\n${source}\nthis.Service = ServiceImpl;`, context);
    const service = new context.Service();
    return {
        service, win, display, wa, sources, advance, app, tracker, logs, workAreas, recentCalls,
        changeWorkspace() { activeWorkspace = {}; },
        cleanup() {
            advance(2000);
            service.destroy();
            assert.equal(win.handlers.size, 0);
            assert.equal(display.handlers.size, 0);
            assert.equal(sources.size, 0);
        },
    };
}

for (const synchronous of [false, true]) {
    test(`right/top aligns the actual rounded width (synchronous=${synchronous})`, () => {
        const f = fixture({synchronous});
        assert.equal(f.service.MoveResizeSemantic('right', 'top', '1100', '95%'), true);
        f.advance(50);
        assert.equal(f.win.rect.width, 1091);
        assert.equal(f.win.rect.x + f.win.rect.width, f.wa.x + f.wa.width);
        assert.equal(f.win.rect.y, f.wa.y);
        assert.equal(f.win.requests.length, 2, 'correction must not request another resize');
        f.cleanup();
    });
}

for (const position of ['center', 'middle', '50%', '100%', 'bottom']) {
    test(`${position} is resolved from the final size on both axes`, () => {
        const f = fixture();
        f.service.MoveResizeSemantic(position, position, '1100', '95%');
        f.advance(50);
        const fraction = position === '100%' || position === 'bottom' ? 1 : 0.5;
        assert.equal(f.win.rect.x, f.wa.x + Math.floor((f.wa.width - f.win.rect.width) * fraction));
        assert.equal(f.win.rect.y, f.wa.y + Math.floor((f.wa.height - f.win.rect.height) * fraction));
        f.cleanup();
    });
}

test('a refused resize with no notification still aligns the existing size', () => {
    const f = fixture({refuse: true});
    f.service.MoveResizeSemantic('right', 'bottom', '1100', '95%');
    f.advance(0);
    assert.equal(f.win.rect.width, 800);
    assert.equal(f.win.rect.x + 800, f.wa.x + f.wa.width);
    assert.equal(f.win.rect.y + 600, f.wa.y + f.wa.height);
    f.cleanup();
});

test('successive client size changes are corrected without changing a null axis', () => {
    const f = fixture();
    f.service.MoveResizeSemantic('right', 'null', '1100', '95%');
    f.advance(50);
    f.win.commitSize(1080, 900);
    f.advance(0);
    assert.equal(f.win.rect.x + 1080, f.wa.x + f.wa.width);
    assert.equal(f.win.rect.y, 80);
    f.cleanup();
});

test('a delayed position acknowledgement without a size change is corrected', () => {
    const f = fixture();
    f.service.MoveResizeSemantic('right', 'bottom', '1100', '95%');
    f.advance(50);
    const requested = f.win.requests.at(-1);
    Object.assign(f.win.rect, {x: requested.x, y: requested.y});
    f.win.emit('position-changed');
    f.advance(0);
    assert.equal(f.win.rect.x + f.win.rect.width, f.wa.x + f.wa.width);
    assert.equal(f.win.rect.y + f.win.rect.height, f.wa.y + f.wa.height);
    f.cleanup();
});

test('left/top and numeric coordinates need no size-dependent correction', () => {
    for (const [x, y] of [['left', 'top'], ['100', '200']]) {
        const f = fixture();
        f.service.MoveResizeSemantic(x, y, '1100', '95%');
        f.advance(50);
        assert.equal(f.win.rect.x, f.wa.x + (x === 'left' ? 0 : 100));
        assert.equal(f.win.rect.y, f.wa.y + (y === 'top' ? 0 : 200));
        assert.equal(f.service._placements.size, 0);
        f.cleanup();
    }
});

const cancellations = {
    'manual drag/resize': f => f.display.emit('grab-op-begin', f.win, 1),
    'window closed': f => f.win.emit('unmanaged'),
    'window moved to another workspace': f => f.win.emit('workspace-changed'),
    'work area changed': f => f.display.emit('workareas-changed'),
    'another monitor command': f => f.service.MoveToMonitor(0),
    'another move command': f => f.service.MoveInWorkArea(100, 100),
    'another resize command': f => f.service.ResizeInWorkArea(900, 700),
    'another move/resize command': f => f.service.MoveResizeInWorkArea(100, 100, 900, 700),
    'another semantic command': f => f.service.MoveResizeSemantic('left', 'top', '900', '700'),
};
for (const [name, cancel] of Object.entries(cancellations)) {
    test(`pending correction is cancelled on ${name}`, () => {
        const f = fixture();
        f.service.MoveResizeSemantic('right', 'bottom', '1100', '95%');
        cancel(f);
        f.advance(50);
        assert.equal(f.win.moves.length, 0);
        assert.equal(f.service._placements.size, 0);
        f.cleanup();
    });
}

for (const [name, change] of Object.entries({
    'monitor changed externally': f => { f.win.monitor = 0; },
    'active workspace changed': f => f.changeWorkspace(),
    'maximized on one axis': f => { f.win.maximized = 1; },
    fullscreen: f => { f.win.fullscreen = true; },
})) {
    test(`queued correction leaves the window alone after ${name}`, () => {
        const f = fixture();
        f.service.MoveResizeSemantic('right', 'top', '1100', '95%');
        change(f);
        f.advance(50);
        assert.equal(f.win.moves.length, 0);
        assert.equal(f.service._placements.size, 0);
        f.cleanup();
    });
}

test('watching expires even when the client never settles', () => {
    const f = fixture();
    f.service.MoveResizeSemantic('right', 'top', '1100', '95%');
    f.advance(1600);
    assert.equal(f.service._placements.size, 0);
    assert.equal(f.sources.size, 0);
    const count = f.win.moves.length;
    f.win.commitSize(1000, 800);
    f.advance(0);
    assert.equal(f.win.moves.length, count);
    f.cleanup();
});

test('destroy removes pending callbacks before a delayed client response', () => {
    const f = fixture();
    f.service.MoveResizeSemantic('right', 'top', '1100', '95%');
    f.service.destroy();
    assert.equal(f.service._placements.size, 0);
    assert.equal(f.display.handlers.size, 0);
    f.advance(2000);
    assert.equal(f.win.moves.length, 0);
    assert.equal(f.sources.size, 0);
});

test('GNOME 50 maximization API is supported', () => {
    const f = fixture();
    f.win.maximized = 3;
    f.service.MoveResizeSemantic('right', 'top', '1100', '95%');
    f.advance(50);
    assert.equal(f.win.rect.x + f.win.rect.width, f.wa.x + f.wa.width);
    f.cleanup();
});

function activeRules(rules) {
    return JSON.stringify({rules: rules.map(rule => ({
        ...(rule.when ? {when: {target: 'active', ...rule.when}} : {}),
        then: {target: 'active', ...rule.then},
    }))});
}

test('conditional placement cycles through three sizes using actual rounded dimensions', () => {
    const f = fixture();
    const rules = activeRules([
        {when: {width: 1000}, then: {x: 'center', y: 'center', width: 1200, height: 700}},
        {when: {width: 1200}, then: {x: 'center', y: 'center', width: 1400, height: 700}},
        {then: {x: 'center', y: 'center', width: 1000, height: 700}},
    ]);
    for (const width of [1000, 1200, 1400, 1000]) {
        assert.equal(f.service.MoveResizeConditional(rules), true);
        f.advance(50);
        assert.equal(f.win.rect.width, width - 9);
        assert.equal(f.win.rect.x, f.wa.x + Math.floor((f.wa.width - f.win.rect.width) / 2));
    }
    f.cleanup();
});

test('conditions use actual size for center and work-area-relative coordinates', () => {
    const f = fixture({rect: {width: 991, height: 693}});
    f.win.rect.x = f.wa.x + Math.floor((f.wa.width - 991) / 2);
    f.win.rect.y = f.wa.y + Math.floor((f.wa.height - 693) / 2);
    assert.equal(f.service.MoveResizeConditional(activeRules([
        {when: {x: 'center', y: 'center', width: 1000, height: 700}, then: {width: 1200}},
        {then: {width: 800}},
    ])), true);
    assert.equal(f.win.requests.at(-1).width, 1200);
    assert.equal(f.win.requests.at(-1).height, 693);
    f.cleanup();
});

test('no match does nothing; tolerance zero and partial fields are respected', () => {
    const f = fixture();
    assert.equal(f.service.MoveResizeConditional(activeRules([
        {when: {width: 801, tolerance: 0}, then: {width: 1000}},
    ])), false);
    assert.equal(f.win.requests.length, 0);
    f.service.MoveResizeConditional(activeRules([
        {when: {width: 801, tolerance: 1}, then: {x: null, height: '90%'}},
    ]));
    assert.deepEqual(f.win.requests.at(-1), {x: 2000, y: 80, width: 800, height: 943});
    f.cleanup();
});

test('first match wins and percentages match work area sizes', () => {
    const f = fixture({rect: {width: 960}});
    f.service.MoveResizeConditional(activeRules([
        {when: {width: '50%', tolerance: 0}, then: {x: 'right', width: '75%'}},
        {then: {width: 500}},
    ]));
    assert.equal(f.win.requests.at(-1).width, 1440);
    f.advance(50);
    assert.equal(f.win.rect.x + f.win.rect.width, f.wa.x + f.wa.width);
    f.cleanup();
});

test('two windows of the same application have independent placement', () => {
    const a = fixture();
    const b = fixture();
    const rules = activeRules([
        {when: {x: 'left', tolerance: 0}, then: {x: 'right'}},
        {then: {x: 'left'}},
    ]);
    a.service.MoveResizeConditional(rules);
    b.service.MoveResizeConditional(rules);
    a.advance(50);
    b.advance(50);
    assert.equal(a.win.rect.x, a.wa.x);
    assert.equal(b.win.rect.x, b.wa.x);
    a.service.MoveResizeConditional(rules);
    a.advance(50);
    assert.equal(a.win.rect.x + a.win.rect.width, a.wa.x + a.wa.width);
    assert.equal(b.win.rect.x, b.wa.x);
    a.cleanup();
    b.cleanup();
});

test('invalid rules including unreachable rules are rejected before mutation', () => {
    const f = fixture();
    for (const json of ['oops', '{}', '[]',
        '[{"then":{"width":1000}},{"then":{"width":0}}]',
        '[{"then":{"width":"90oops%"}}]',
        '[{"when":{"width":null},"then":{"width":1000}}]',
        '[{"when":{"tolerance":-1},"then":{"width":1000}}]',
        '[{"then":{"x":"bottom"}}]', '[{"then":{}}]',
        '[{"then":{"unknown":1}}]', '[{"then":{"width":1e100}}]',
        JSON.stringify(Array(101).fill({then: {width: 1000}})),
        ' '.repeat(65537)]) {
        assert.throws(() => f.service.MoveResizeConditional(json));
        assert.equal(f.win.requests.length, 0);
        assert.equal(f.service._placements.size, 0);
    }
    f.cleanup();
});

test('no focused window returns false', () => {
    const f = fixture();
    f.display.get_focus_window = () => null;
    assert.equal(f.service.MoveResizeConditional(activeRules([{then: {width: 1000}}])), false);
    f.cleanup();
});

function arrangementFixture(count, options = {}) {
    const f = fixture({refuse: true, ...options});
    const windows = [f.win];
    for (let i = 1; i < count; i++) {
        const win = Object.assign(new Signals(), f.win);
        win.handlers = new Map();
        win.rect = {...f.win.rect};
        win.requests = [];
        win.moves = [];
        win.monitorMoves = [];
        win.get_stable_sequence = () => i + 1;
        windows.push(win);
    }
    f.app.get_windows = () => [...windows].reverse();
    return {...f, windows};
}

for (const [layout, count, columns, rows] of [
    ['grid', 1, 1, 1], ['grid', 2, 2, 1], ['grid', 3, 2, 2],
    ['grid', 4, 2, 2], ['grid', 5, 3, 2],
    ['columns', 3, 3, 1], ['rows', 3, 1, 3],
]) {
    test(`ArrangeSameApp ${layout} with ${count} windows partitions the work area`, () => {
        const f = arrangementFixture(count);
        assert.equal(f.service.ArrangeSameApp(JSON.stringify({layout, gap: 13})), true);
        const w = f.wa.width - (columns - 1) * 13;
        const h = f.wa.height - (rows - 1) * 13;
        f.windows.forEach((win, i) => {
            const col = i % columns;
            const row = Math.floor(i / columns);
            assert.deepEqual(win.requests.at(-1), {
                x: f.wa.x + Math.floor(w * col / columns) + 13 * col,
                y: f.wa.y + Math.floor(h * row / rows) + 13 * row,
                width: Math.floor(w * (col + 1) / columns) - Math.floor(w * col / columns),
                height: Math.floor(h * (row + 1) / rows) - Math.floor(h * row / rows),
            });
        });
        f.cleanup();
    });
}

test('ArrangeSameApp excludes other monitors, workspaces and non-normal or unavailable windows', () => {
    const f = arrangementFixture(10);
    const changes = [
        win => { win.monitor = 0; },
        win => { win.located_on_workspace = () => false; },
        win => { win.get_window_type = () => 1; },
        win => { win.get_transient_for = () => f.win; },
        win => { win.minimized = true; },
        win => { win.fullscreen = true; },
        win => { win.skip_taskbar = true; },
        win => { win.allows_move = () => false; },
        win => { win.allows_resize = () => false; },
    ];
    changes.forEach((change, i) => change(f.windows[i + 1]));
    f.service.ArrangeSameApp('{}');
    assert.equal(f.win.requests.at(-1).width, f.wa.width);
    for (const win of f.windows.slice(1))
        assert.equal(win.requests.length, 0);
    f.cleanup();
});

test('ArrangeSameApp refuses invalid options or a plan with undersized cells before mutation', () => {
    const f = arrangementFixture(3);
    for (const value of ['null', '[]', 'broken', '{"scope":"all"}',
        '{"layout":"diagonal"}', '{"gap":-1}', '{"gap":1.5}',
        '{"gap":null}', '{"unknown":1}', '{"gap":4097}',
        '{"gap":1000,"layout":"columns"}', ' '.repeat(4097)]) {
        assert.throws(() => f.service.ArrangeSameApp(value));
        assert.ok(f.windows.every(win => win.requests.length === 0));
    }
    f.cleanup();
});

test('ArrangeSameApp does nothing without focus, recognized app or eligible focused window', () => {
    const f = arrangementFixture(2);
    f.display.get_focus_window = () => null;
    assert.equal(f.service.ArrangeSameApp('{}'), false);
    f.display.get_focus_window = () => f.win;
    f.tracker.get_window_app = () => null;
    assert.equal(f.service.ArrangeSameApp('{}'), false);
    f.tracker.get_window_app = () => f.app;
    f.win.fullscreen = true;
    assert.equal(f.service.ArrangeSameApp('{}'), false);
    assert.ok(f.windows.every(win => win.requests.length === 0));
    f.cleanup();
});

test('ArrangeSameApp cancels prior semantic corrections and unmaximizes windows', () => {
    const f = arrangementFixture(2);
    f.service.MoveResizeSemantic('right', 'bottom', '1000', '700');
    f.win.maximized = 3;
    f.service.ArrangeSameApp('{"gap":0}');
    assert.equal(f.win.maximized, 0);
    assert.equal(f.service._placements.size, 0);
    f.advance(50);
    assert.equal(f.win.rect.x, f.wa.x);
    f.cleanup();
});

test('cascade offsets windows and stacks focused window last without activation', () => {
    const f = arrangementFixture(3);
    const raised = [];
    f.windows.forEach(win => { win.raise = () => raised.push(win); });
    assert.equal(f.service.ArrangeSameApp('{"layout":"cascade"}'), true);
    const ordered = [f.windows[1], f.windows[2], f.win];
    assert.deepEqual(raised, ordered);
    ordered.forEach((win, i) => {
        assert.deepEqual(win.requests.at(-1), {
            x: f.wa.x + i * 40, y: f.wa.y + i * 40,
            width: 1344, height: 786,
        });
    });
    f.cleanup();
});

test('cascade wraps at first edge and supports horizontal, vertical and zero offsets', () => {
    for (const [offsetX, offsetY] of [[40, 40], [40, 0], [0, 40], [0, 0]]) {
        const f = arrangementFixture(4);
        f.windows.forEach(win => { win.raise = () => {}; });
        f.service.ArrangeSameApp(JSON.stringify({layout: 'cascade', width: 1900,
            height: 1000, offsetX, offsetY}));
        const slots = Math.min(4, offsetX ? 1 : 4, offsetY ? 2 : 4);
        [f.windows[1], f.windows[2], f.windows[3], f.win].forEach((win, i) => {
            assert.equal(win.requests.at(-1).x, f.wa.x + (i % slots) * offsetX);
            assert.equal(win.requests.at(-1).y, f.wa.y + (i % slots) * offsetY);
        });
        f.cleanup();
    }
});

test('cascade validates all options and resolved sizes before moving or raising', () => {
    const f = arrangementFixture(2);
    for (const extra of [{width: 49}, {height: '0%'}, {width: '101%'},
        {width: 9999}, {height: '1%'}, {offsetX: -1}, {offsetY: 0.5},
        {offsetX: null}, {height: null}, {offsetY: 4097}]) {
        assert.throws(() => f.service.ArrangeSameApp(JSON.stringify({layout: 'cascade', ...extra})));
        assert.ok(f.windows.every(win => win.requests.length === 0));
    }
    assert.throws(() => f.service.ArrangeSameApp('{"layout":"grid","width":1000}'));
    f.cleanup();
});

const ruleSet = rules => JSON.stringify({rules});
const exact = {refuse: false, synchronous: true, rounding: false};

test('mixed rules cycle active resize, grid and cascade using one history entry per call', () => {
    const f = arrangementFixture(3, exact);
    const initial = f.windows.map(win => ({...win.rect}));
    const rules = ruleSet([
        {when: {target: 'same-app', layout: 'grid'}, then: {target: 'same-app', layout: 'cascade'}},
        {when: {target: 'active', width: 1000, height: 700}, then: {target: 'same-app', layout: 'grid'}},
        {then: {target: 'active', x: 'center', y: 'center', width: 1000, height: 700}},
    ]);
    f.service.MoveResizeConditional(rules);
    f.advance(50);
    assert.equal(f.win.rect.width, 1000);
    assert.equal(f.windows[1].requests.length, 0);
    const resized = f.windows.map(win => ({...win.rect}));
    f.service.MoveResizeConditional(rules);
    f.advance(50);
    assert.equal(f.win.rect.width, 954);
    const grid = f.windows.map(win => ({...win.rect}));
    f.service.MoveResizeConditional(rules);
    f.advance(50);
    assert.equal(f.win.rect.width, 1344);
    assert.equal(f.service._history.size, 3);
    for (const expected of [grid, resized, initial]) {
        assert.equal(f.service.UndoLastOperation(), true);
        f.advance(50);
        assert.deepEqual(f.windows.map(win => win.rect), expected);
    }
    assert.equal(f.service.UndoLastOperation(), false);
    f.cleanup();
});

test('layout matching ignores focus and cell ownership but requires every cell once', () => {
    const f = arrangementFixture(3, exact);
    f.service.ArrangeSameApp('{}');
    f.advance(50);
    f.display.get_focus_window = () => f.windows[2];
    const rules = ruleSet([
        {when: {target: 'same-app', layout: 'grid'}, then: {target: 'same-app', layout: 'cascade'}},
    ]);
    assert.equal(f.service.MoveResizeConditional(rules), true);
    f.advance(50);
    assert.equal(f.windows[2].rect.width, 1344);
    f.service.ArrangeSameApp('{}');
    f.advance(50);
    f.windows[1].rect = {...f.windows[0].rect};
    const historyCount = f.service._history.size;
    assert.equal(f.service.MoveResizeConditional(rules), false);
    assert.equal(f.service._history.size, historyCount);
    f.cleanup();
});

test('layout matching uses one-to-one augmenting paths for overlapping tolerance ranges', () => {
    const rect = x => ({x, y: 0, width: 100, height: 100});
    assert.equal(layoutContext.api.matchesLayout([rect(5), rect(0)], [rect(0), rect(10)], 5), true);
    assert.equal(layoutContext.api.matchesLayout([rect(0), rect(0)], [rect(0), rect(10)], 1), false);
});

test('rounded grid dimensions match with tolerance and cascade itself is a condition', () => {
    const f = arrangementFixture(2, {refuse: false, synchronous: true});
    f.service.ArrangeSameApp('{}');
    f.advance(50);
    const rules = ruleSet([
        {when: {target: 'same-app', layout: 'grid'}, then: {target: 'same-app', layout: 'cascade'}},
        {when: {target: 'same-app', layout: 'cascade'}, then: {target: 'same-app', layout: 'rows'}},
    ]);
    assert.equal(f.service.MoveResizeConditional(rules), true);
    f.advance(50);
    assert.equal(f.win.rect.width, 1344 - 9);
    assert.equal(f.service.MoveResizeConditional(rules), true);
    assert.equal(f.win.requests.at(-1).width, 1920);
    f.cleanup();
});

test('manual move or a new window causes a layout condition to stop matching', () => {
    const f = arrangementFixture(3, exact);
    const windows = f.windows;
    f.app.get_windows = () => windows.slice(0, 2);
    f.service.ArrangeSameApp('{}');
    f.advance(50);
    const rules = ruleSet([{when: {target: 'same-app', layout: 'grid'},
        then: {target: 'active', width: 1000}}]);
    windows[1].rect.x += 100;
    assert.equal(f.service.MoveResizeConditional(rules), false);
    windows[1].rect.x -= 100;
    f.app.get_windows = () => windows;
    assert.equal(f.service.MoveResizeConditional(rules), false);
    f.cleanup();
});

test('new schema rejects unreachable malformed rules and old array syntax before mutation', () => {
    const f = fixture();
    const good = {then: {target: 'active', width: 1000}};
    for (const bad of [
        {then: {target: 'active', width: 0}},
        {when: {target: 'same-app', layout: 'unknown'}, then: good.then},
        {then: {target: 'same-app', layout: 'grid', x: 10}},
        {then: {target: 'same-app', layout: 'cascade', offsetY: null}},
        {then: {target: 'active', width: '50.5%'}},
        {then: {target: 'other', width: 1000}},
        {then: {target: 'active', width: 1e100}},
        {when: {target: 'active', width: null}, then: good.then},
        {then: {target: 'active', width: 1000, tolerance: 20}},
        {when: {target: 'active', width: 1000, tolerance: -1}, then: good.then},
        {when: {}, then: good.then},
    ]) {
        assert.throws(() => f.service.MoveResizeConditional(ruleSet([good, bad])));
        assert.equal(f.service._history.size, 0);
        assert.equal(f.win.requests.length, 0);
    }
    for (const invalid of [JSON.stringify([good]), ruleSet([]),
        JSON.stringify({rules: [good], scope: 'all'}),
        JSON.stringify({rules: [good], tolerance: null}), ruleSet(Array(101).fill(good))])
        assert.throws(() => f.service.MoveResizeConditional(invalid));
    f.cleanup();
});

test('invalid resolved action is rejected without history; nonfitting condition can fall through', () => {
    const f = arrangementFixture(2, exact);
    assert.throws(() => f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'same-app', layout: 'cascade', width: 9999}},
    ])));
    assert.equal(f.service._history.size, 0);
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {when: {target: 'same-app', layout: 'cascade', width: 9999},
            then: {target: 'active', width: 900}},
        {then: {target: 'active', width: 1000}},
    ])), true);
    assert.equal(f.win.rect.width, 1000);
    f.cleanup();
});

test('active-only rules work without an app identity and no-op does not consume history', () => {
    const f = fixture(exact);
    f.tracker.get_window_app = () => null;
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', x: null}},
    ])), false);
    assert.equal(f.service._history.size, 0);
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', width: 1000}},
    ])), true);
    assert.equal(f.win.rect.width, 1000);
    f.cleanup();
});

test('undo closes over original targets even after focus changes and removes closed windows', () => {
    const f = arrangementFixture(3, exact);
    const originals = f.windows.map(win => ({...win.rect}));
    f.service.ArrangeSameApp('{}');
    f.advance(50);
    f.windows[1].emit('unmanaged');
    const closedRequestCount = f.windows[1].requests.length;
    f.display.get_focus_window = () => null;
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.deepEqual(f.win.rect, originals[0]);
    assert.deepEqual(f.windows[2].rect, originals[2]);
    assert.equal(f.windows[1].requests.length, closedRequestCount);
    assert.equal(f.windows[1].handlers.size, 0);
    f.cleanup();
});

test('history is bounded to 20 operations, LIFO and cleared on work area change', () => {
    const f = fixture(exact);
    for (let i = 0; i < 25; i++)
        f.service.ResizeInWorkArea(1000 + i, 700);
    assert.equal(f.service._history.size, 20);
    for (let width = 1023; width >= 1004; width--) {
        assert.equal(f.service.UndoLastOperation(), true);
        f.advance(50);
        assert.equal(f.win.rect.width, width);
    }
    assert.equal(f.service.UndoLastOperation(), false);
    f.service.ResizeInWorkArea(1100, 700);
    f.display.emit('workareas-changed');
    assert.equal(f.service.UndoLastOperation(), false);
    assert.equal(f.win.handlers.size, 0);
    f.cleanup();
});

test('undo restores partial maximization flags on GNOME 50', () => {
    const f = fixture(exact);
    f.win.maximized = 1;
    f.service.ResizeInWorkArea(1000, 700);
    assert.equal(f.win.maximized, 0);
    f.service.UndoLastOperation();
    assert.equal(f.win.maximized, 1);
    f.cleanup();
});

test('legacy monitor move can be undone and each legacy call is a separate entry', () => {
    const f = fixture(exact);
    const original = {...f.win.rect};
    f.service.MoveToMonitor(0);
    f.service.MoveResizeSemantic('left', 'top', '1000', '700');
    assert.equal(f.service._history.size, 2);
    f.service.UndoLastOperation();
    assert.equal(f.win.monitor, 0);
    f.service.UndoLastOperation();
    f.advance(50);
    assert.equal(f.win.monitor, 1);
    assert.deepEqual(f.win.rect, original);
    f.cleanup();
});

test('undo cancels semantic correction and corrects delayed position acknowledgement', () => {
    const f = fixture(exact);
    const original = {...f.win.rect};
    f.service.MoveResizeSemantic('right', 'bottom', '1100', '700');
    f.service.UndoLastOperation();
    f.win.rect.x += 200;
    f.win.emit('position-changed');
    f.advance(50);
    assert.deepEqual(f.win.rect, original);
    f.cleanup();
});

test('undo skips windows moved to another workspace and clears closed-only entries', () => {
    const f = fixture(exact);
    f.service.ResizeInWorkArea(1000, 700);
    f.win.get_workspace = () => ({});
    assert.equal(f.service.UndoLastOperation(), false);
    assert.equal(f.win.rect.width, 1000);
    f.service.ResizeInWorkArea(1100, 700);
    f.win.emit('unmanaged');
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('undo restores target stacking for cascade and destroy disconnects history observers', () => {
    const f = arrangementFixture(3, exact);
    const originalStack = [f.windows[2], f.windows[0], f.windows[1]];
    f.display.sort_windows_by_stacking = () => originalStack;
    const raised = [];
    f.windows.forEach(win => { win.raise = () => raised.push(win); });
    f.service.ArrangeSameApp('{"layout":"cascade"}');
    raised.length = 0;
    f.service.UndoLastOperation();
    assert.deepEqual(raised, originalStack);
    f.service.ArrangeSameApp('{}');
    f.cleanup();
    assert.ok(f.windows.every(win => win.handlers.size === 0));
});

test('GNOME 50 maximized active and background windows are included before unmaximizing', () => {
    const f = arrangementFixture(3, exact);
    f.win.maximized = 3;
    f.windows[1].maximized = 3;
    assert.equal(f.win.allows_resize(), false, 'mock follows Mutter 50 maximized behavior');
    assert.equal(f.windows[1].allows_resize(), false);
    assert.equal(f.service.ArrangeSameApp('{}'), true);
    assert.ok(f.windows.every(win => win.requests.length === 2));
    assert.ok(f.windows.every(win => win.maximized === 0));
    assert.equal(f.service._history.size, 1);
    assert.equal(f.service.UndoLastOperation(), true);
    assert.equal(f.win.maximized, 3);
    assert.equal(f.windows[1].maximized, 3);
    f.cleanup();
});

test('active conditional placement can resize a maximized window without matching grid first', () => {
    const f = fixture(exact);
    f.win.maximized = 3;
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {when: {target: 'same-app', layout: 'grid'}, then: {target: 'active', width: 900}},
        {then: {target: 'active', width: 1000, height: 700}},
    ])), true);
    assert.equal(f.win.maximized, 0);
    assert.equal(f.win.rect.width, 1000);
    f.cleanup();
});

test('intrinsically nonresizable windows remain excluded even if marked maximized', () => {
    const f = arrangementFixture(3, exact);
    f.windows[1].resizeable = false;
    f.windows[1].maximized = 3;
    f.windows[2].resizeable = false;
    f.service.ArrangeSameApp('{}');
    assert.equal(f.win.rect.width, f.wa.width);
    assert.equal(f.windows[1].requests.length, 0);
    assert.equal(f.windows[2].requests.length, 0);
    f.cleanup();
});

test('nonstring layout values are rejected in both APIs including unreachable conditions', () => {
    const f = arrangementFixture(2, exact);
    f.win.maximized = 3;
    for (const layout of [['cascade'], ['grid'], [['cascade']], null, 1, {}, true]) {
        assert.throws(() => f.service.ArrangeSameApp(JSON.stringify({layout})));
        assert.throws(() => f.service.MoveResizeConditional(ruleSet([
            {then: {target: 'same-app', layout}},
        ])));
        assert.throws(() => f.service.MoveResizeConditional(ruleSet([
            {then: {target: 'active', width: 1000}},
            {when: {target: 'same-app', layout}, then: {target: 'active', width: 900}},
        ])));
    }
    assert.equal(f.win.maximized, 3);
    assert.equal(f.service._history.size, 0);
    assert.ok(f.windows.every(win => win.requests.length === 0));
    f.cleanup();
});

test('computed integer overflow is rejected before unmaximizing and before recording history', () => {
    const f = fixture(exact);
    f.win.maximized = 3;
    assert.throws(() => f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', x: 2147483647, width: 1000}},
    ])));
    assert.equal(f.win.maximized, 3);
    assert.equal(f.win.requests.length, 0);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('final plan validates every rectangle before changing even the first window', () => {
    const f = arrangementFixture(2, exact);
    for (const invalid of [NaN, Infinity, 0.5]) {
        assert.throws(() => f.service._executePlan([
            {win: f.win, rect: {x: 1920, y: 32, width: 1000, height: 700}},
            {win: f.windows[1], rect: {x: invalid, y: 32, width: 1000, height: 700}},
        ], f.wa));
    }
    assert.ok(f.windows.every(win => win.requests.length === 0));
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('partial undo continues past an exception and retains only the failed target for retry', () => {
    const f = arrangementFixture(3, exact);
    const original = f.windows.map(win => ({...win.rect}));
    f.service.ArrangeSameApp('{}');
    f.advance(50);
    const failed = f.windows[1];
    const apply = failed.move_resize_frame;
    failed.move_resize_frame = () => { throw new Error('injected restore error'); };
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.deepEqual(f.win.rect, original[0]);
    assert.deepEqual(f.windows[2].rect, original[2]);
    assert.equal(f.service._history.size, 1);
    assert.equal(f.service._history.peek().length, 1);
    assert.equal(f.service._history.peek()[0].win, failed);
    assert.equal(f.logs.length, 1);
    assert.equal(f.service._placements.has(failed), false, 'failed restore observer was canceled');
    failed.move_resize_frame = apply;
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.deepEqual(failed.rect, original[1]);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('fully failed undo retains history, does not duplicate entries and can later be retried', () => {
    const f = fixture(exact);
    const original = {...f.win.rect};
    f.service.ResizeInWorkArea(1000, 700);
    const apply = f.win.move_resize_frame;
    f.win.move_resize_frame = () => { throw new Error('injected restore error'); };
    assert.equal(f.service.UndoLastOperation(), false);
    assert.equal(f.service.UndoLastOperation(), false);
    assert.equal(f.service._history.size, 1);
    assert.equal(f.service._history.peek().length, 1);
    f.win.move_resize_frame = apply;
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.deepEqual(f.win.rect, original);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('closing a failed undo target removes its retained history and observers', () => {
    const f = fixture(exact);
    f.service.ResizeInWorkArea(1000, 700);
    f.win.move_resize_frame = () => { throw new Error('injected restore error'); };
    f.service.UndoLastOperation();
    assert.equal(f.service._history.size, 1);
    f.win.emit('unmanaged');
    assert.equal(f.service._history.size, 0);
    assert.equal(f.win.handlers.size, 0);
    f.cleanup();
});

function stackingFixture() {
    const f = arrangementFixture(3, exact);
    let stacking = [f.windows[1], f.windows[2], f.win];
    const raised = [];
    const closed = new Set();
    f.display.sort_windows_by_stacking = windows => stacking.filter(win => windows.includes(win));
    f.windows.forEach(win => {
        win.raise = () => {
            assert.equal(closed.has(win), false, 'closed window must not be raised');
            raised.push(win);
            stacking = [...stacking.filter(item => item !== win), win];
        };
    });
    return {...f, raised, getStack: () => [...stacking], close(win) {
        closed.add(win);
        stacking = stacking.filter(item => item !== win);
        win.emit('unmanaged');
    }};
}

test('cascade undo restores the original complete stack after retrying only failed geometry', () => {
    const f = stackingFixture();
    const originalStack = f.getStack();
    const originalRects = f.windows.map(win => ({...win.rect}));
    f.service.ArrangeSameApp('{"layout":"cascade"}');
    const failed = f.windows[1];
    const apply = failed.move_resize_frame;
    failed.move_resize_frame = () => { throw new Error('injected geometry failure'); };
    f.raised.length = 0;
    assert.equal(f.service.UndoLastOperation(), true);
    assert.equal(f.raised.length, 0, 'stack restoration waits for pending geometry');
    const successfulCounts = [f.win.requests.length, f.windows[2].requests.length];
    failed.move_resize_frame = apply;
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.deepEqual(f.getStack(), originalStack);
    assert.deepEqual(f.raised, originalStack);
    assert.deepEqual(f.windows.map(win => win.rect), originalRects);
    assert.deepEqual([f.win.requests.length, f.windows[2].requests.length], successfulCounts);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
    assert.ok(f.windows.every(win => win.handlers.size === 0));
});

test('a failed stacking pass is retained even after all geometry has been restored', () => {
    const f = stackingFixture();
    const originalStack = f.getStack();
    f.service.ArrangeSameApp('{"layout":"cascade"}');
    const failed = originalStack[1];
    const raise = failed.raise;
    failed.raise = () => { throw new Error('injected raise failure'); };
    assert.equal(f.service.UndoLastOperation(), true, 'geometry was restored');
    assert.equal(f.service._history.size, 1);
    assert.equal(f.service._history.peek().length, 0, 'only stacking remains');
    assert.equal(f.service.UndoLastOperation(), false, 'stack-only retry still failed');
    const requestCounts = f.windows.map(win => win.requests.length);
    failed.raise = raise;
    f.raised.length = 0;
    assert.equal(f.service.UndoLastOperation(), true);
    assert.deepEqual(f.raised, originalStack, 'restart the complete back-to-front pass');
    assert.deepEqual(f.getStack(), originalStack);
    assert.deepEqual(f.windows.map(win => win.requests.length), requestCounts);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('closing an already restored peer removes its retained stacking reference before retry', () => {
    const f = stackingFixture();
    const expected = f.getStack().filter(win => win !== f.windows[2]);
    f.service.ArrangeSameApp('{"layout":"cascade"}');
    const failed = f.windows[1];
    const apply = failed.move_resize_frame;
    failed.move_resize_frame = () => { throw new Error('injected geometry failure'); };
    f.service.UndoLastOperation();
    f.close(f.windows[2]);
    assert.equal(f.windows[2].handlers.size, 0);
    failed.move_resize_frame = apply;
    f.service.UndoLastOperation();
    assert.deepEqual(f.getStack(), expected);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('already restored peers moved to another workspace are not raised on retry', () => {
    const f = stackingFixture();
    f.service.ArrangeSameApp('{"layout":"cascade"}');
    const failed = f.windows[1];
    const apply = failed.move_resize_frame;
    failed.move_resize_frame = () => { throw new Error('injected geometry failure'); };
    f.service.UndoLastOperation();
    const otherWorkspace = {};
    f.windows[2].get_workspace = () => otherWorkspace;
    failed.move_resize_frame = apply;
    f.raised.length = 0;
    f.service.UndoLastOperation();
    assert.equal(f.raised.includes(f.windows[2]), false);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('bounded history eviction releases peers retained only for a pending stacking restore', () => {
    const f = stackingFixture();
    f.service.ArrangeSameApp('{"layout":"cascade"}');
    f.windows[1].move_resize_frame = () => { throw new Error('injected geometry failure'); };
    f.service.UndoLastOperation();
    f.advance(2000);
    assert.ok(f.windows[2].handlers.size > 0, 'stack-only peer is still observed');
    for (let i = 0; i < 20; i++)
        f.service.ResizeInWorkArea(1000 + i, 700);
    assert.equal(f.service._history.size, 20);
    assert.equal(f.windows[1].handlers.size, 0);
    assert.equal(f.windows[2].handlers.size, 0);
    f.cleanup();
});

test('monitor condition and destination use target area percentages and a single undo entry', () => {
    const f = fixture(exact);
    const original = {...f.win.rect};
    const rules = ruleSet([
        {when: {target: 'active', monitor: 1}, then: {target: 'active', monitor: 0,
            x: 'center', y: 'center', width: '50%', height: '90%'}},
    ]);
    assert.equal(f.service.MoveResizeConditional(rules), true);
    f.advance(50);
    assert.equal(f.win.monitor, 0);
    assert.deepEqual(f.win.rect, {x: 400, y: 68, width: 800, height: 788});
    assert.equal(f.service._history.size, 1);
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.equal(f.win.monitor, 1);
    assert.deepEqual(f.win.rect, original);
    f.cleanup();
});

test('monitor conditions are exact, can combine geometry and ignore tolerance for the number', () => {
    const f = fixture(exact);
    assert.equal(f.service.MoveResizeConditional(JSON.stringify({tolerance: 4096, rules: [
        {when: {target: 'active', monitor: 0}, then: {target: 'active', width: 900}},
        {when: {target: 'active', monitor: 1, width: 800}, then: {target: 'active', width: 1000}},
    ]})), true);
    assert.equal(f.win.rect.width, 1000);
    assert.equal(f.win.monitorMoves.length, 0, 'omitted destination keeps current monitor');
    f.cleanup();
});

test('monitor-only actions preserve size and transfer clamped work-area-relative positions', () => {
    for (const [rect, expected] of [
        [{x: 2000, y: 80}, {x: 80, y: 72, width: 800, height: 600}],
        [{x: 3500, y: 900}, {x: 800, y: 300, width: 800, height: 600}],
    ]) {
        const f = fixture({...exact, rect});
        assert.equal(f.service.MoveResizeConditional(ruleSet([
            {then: {target: 'active', monitor: 0}},
        ])), true);
        f.advance(50);
        assert.deepEqual(f.win.rect, expected);
        assert.equal(f.win.monitor, 0);
        f.cleanup();
    }
});

test('moving a maximized window with monitor-only condition is supported', () => {
    const f = fixture(exact);
    f.win.maximized = 3;
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {when: {target: 'same-app', monitor: 1}, then: {target: 'active', monitor: 0,
            x: 'center', y: 'center', width: 1000, height: 700}},
    ])), true);
    assert.equal(f.win.maximized, 0);
    assert.equal(f.win.monitor, 0);
    f.cleanup();
});

test('same-app movement snapshots the source group and leaves target monitor peers untouched', () => {
    const f = arrangementFixture(4, exact);
    f.windows[3].monitor = 0;
    const before = f.windows.map(win => ({...win.rect}));
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {when: {target: 'same-app', monitor: 1}, then: {target: 'same-app', monitor: 0,
            layout: 'columns', gap: 10}},
    ])), true);
    f.advance(50);
    assert.ok(f.windows.slice(0, 3).every(win => win.monitor === 0));
    assert.deepEqual(f.windows[0].rect, {x: 0, y: 24, width: 526, height: 876});
    assert.deepEqual(f.windows[2].rect, {x: 1073, y: 24, width: 527, height: 876});
    assert.equal(f.windows[3].requests.length, 0);
    assert.equal(f.service._history.size, 1);
    f.service.UndoLastOperation();
    f.advance(50);
    assert.ok(f.windows.slice(0, 3).every(win => win.monitor === 1));
    assert.equal(f.windows[3].monitor, 0);
    assert.deepEqual(f.windows.map(win => win.rect), before);
    f.cleanup();
});

test('monitor and layout conditions match the current area before selecting another monitor', () => {
    const f = arrangementFixture(2, exact);
    f.service.ArrangeSameApp('{}');
    f.advance(50);
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {when: {target: 'same-app', monitor: 0, layout: 'grid'}, then: {target: 'active', width: 900}},
        {when: {target: 'same-app', monitor: 1, layout: 'grid'}, then: {target: 'same-app',
            monitor: 0, layout: 'cascade', width: '50%', height: '70%'}},
    ])), true);
    f.advance(50);
    assert.equal(f.win.monitor, 0);
    assert.equal(f.win.rect.width, 800);
    assert.equal(f.win.rect.height, 613);
    f.cleanup();
});

test('bad monitor types and nonexistent destinations are rejected before any mutation', () => {
    const f = fixture(exact);
    f.win.maximized = 3;
    for (const monitor of [-1, .5, '0', null, [0], {}, 1e100]) {
        for (const key of ['when', 'then']) {
            assert.throws(() => f.service.MoveResizeConditional(ruleSet([
                {then: {target: 'active', width: 1000}},
                {[key]: {target: 'active', monitor}, ...(key === 'when' ?
                    {then: {target: 'active', width: 1000}} : {})},
            ])));
        }
    }
    assert.throws(() => f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', monitor: 2, width: 1000}},
    ])));
    assert.equal(f.win.maximized, 3);
    assert.equal(f.service._history.size, 0);
    assert.equal(f.win.requests.length, 0);
    assert.equal(f.win.monitorMoves.length, 0);
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {when: {target: 'active', monitor: 2}, then: {target: 'active', width: 1000}},
    ])), false, 'a missing monitor in a condition simply does not match');
    f.cleanup();
});

test('an impossible destination layout is rejected before moving the first window', () => {
    const f = arrangementFixture(3, exact);
    f.workAreas.set(0, {x: 0, y: 0, width: 80, height: 60});
    assert.throws(() => f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'same-app', monitor: 0, layout: 'grid'}},
    ])));
    assert.ok(f.windows.every(win => win.monitor === 1 && win.monitorMoves.length === 0));
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('semantic alignment waits for asynchronous monitor arrival and uses the destination size', () => {
    const f = fixture({deferredMonitor: true});
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', monitor: 0, x: 'right', y: 'bottom', width: 1000, height: 700}},
    ])), true);
    f.advance(50);
    assert.equal(f.win.monitor, 1, 'monitor transfer is still pending');
    assert.equal(f.service._placements.size, 1);
    f.advance(20);
    const target = f.workAreas.get(0);
    assert.equal(f.win.monitor, 0);
    assert.equal(f.win.rect.x + f.win.rect.width, target.x + target.width);
    assert.equal(f.win.rect.y + f.win.rect.height, target.y + target.height);
    f.cleanup();
});

for (const layout of ['grid', 'columns', 'rows', 'cascade']) {
    test(`${layout} brings the app group above other apps with the active window on top`, () => {
        const f = arrangementFixture(3, exact);
        const other = {app: 'other'};
        let stacking = [f.win, f.windows[1], other, f.windows[2]];
        const originalAppOrder = stacking.filter(win => win !== other);
        f.display.sort_windows_by_stacking = windows => stacking.filter(win => windows.includes(win));
        f.windows.forEach(win => {
            win.raise = () => { stacking = [...stacking.filter(item => item !== win), win]; };
            win.activate = () => assert.fail('arrangement must not activate a window');
        });
        assert.equal(f.service.ArrangeSameApp(JSON.stringify({layout})), true);
        assert.deepEqual(stacking, [other, f.windows[1], f.windows[2], f.win]);
        assert.equal(f.display.get_focus_window(), f.win);
        assert.equal(f.service._history.size, 1);
        f.service.UndoLastOperation();
        assert.deepEqual(stacking.filter(win => win !== other), originalAppOrder);
        f.cleanup();
    });
}

test('conditional same-app grid raises the group, while an active-only resize does not', () => {
    const f = arrangementFixture(3, exact);
    const raised = [];
    f.windows.forEach(win => { win.raise = () => raised.push(win); });
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'same-app', layout: 'grid'}},
    ])), true);
    assert.deepEqual(raised, [f.windows[1], f.windows[2], f.win]);
    raised.length = 0;
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', width: 1000}},
    ])), true);
    assert.equal(raised.length, 0);
    f.cleanup();
});

for (const layout of ['grid', 'columns', 'rows', 'cascade']) {
    test(`${layout} makes the whole group recent so closing windows stays in that group`, () => {
        const f = arrangementFixture(3, exact);
        const other = {app: 'other', raise() {}};
        let focused = f.win;
        // Another app is more recent than the two inactive app windows.
        let mru = [f.win, other, f.windows[1], f.windows[2]];
        f.display.get_focus_window = () => focused;
        f.windows.forEach(win => {
            win.activate = () => assert.fail('must preserve keyboard focus');
            win.raise_and_make_recent_on_workspace = workspace => {
                assert.equal(workspace, f.win.get_workspace());
                win.raise();
                mru = [win, ...mru.filter(item => item !== win)];
            };
        });
        f.service.ArrangeSameApp(JSON.stringify({layout}));
        assert.equal(focused, f.win);
        assert.deepEqual(mru, [f.win, f.windows[2], f.windows[1], other]);
        for (let remaining = 3; remaining > 0; remaining--) {
            assert.ok(f.windows.includes(focused), 'do not switch apps while group windows remain');
            const closing = focused;
            closing.emit('unmanaged');
            mru = mru.filter(win => win !== closing);
            focused = mru[0];
        }
        assert.equal(focused, other);
        f.cleanup();
    });
}

test('single-window operations and undo do not rewrite the workspace usage history', () => {
    const f = arrangementFixture(3, exact);
    f.service.MoveResizeSemantic('center', 'center', '1000', '700');
    assert.equal(f.recentCalls.length, 0);
    f.service.ArrangeSameApp('{}');
    assert.deepEqual(f.recentCalls.map(item => item.win), [f.windows[1], f.windows[2], f.win]);
    f.recentCalls.length = 0;
    f.service.UndoLastOperation();
    assert.equal(f.recentCalls.length, 0, 'undo restores stacking without rewriting MRU');
    f.cleanup();
});

test('active resize optionally fronts source app peers without changing their geometry, including undo', () => {
    const f = arrangementFixture(3, exact);
    const original = {...f.win.rect};
    const peers = f.windows.slice(1).map(win => ({...win.rect}));
    f.windows[1].maximized = 3;
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', width: 1000, height: 700, bringToFront: 'same-app'}},
    ])), true);
    f.advance(50);
    assert.equal(f.win.rect.width, 1000);
    assert.deepEqual(f.recentCalls.map(item => item.win), [f.windows[1], f.windows[2], f.win]);
    assert.equal(f.display.get_focus_window(), f.win);
    assert.equal(f.service._history.peek().length, 1);
    assert.equal(f.service._history.peekOperation().stacking.length, 3);
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.deepEqual(f.win.rect, original);
    f.windows.slice(1).forEach((win, index) => {
        assert.deepEqual(win.rect, peers[index]);
        assert.equal(win.requests.length, 0);
    });
    assert.equal(f.windows[1].maximized, 3);
    f.cleanup();
});

test('fronting still executes when the active geometry already matches and is undoable', () => {
    const f = arrangementFixture(3, exact);
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', width: f.win.rect.width, bringToFront: 'same-app'}},
    ])), true);
    assert.equal(f.recentCalls.length, 3);
    assert.equal(f.service._history.peek().length, 0);
    assert.equal(f.service.UndoLastOperation(), true);
    f.windows.forEach(win => assert.equal(win.requests.length, 0));
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});

test('fronting option rejects invalid values, conditions and same-app layout actions before mutation', () => {
    const f = arrangementFixture(3, exact);
    for (const value of [null, true, 'active', '', 1]) {
        assert.throws(() => f.service.MoveResizeConditional(ruleSet([
            {then: {target: 'active', width: 1000, bringToFront: value}},
        ])));
    }
    assert.throws(() => f.service.MoveResizeConditional(ruleSet([
        {when: {target: 'active', width: 1000, bringToFront: 'same-app'},
            then: {target: 'active', width: 1200}},
    ])));
    assert.throws(() => f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'same-app', layout: 'grid', bringToFront: 'same-app'}},
    ])));
    assert.equal(f.service._history.size, 0);
    assert.equal(f.recentCalls.length, 0);
    f.cleanup();
});

test('resize and monitor transfer only fronts eligible source-monitor peers', () => {
    const f = arrangementFixture(4, exact);
    f.windows[3].monitor = 0;
    const sourceMonitor = f.win.monitor;
    assert.notEqual(sourceMonitor, 0);
    assert.equal(f.service.MoveResizeConditional(ruleSet([
        {then: {target: 'active', monitor: 0, width: 1000, bringToFront: 'same-app'}},
    ])), true);
    f.advance(50);
    assert.equal(f.win.monitor, 0);
    assert.equal(f.windows[1].monitor, sourceMonitor);
    assert.equal(f.windows[2].monitor, sourceMonitor);
    assert.equal(f.windows[3].requests.length, 0);
    assert.deepEqual(f.recentCalls.map(item => item.win), [f.windows[1], f.windows[2], f.win]);
    f.windows[1].emit('unmanaged');
    assert.equal(f.service.UndoLastOperation(), true);
    f.advance(50);
    assert.equal(f.win.monitor, sourceMonitor);
    assert.equal(f.service._history.size, 0);
    f.cleanup();
});
