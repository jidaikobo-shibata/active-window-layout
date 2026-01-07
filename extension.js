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
  </interface>
</node>`;

// 公開する well-known name と object path
const BUS_NAME = 'org.jidaikobo.shibata.ActiveWindowLayout';
const OBJECT_PATH = '/org/jidaikobo/shibata/ActiveWindowLayout';

class ServiceImpl {
  // 現在のウィンドウの取得
  _getFocusedWindow() {
    const win = global.display.get_focus_window();
    return win ?? null;
  }

  // 最大化中だと move/resize が効かないことが多いので解除
  // タイル（スナップ）状態だと制約されることがあるので解除
  // 環境によってメソッド有無があるので存在チェック
  _ensureResizableMovable(win) {
    if (win.get_maximized && win.get_maximized() !== 0)
      win.unmaximize(Meta.MaximizeFlags.BOTH);

    if (typeof win.untile === 'function')
      win.untile();
  }

  // moveとresizeの実行。Mutterの仕様により、2段階で動かす必要がある
  _applyMoveResizeInWorkArea(win, dx, dy, width = null, height = null) {
    const workspace = global.workspace_manager.get_active_workspace();
    const wa = workspace.get_work_area_for_monitor(win.get_monitor());

    this._ensureResizableMovable(win);

    const rect = win.get_frame_rect();

    // dx/dy が null の場合は現在位置を維持
    const x = (dx !== null) ? wa.x + dx : rect.x;
    const y = (dy !== null) ? wa.y + dy : rect.y;

    // ① move（必要なら）
    if (dx !== null || dy !== null) {
      win.move_resize_frame(
        true,
        x,
        y,
        rect.width,
        rect.height
      );
    }

    // ② resize（必要な場合のみ）
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
