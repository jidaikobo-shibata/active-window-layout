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
    const context = {
        GLib, Gio: {}, Meta: {MaximizeFlags: {BOTH: 3}}, Extension: class {},
        global: {
            display,
            workspace_manager: {get_active_workspace: () => activeWorkspace},
        },
    };
    vm.runInNewContext(`${source}\nthis.Service = ServiceImpl;`, context);
    const service = new context.Service();
    return {
        service, win, display, wa, sources, advance,
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
