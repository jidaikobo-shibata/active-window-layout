import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// D-Bus Introspection XML
const IFACE_XML = `
<node>
  <interface name="org.jidaikobo.shibata.ActiveWindowLayout">
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
const BUS_NAME = 'org.jidaikobo.shibata.ActiveWindowLayout';
const OBJECT_PATH = '/org/jidaikobo/shibata/ActiveWindowLayout';

class ServiceImpl {
  // Get the current window
  _getFocusedWindow() {
    const win = global.display.get_focus_window();
    return win ?? null;
  }

  // Move/resize often doesn't work when maximized, so disable it.
  // Tile (snap) mode can be restrictive, so disable it.
  // Check for existence of methods, as they may not be available depending on the environment.
  _ensureResizableMovable(win) {
    if (win.get_maximized && win.get_maximized() !== 0)
      win.unmaximize(Meta.MaximizeFlags.BOTH);

    if (typeof win.untile === 'function')
      win.untile();
  }

  // Execute move and resize. Due to Mutter's specifications, this must be done in two steps.
  _applyMoveResizeInWorkArea(win, dx, dy, width = null, height = null) {
    const workspace = global.workspace_manager.get_active_workspace();
    const wa = workspace.get_work_area_for_monitor(win.get_monitor());

    this._ensureResizableMovable(win);

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

    this._applyMoveResizeInWorkArea(win, null, null, width, height);
    return true;
  }

  // D-Bus method: MoveInWorkArea(i, i) -> b
  MoveInWorkArea(x, y) {
    const win = this._getFocusedWindow();
    if (!win)
      return false;

    this._applyMoveResizeInWorkArea(win, x | 0, y | 0);
    return true;
  }

  // D-Bus method: MoveResizeInWorkArea(i, i, i, i) -> b
  MoveResizeInWorkArea(x, y, width, height) {
    const win = this._getFocusedWindow();
    if (!win)
      return false;

    this._applyMoveResizeInWorkArea(
      win,
      x | 0,
      y | 0,
      Math.max(50, width | 0),
      Math.max(50, height | 0)
    );
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

    win.move_to_monitor(monitor);
    return true;
  }

  // D-Bus method: MoveResizeSemantic(s, s, s, s) -> b
  MoveResizeSemantic(x, y, width, height) {
    const win = this._getFocusedWindow();
    if (!win)
      return false;

    const workspace = global.workspace_manager.get_active_workspace();
    const wa = workspace.get_work_area_for_monitor(win.get_monitor());

    // "null" → normalized to null
    const nx = this._normalizeNullable(x);
    const ny = this._normalizeNullable(y);
    const nw = this._normalizeNullable(width);
    const nh = this._normalizeNullable(height);

    // 1. Resolve size first
    const pw = nw !== null ? this._resolveSize(nw, wa.width) : rect.width;
    const ph = nh !== null ? this._resolveSize(nh, wa.height) : rect.height;

    // 2. Position is resolved using "final size"
    const px = nx !== null ? this._resolvePos(nx, wa.width, pw) : null;
    const py = ny !== null ? this._resolvePos(ny, wa.height, ph) : null;

    this._applyMoveResizeInWorkArea(win, px, py, pw, ph);
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
