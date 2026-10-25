// Run with: node tests/placement.test.cjs
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {test} = require('node:test');
const vm = require('node:vm');

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

function fixture({synchronous = false, refuse = false, rect = {}} = {}) {
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
    const workspace = {get_work_area_for_monitor: () => wa};
    let activeWorkspace = workspace;
    const win = new Signals();
    Object.assign(win, {
        rect: {x: 2000, y: 80, width: 800, height: 600, ...rect},
        monitor: 1,
        maximized: 0,
        fullscreen: false,
        moves: [],
        requests: [],
        get_monitor() { return this.monitor; },
        get_frame_rect() { return {...this.rect}; },
        get_maximized() { return this.maximized; },
        is_fullscreen() { return this.fullscreen; },
        unmaximize() { this.maximized = 0; },
        move_to_monitor(monitor) { this.monitor = monitor; },
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
                this.commitSize(width - 9, height - 7);
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
    const app = {get_windows: () => [win]};
    Object.assign(win, {
        get_window_type: () => 0,
        get_transient_for: () => null,
        located_on_workspace: candidate => candidate === workspace,
        allows_move: () => true,
        allows_resize: () => true,
        get_stable_sequence: () => 1,
    });
    const tracker = {get_window_app: () => app};
    const context = {
        GLib, Gio: {}, Meta: {MaximizeFlags: {BOTH: 3}, WindowType: {NORMAL: 0}},
        Shell: {WindowTracker: {get_default: () => tracker}}, Extension: class {},
        global: {
            display,
            workspace_manager: {get_active_workspace: () => activeWorkspace},
        },
    };
    vm.runInNewContext(`${source}\nthis.Service = ServiceImpl;`, context);
    const service = new context.Service();
    return {
        service, win, display, wa, sources, advance, app, tracker,
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
        assert.equal(f.win.handlers.size, 0);
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
        assert.equal(f.win.handlers.size, 0);
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
        assert.equal(f.win.handlers.size, 0);
        f.cleanup();
    });
}

test('watching expires even when the client never settles', () => {
    const f = fixture();
    f.service.MoveResizeSemantic('right', 'top', '1100', '95%');
    f.advance(1600);
    assert.equal(f.win.handlers.size, 0);
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
    assert.equal(f.win.handlers.size, 0);
    assert.equal(f.display.handlers.size, 0);
    f.advance(2000);
    assert.equal(f.win.moves.length, 0);
    assert.equal(f.sources.size, 0);
});

test('GNOME 50 maximization API is supported', () => {
    const f = fixture();
    f.win.get_maximize_flags = f.win.get_maximized;
    delete f.win.get_maximized;
    f.service.MoveResizeSemantic('right', 'top', '1100', '95%');
    f.advance(50);
    assert.equal(f.win.rect.x + f.win.rect.width, f.wa.x + f.wa.width);
    f.cleanup();
});

test('conditional placement cycles through three sizes using actual rounded dimensions', () => {
    const f = fixture();
    const rules = JSON.stringify([
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
    assert.equal(f.service.MoveResizeConditional(JSON.stringify([
        {when: {x: 'center', y: 'center', width: 1000, height: 700}, then: {width: 1200}},
        {then: {width: 800}},
    ])), true);
    assert.equal(f.win.requests.at(-1).width, 1200);
    assert.equal(f.win.requests.at(-1).height, 693);
    f.cleanup();
});

test('no match does nothing; tolerance zero and partial fields are respected', () => {
    const f = fixture();
    assert.equal(f.service.MoveResizeConditional(JSON.stringify([
        {when: {width: 801, tolerance: 0}, then: {width: 1000}},
    ])), false);
    assert.equal(f.win.requests.length, 0);
    f.service.MoveResizeConditional(JSON.stringify([
        {when: {width: 801, tolerance: 1}, then: {x: null, height: '90%'}},
    ]));
    assert.deepEqual(f.win.requests.at(-1), {x: 2000, y: 80, width: 800, height: 943});
    f.cleanup();
});

test('first match wins and percentages match work area sizes', () => {
    const f = fixture({rect: {width: 960}});
    f.service.MoveResizeConditional(JSON.stringify([
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
    const rules = JSON.stringify([
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
        assert.equal(f.win.handlers.size, 0);
    }
    f.cleanup();
});

test('no focused window returns false', () => {
    const f = fixture();
    f.display.get_focus_window = () => null;
    assert.equal(f.service.MoveResizeConditional('[{"then":{"width":1000}}]'), false);
    f.cleanup();
});

function arrangementFixture(count) {
    const f = fixture({refuse: true});
    const windows = [f.win];
    for (let i = 1; i < count; i++) {
        const win = Object.assign(new Signals(), f.win);
        win.handlers = new Map();
        win.rect = {...f.win.rect};
        win.requests = [];
        win.moves = [];
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
    assert.equal(f.win.handlers.size, 0);
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
