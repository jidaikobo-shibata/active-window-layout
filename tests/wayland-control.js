// Test-only companion extension. Never included in the release ZIP.
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'active-window-layout@jidaikobo.shibata';
const NAME = 'org.example.ActiveWindowLayoutTest';
const PATH = '/org/example/ActiveWindowLayoutTest';
const XML = `<node><interface name="${NAME}">
    <method name="Inspect"><arg type="s" direction="out"/></method>
    <method name="Focus"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
    <method name="Maximize"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
    <method name="Close"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
    <method name="FailUndo"><arg type="i" direction="in"/><arg type="b" direction="in"/>
        <arg type="b" direction="out"/></method>
</interface></node>`;

class Control {
    constructor() {
        this.failures = new Map();
    }

    windows() {
        return global.get_window_actors().map(actor => actor.meta_window)
            .filter(win => win.get_title()?.startsWith('AWL Test'))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    window(id) {
        const win = this.windows().find(item => item.get_stable_sequence() === id);
        if (!win)
            throw new Error('Test window not found');
        return win;
    }

    Inspect() {
        const service = Extension.lookupByUUID(UUID)?._impl;
        return JSON.stringify({history: service?._history.size,
            stacking: global.display.sort_windows_by_stacking(this.windows())
                .map(win => win.get_stable_sequence()),
            pendingUndo: service?._history.peek().map(state => state.win.get_stable_sequence()),
            windows: this.windows().map(win => {
                const rect = win.get_frame_rect();
                return {id: win.get_stable_sequence(), focus: win.has_focus(),
                    maximized: win.get_maximize_flags(), canResize: win.allows_resize(),
                    app: Shell.WindowTracker.get_default().get_window_app(win)?.get_id(),
                    monitor: win.get_monitor(),
                    rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}};
            })});
    }

    Focus(id) {
        Main.overview.hide();
        this.window(id).activate(global.get_current_time());
        return true;
    }

    Maximize(id) {
        this.window(id).maximize();
        return true;
    }

    Close(id) {
        this.window(id).delete(global.get_current_time());
        return true;
    }

    FailUndo(id, fail) {
        const win = this.window(id);
        if (fail && !this.failures.has(win)) {
            this.failures.set(win, win.move_resize_frame);
            win.move_resize_frame = () => { throw new Error('AWL injected undo failure'); };
        } else if (!fail && this.failures.has(win)) {
            win.move_resize_frame = this.failures.get(win);
            this.failures.delete(win);
        }
        return true;
    }

    destroy() {
        for (const [win, original] of this.failures)
            win.move_resize_frame = original;
        this.failures.clear();
    }
}

export default class TestExtension extends Extension {
    enable() {
        this.control = new Control();
        this.object = Gio.DBusExportedObject.wrapJSObject(XML, this.control);
        this.object.export(Gio.DBus.session, PATH);
        this.owner = Gio.bus_own_name_on_connection(Gio.DBus.session, NAME,
            Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        this.control.destroy();
        this.object.unexport();
        Gio.bus_unown_name(this.owner);
    }
}
