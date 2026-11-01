import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Layout from './layout.js';
import { OperationHistory } from './history.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// D-Bus Introspection XML
const IFACE_XML = `
<node>
    <interface name="org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout">
        <method name="GetWorkArea">
            <arg type="i" name="x" direction="out"/>
            <arg type="i" name="y" direction="out"/>
            <arg type="i" name="width" direction="out"/>
            <arg type="i" name="height" direction="out"/>
        </method>

        <method name="ResizeInWorkArea">
            <arg type="i" name="width" direction="in"/>
            <arg type="i" name="height" direction="in"/>
            <arg type="b" name="ok" direction="out"/>
        </method>

        <method name="MoveInWorkArea">
            <arg type="i" name="x" direction="in"/>
            <arg type="i" name="y" direction="in"/>
            <arg type="b" name="ok" direction="out"/>
        </method>

        <method name="MoveResizeInWorkArea">
            <arg type="i" name="x" direction="in"/>
            <arg type="i" name="y" direction="in"/>
            <arg type="i" name="width" direction="in"/>
            <arg type="i" name="height" direction="in"/>
            <arg type="b" name="ok" direction="out"/>
        </method>

        <method name="MoveToMonitor">
            <arg type="i" name="monitor" direction="in"/>
            <arg type="b" name="ok" direction="out"/>
        </method>

        <method name="UndoLastOperation">
            <arg type="b" name="ok" direction="out"/>
        </method>

        <method name="ArrangeSameApp">
            <arg type="s" name="options" direction="in"/>
            <arg type="b" name="ok" direction="out"/>
        </method>

        <method name="MoveResizeConditional">
            <arg type="s" name="rules" direction="in"/>
            <arg type="b" name="ok" direction="out"/>
        </method>

        <method name="MoveResizeSemantic">
            <arg type="s" name="x" direction="in"/>
            <arg type="s" name="y" direction="in"/>
            <arg type="s" name="width" direction="in"/>
            <arg type="s" name="height" direction="in"/>
            <arg type="b" name="ok" direction="out"/>
        </method>
    </interface>
</node>`;

// 公開する well-known name と object path
const BUS_NAME = 'org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/jidaikobo/shibata/ActiveWindowLayout';
const PLACEMENT_TIMEOUT_MS = 1500;

class ServiceImpl {
    constructor() {
        this._placements = new Map();
        this._history = new OperationHistory(20);
        this._grabBeginId = global.display.connect('grab-op-begin', (_display, win) => {
            this._cancelPlacement(win);
        });
        this._workAreasChangedId = global.display.connect('workareas-changed', () => {
            this._cancelAllPlacements();
            this._history.clear();
        });
    }

    destroy() {
        this._cancelAllPlacements();
        this._history.clear();
        global.display.disconnect(this._grabBeginId);
        global.display.disconnect(this._workAreasChangedId);
    }

    _cancelAllPlacements() {
        for (const win of this._placements.keys())
            this._cancelPlacement(win);
    }

    _cancelPlacement(win) {
        const pending = this._placements.get(win);
        if (!pending)
            return;

        this._placements.delete(win);
        if (pending.idleId)
            GLib.Source.remove(pending.idleId);
        if (pending.timeoutId)
            GLib.Source.remove(pending.timeoutId);
        for (const id of pending.signalIds)
            win.disconnect(id);
    }

    _isMaximized(win) {
        return this._maximizeFlags(win) !== 0;
    }

    _watchSemanticPlacement(win, x, y, force = false, targetMonitor = null) {
        // Numeric coordinates and left/top don't depend on the resulting size.
        const dependsOnSize = value => typeof value === 'string' &&
            value !== 'left' && value !== 'top';
        if (!force && !dependsOnSize(x) && !dependsOnSize(y))
            return;

        const monitor = targetMonitor ?? win.get_monitor();
        let arrived = win.get_monitor() === monitor;
        const workspace = global.workspace_manager.get_active_workspace();
        const pending = {idleId: 0, timeoutId: 0, signalIds: []};
        this._placements.set(win, pending);

        const queueCorrection = () => {
            if (pending.idleId)
                return;
            pending.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                pending.idleId = 0;
                if (win.get_monitor() !== monitor) {
                    // Monitor movement may complete after the resize request.
                    // Wait for its notification, but stop tracking if the window
                    // leaves the destination after it has arrived there.
                    if (arrived || targetMonitor === null)
                        this._cancelPlacement(win);
                    return GLib.SOURCE_REMOVE;
                }
                arrived = true;
                if (global.workspace_manager.get_active_workspace() !== workspace ||
                    win.is_fullscreen() || this._isMaximized(win)) {
                    this._cancelPlacement(win);
                    return GLib.SOURCE_REMOVE;
                }

                const wa = workspace.get_work_area_for_monitor(monitor);
                const rect = win.get_frame_rect();
                const px = x === null ? rect.x : wa.x + this._resolvePos(x, wa.width, rect.width);
                const py = y === null ? rect.y : wa.y + this._resolvePos(y, wa.height, rect.height);
                // Only move: requesting the size again can trigger another rounding.
                if (px !== rect.x || py !== rect.y)
                    win.move_frame(true, px, py);
                return GLib.SOURCE_REMOVE;
            });
        };

        // Connect before requesting a resize, including synchronous size changes.
        pending.signalIds.push(win.connect('size-changed', queueCorrection));
        pending.signalIds.push(win.connect('notify::main-monitor', queueCorrection));
        // A delayed Wayland configure can restore the requested position without
        // changing size again. Recheck that position too, until the deadline.
        pending.signalIds.push(win.connect('position-changed', queueCorrection));
        pending.signalIds.push(win.connect('unmanaged', () => this._cancelPlacement(win)));
        pending.signalIds.push(win.connect('workspace-changed', () => this._cancelPlacement(win)));
        pending.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACEMENT_TIMEOUT_MS, () => {
            pending.timeoutId = 0;
            this._cancelPlacement(win);
            return GLib.SOURCE_REMOVE;
        });
        // Also cover a refused resize or an already matching size (no signal).
        queueCorrection();
    }

    // Get the current window
    _getFocusedWindow() {
        const win = global.display.get_focus_window();
        return win ?? null;
    }

    // GNOME 50: unmaximize() clears both directions; retain the optional
    // untile hook where available for tiled windows.
    _ensureResizableMovable(win) {
        if (this._isMaximized(win))
            win.unmaximize();
        if (typeof win.untile === 'function')
            win.untile();
    }

    // Keep the existing two-step move/resize request; semantic placement is
    // corrected separately once the client has applied its size constraints.
    _applyMoveResizeInWorkArea(win, dx, dy, width = null, height = null, semantic = null, destination = null) {
        this._cancelPlacement(win);
        const workspace = global.workspace_manager.get_active_workspace();
        const wa = destination?.wa ?? workspace.get_work_area_for_monitor(win.get_monitor());
        const moving = destination && destination.monitor !== win.get_monitor();

        if (semantic || moving) {
            const x = moving ? semantic?.x ?? dx : semantic.x;
            const y = moving ? semantic?.y ?? dy : semantic.y;
            this._watchSemanticPlacement(win, x, y, Boolean(moving), destination?.monitor ?? null);
        }
        this._ensureResizableMovable(win);
        if (moving)
            win.move_to_monitor(destination.monitor);

        const rect = win.get_frame_rect();

        // If dx/dy are null, maintain current position
        const x = (dx !== null) ? wa.x + dx : rect.x;
        const y = (dy !== null) ? wa.y + dy : rect.y;

        // ① move (if necessary)
        if (dx !== null || dy !== null) {
            win.move_resize_frame(
                true,
                x,
                y,
                rect.width,
                rect.height
            );
        }

        // ② resize (if necessary)
        if (width !== null && height !== null) {
            win.move_resize_frame(
                true,
                x,
                y,
                width,
                height
            );
        }
    }

    // Number-like strings are number
    _normalizeNullable(value) {
        if (value === null || value === 'null')
            return null;

        if (!isNaN(value))
            return Number(value);

        return value;
    }

    // positional vocabulary
    _resolvePos(value, total, windowSize) {
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
    _resolveSize(value, total) {
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

    // D-Bus method: GetWorkArea() -> (i, i, i, i)
    GetWorkArea() {
        const win = this._getFocusedWindow();
        if (!win)
            return [0, 0, 0, 0];

        const monitor = win.get_monitor();

        const workspace =
            global.workspace_manager.get_active_workspace();

        const wa =
            workspace.get_work_area_for_monitor(monitor);
        // wa = { x, y, width, height }

        return [wa.x, wa.y, wa.width, wa.height];
    }

    // D-Bus method: ResizeInWorkArea(i, i) -> b
    ResizeInWorkArea(width, height) {
        width = Math.max(50, width | 0);
        height = Math.max(50, height | 0);

        const win = this._getFocusedWindow();
        if (!win)
            return false;

        this._perform([win], () => this._applyMoveResizeInWorkArea(win, null, null, width, height));
        return true;
    }

    // D-Bus method: MoveInWorkArea(i, i) -> b
    MoveInWorkArea(x, y) {
        const win = this._getFocusedWindow();
        if (!win)
            return false;

        this._perform([win], () => this._applyMoveResizeInWorkArea(win, x | 0, y | 0));
        return true;
    }

    // D-Bus method: MoveResizeInWorkArea(i, i, i, i) -> b
    MoveResizeInWorkArea(x, y, width, height) {
        const win = this._getFocusedWindow();
        if (!win)
            return false;

        this._perform([win], () => this._applyMoveResizeInWorkArea(
            win,
            x | 0,
            y | 0,
            Math.max(50, width | 0),
            Math.max(50, height | 0)
        ));
        return true;
    }

    // D-Bus method: MoveToMonitor(i) -> b
    MoveToMonitor(monitor) {
        const win = this._getFocusedWindow();
        if (!win)
            return false;

        const n = global.display.get_n_monitors();
        if (monitor < 0 || monitor >= n)
            return false;

        this._perform([win], () => {
            this._cancelPlacement(win);
            win.move_to_monitor(monitor);
        });
        return true;
    }

    _rect(win) {
        const rect = win.get_frame_rect();
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    }

    _maximizeFlags(win) {
        return win.get_maximize_flags();
    }

    // Capture every target before mutating any of them. A partially failed
    // operation remains undoable; no automatic rollback races Wayland replies.
    _perform(windows, execute, restoreStack = false, geometryWindows = windows) {
        const ordered = restoreStack ? global.display.sort_windows_by_stacking(windows) : windows;
        const states = ordered.map(win => ({
            win, rect: this._rect(win), monitor: win.get_monitor(),
            workspace: win.get_workspace(), maximized: this._maximizeFlags(win),
            fullscreen: win.is_fullscreen(), restoreStack, stackOnly: !geometryWindows.includes(win),
        }));
        this._history.push(states);
        execute();
    }

    UndoLastOperation() {
        const operation = this._history.peekOperation();
        if (!operation)
            return false;
        let restored = false;
        for (const state of [...operation.states]) {
            if (!this._history.has(operation) || !operation.states.includes(state))
                continue;
            try {
                const changed = this._restoreState(state);
                restored = changed || restored;
                this._history.consume(operation, state, changed);
            } catch (error) {
                this._cancelPlacement(state.win);
                console.error('Active Window Layout: could not undo a window operation', error);
            }
        }
        // Restore all target windows' original relative order only once every
        // geometry request has succeeded (or been intentionally skipped).
        if (this._history.has(operation) && !operation.states.length) {
            try {
                restored = this._restoreStack(operation) || restored;
            } catch (error) {
                // Keep the entire order so retrying a failed raise() starts
                // back-to-front again, including previously raised windows.
                console.error('Active Window Layout: could not restore stacking', error);
            }
        }
        return restored;
    }

    _restoreStack(operation) {
        let raised = false;
        for (const state of [...operation.stacking]) {
            if (!this._history.has(operation) || !operation.stacking.includes(state))
                continue;
            const {win} = state;
            if (win.get_workspace() !== state.workspace || win.get_monitor() !== state.monitor) {
                this._history.skipStackState(operation, state);
                continue;
            }
            win.raise();
            raised = true;
        }
        this._history.completeStack(operation);
        return raised;
    }

    _restoreState(state) {
        const {win, rect} = state;
        // Closed windows have already been removed by OperationHistory.
        // Do not move windows back from a manually selected workspace.
        if (win.get_workspace() !== state.workspace ||
            state.monitor < 0 || state.monitor >= global.display.get_n_monitors())
            return false;
        Layout.validateRect(rect, 1);
        this._cancelPlacement(win);
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        this._ensureResizableMovable(win);
        if (win.get_monitor() !== state.monitor)
            win.move_to_monitor(state.monitor);
        if (!state.maximized && !state.fullscreen &&
            global.workspace_manager.get_active_workspace() === state.workspace) {
            const wa = state.workspace.get_work_area_for_monitor(state.monitor);
            this._watchSemanticPlacement(win, rect.x - wa.x, rect.y - wa.y, true, state.monitor);
        }
        win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        if (state.maximized)
            win.set_maximize_flags(state.maximized);
        if (state.fullscreen)
            win.make_fullscreen();
        return true;
    }

    // Resolve targets and read geometry once, before condition evaluation.
    _context(needsApp) {
        const focused = this._getFocusedWindow();
        if (!focused)
            return null;
        const workspace = global.workspace_manager.get_active_workspace();
        const monitor = focused.get_monitor();
        const wa = workspace.get_work_area_for_monitor(monitor);
        const eligible = win => win.get_window_type() === Meta.WindowType.NORMAL &&
            win.get_transient_for() === null && !win.skip_taskbar &&
            !win.minimized && !win.is_fullscreen() &&
            win.located_on_workspace(workspace) && win.get_monitor() === monitor &&
            win.allows_move() && (win.allows_resize() ||
                (this._isMaximized(win) && win.resizeable));
        let windows = [];
        if (needsApp && eligible(focused)) {
            const app = Shell.WindowTracker.get_default().get_window_app(focused);
            windows = [...new Set(app?.get_windows() ?? [])].filter(eligible);
            if (!windows.includes(focused))
                windows = [];
            if (windows.length > Layout.MAX_WINDOWS)
                throw new Error(`At most ${Layout.MAX_WINDOWS} windows can be arranged`);
            windows.sort((a, b) => a === b ? 0 : a === focused ? -1 : b === focused ? 1 :
                a.get_stable_sequence() - b.get_stable_sequence());
        }
        const read = win => ({win, rect: this._rect(win), monitor: win.get_monitor(),
            maximized: this._maximizeFlags(win)});
        return {focused, wa, workspace, monitor, active: read(focused), activeEligible: eligible(focused),
            windows: windows.map(read)};
    }

    _matches(condition, context, defaultTolerance) {
        const delta = condition.tolerance ?? defaultTolerance;
        if (condition.target === 'active')
            return context.activeEligible &&
                (condition.monitor === undefined || condition.monitor === context.active.monitor) &&
                Layout.matchesActive(condition, context.active.rect, context.wa, delta);
        if (!context.windows.length || (condition.monitor !== undefined &&
            context.windows.some(state => state.monitor !== condition.monitor)))
            return false;
        if (condition.layout === undefined)
            return true;
        if (context.windows.some(state => state.maximized))
            return false;
        let cells;
        try {
            cells = Layout.planLayout(condition, context.windows.length, context.wa);
        } catch {
            // A valid layout that cannot fit this monitor is not the current layout.
            return false;
        }
        return Layout.matchesLayout(context.windows.map(state => state.rect), cells, delta);
    }

    _plan(action, context) {
        const monitor = action.monitor ?? context.monitor;
        if (monitor >= global.display.get_n_monitors())
            throw new Error(`Monitor ${monitor} does not exist`);
        const moving = monitor !== context.monitor;
        const wa = moving ? context.workspace.get_work_area_for_monitor(monitor) : context.wa;
        if (action.target === 'active') {
            if (!context.activeEligible)
                return [];
            const rect = Layout.planActive(action, context.active.rect, wa, moving ? context.wa : null);
            const unchanged = !moving && Layout.sameRect(rect, context.active.rect) && !context.active.maximized;
            const plan = unchanged ? [] : [{win: context.focused, rect, monitor, wa,
                semantic: {x: action.x ?? null, y: action.y ?? null}}];
            if (action.bringToFront === 'same-app') {
                // Snapshot the source group; peers are raised without geometry changes.
                for (const state of context.windows) {
                    let item = plan.find(entry => entry.win === state.win);
                    if (!item) {
                        item = {win: state.win, stackOnly: true};
                        plan.push(item);
                    }
                    item.raise = true;
                    item.front = state.win === context.focused;
                }
            }
            return plan;
        }
        if (!context.windows.length)
            return [];
        const cells = Layout.planLayout(action, context.windows.length, wa);
        const states = action.layout === 'cascade' ?
            [...context.windows.slice(1), context.windows[0]] : context.windows;
        return states.map((state, index) => ({win: state.win, rect: cells[index], monitor, wa,
            raise: true, front: state.win === context.focused}));
    }

    _executePlan(plan, wa) {
        if (!plan.length)
            return false;
        for (const item of plan) {
            if (!item.stackOnly)
                Layout.validateRect(item.rect);
        }
        this._perform(plan.map(item => item.win), () => {
            for (const {win, rect, semantic, monitor, stackOnly, wa: targetArea = wa} of plan) {
                if (stackOnly)
                    continue;
                const destination = monitor === undefined ? null : {monitor, wa: targetArea};
                this._applyMoveResizeInWorkArea(win, rect.x - targetArea.x, rect.y - targetArea.y,
                    rect.width, rect.height, semantic, destination);
            }
            // Keep geometry order independent of stacking order: grid's active
            // window stays in the first cell but must be raised last.
            const backToFront = [
                ...plan.filter(item => item.raise && !item.front),
                ...plan.filter(item => item.raise && item.front),
            ];
            // Keep the workspace's next-focus order aligned with the visible
            // stack, without activating each window or moving keyboard focus.
            const workspace = global.workspace_manager.get_active_workspace();
            for (const {win} of backToFront)
                win.raise_and_make_recent_on_workspace(workspace);
        }, plan.some(item => item.raise), plan.filter(item => !item.stackOnly).map(item => item.win));
        return true;
    }

    ArrangeSameApp(json) {
        const action = Layout.parseArrangement(json);
        const context = this._context(true);
        return context ? this._executePlan(this._plan(action, context), context.wa) : false;
    }

    MoveResizeConditional(json) {
        const config = Layout.parseRules(json);
        const needsApp = config.rules.some(rule =>
            rule.when?.target === 'same-app' || rule.then.target === 'same-app' ||
            rule.then.bringToFront === 'same-app');
        const context = this._context(needsApp);
        if (!context)
            return false;
        const rule = config.rules.find(candidate =>
            !candidate.when || this._matches(candidate.when, context, config.tolerance));
        return rule ? this._executePlan(this._plan(rule.then, context), context.wa) : false;
    }

    // D-Bus method: MoveResizeSemantic(s, s, s, s) -> b
    MoveResizeSemantic(x, y, width, height) {
        const win = this._getFocusedWindow();
        if (!win)
            return false;

        const workspace = global.workspace_manager.get_active_workspace();
        const wa = workspace.get_work_area_for_monitor(win.get_monitor());
        const rect = win.get_frame_rect();

        // "null" → normalized to null
        const nx = this._normalizeNullable(x);
        const ny = this._normalizeNullable(y);
        const nw = this._normalizeNullable(width);
        const nh = this._normalizeNullable(height);

        // 1. Resolve size first
        const pw = nw !== null ? this._resolveSize(nw, wa.width) : rect.width;
        const ph = nh !== null ? this._resolveSize(nh, wa.height) : rect.height;

        // 2. Use the requested size initially, then correct using the actual size.
        const px = nx !== null ? this._resolvePos(nx, wa.width, pw) : null;
        const py = ny !== null ? this._resolvePos(ny, wa.height, ph) : null;

        this._perform([win], () =>
            this._applyMoveResizeInWorkArea(win, px, py, pw, ph, {x: nx, y: ny}));
        return true;
    }

}

export default class MyDbusExtension extends Extension {
    enable() {
        this._impl = new ServiceImpl();
        this._dbusObj = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this._impl);
        this._dbusObj.export(Gio.DBus.session, OBJECT_PATH);
        this._nameOwnerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null
        );
    }

    disable() {
        this._impl?.destroy();
        if (this._nameOwnerId) {
            Gio.bus_unown_name(this._nameOwnerId);
            this._nameOwnerId = 0;
        }

        if (this._dbusObj) {
            this._dbusObj.unexport();
            this._dbusObj = null;
        }

        this._impl = null;
    }
}
