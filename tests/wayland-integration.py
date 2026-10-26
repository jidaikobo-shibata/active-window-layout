#!/usr/bin/env python3
"""Install a release ZIP into an isolated, invisible GNOME 50 Wayland session.

Requires gnome-shell, gnome-extensions, dbus-run-session, python3-gi and GTK 4.
The companion extension controls only disposable test windows. Production code
is installed from the ZIP and is never patched. Artifacts remain in /tmp.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile

UUID = 'active-window-layout@jidaikobo.shibata'
CONTROL_UUID = 'awl-test-control@local.test'
DEST = 'org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout'
OBJECT = '/org/gnome/Shell/Extensions/jidaikobo/shibata/ActiveWindowLayout'


def check():
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def call(method, signature='()', args=(), control=False):
        name = 'org.example.ActiveWindowLayoutTest' if control else DEST
        path = '/org/example/ActiveWindowLayoutTest' if control else OBJECT
        return bus.call_sync(name, path, name, method, GLib.Variant(signature, args),
                             None, Gio.DBusCallFlags.NONE, 5000, None).unpack()

    def inspect():
        return json.loads(call('Inspect', control=True)[0])

    def settle():
        time.sleep(.5)

    def rects():
        return {w['id']: w['rect'] for w in inspect()['windows']}

    def expect_same(expected):
        for key, value in rects().items():
            assert value == expected[key], (key, value, expected[key])

    def conditional(rules):
        return call('MoveResizeConditional', '(s)', (json.dumps({'rules': rules}),))

    for _ in range(150):
        try:
            state = inspect()
            if (len(state['windows']) == 3 and len(state['otherWindows']) == 1 and
                    state['history'] is not None and
                    all(w['rect']['width'] > 0 for w in state['windows'])):
                break
        except GLib.Error:
            pass
        time.sleep(.2)
    else:
        raise RuntimeError('Extensions/windows did not start')
    time.sleep(1)
    ids = [w['id'] for w in state['windows']]
    call('Focus', '(i)', (ids[0],), True)
    settle()
    assert inspect()['windows'][0]['focus']
    other = inspect()['otherWindows'][0]
    assert other['app'] != inspect()['windows'][0]['app']
    for layout in ['grid', 'columns', 'rows', 'cascade']:
        call('Raise', '(i)', (other['id'],), True)
        settle()
        assert inspect()['allStacking'][-1] == other['id']
        assert call('ArrangeSameApp', '(s)', (json.dumps({'layout': layout}),)) == (True,)
        settle()
        arranged = inspect()
        assert set(arranged['allStacking'][-3:]) == set(ids), arranged
        assert arranged['allStacking'][-1] == ids[0], arranged
        assert arranged['windows'][0]['focus'], arranged
        assert arranged['otherWindows'][0]['rect'] == other['rect']
        assert call('UndoLastOperation') == (True,)
        settle()
    print('PASS: every layout raises the app group above another app and preserves focus', flush=True)
    for window_id in ids[:2]:
        call('Maximize', '(i)', (window_id,), True)
    settle()
    before = inspect()
    assert all(w['maximized'] == 3 and not w['canResize'] for w in before['windows'][:2])
    for api, payload in [
        ('ArrangeSameApp', {'layout': ['cascade']}),
        ('MoveResizeConditional', {'rules': [{'then': {'target': 'same-app', 'layout': ['cascade']}}]}),
        ('MoveResizeConditional', {'rules': [{'then': {'target': 'active', 'x': 2147483647}}]}),
    ]:
        try:
            call(api, '(s)', (json.dumps(payload),))
        except GLib.Error:
            pass
        else:
            raise AssertionError('Invalid request accepted: ' + api)
        settle()
        assert inspect() == before
    print('PASS: malformed input rejected without moving or unmaximizing', flush=True)
    assert conditional([{'then': {'target': 'active', 'width': 1000, 'height': 700}}]) == (True,)
    settle()
    assert inspect()['windows'][0]['maximized'] == 0
    assert rects()[ids[0]]['width'] == 1000
    assert call('UndoLastOperation') == (True,)
    settle()
    assert inspect()['windows'][0]['maximized'] == 3
    print('PASS: conditional resize from maximized state and undo', flush=True)
    original = rects()
    assert call('ArrangeSameApp', '(s)', ('{}',)) == (True,)
    settle()
    assert all(w['maximized'] == 0 for w in inspect()['windows'])
    assert all(r['width'] == 954 for r in rects().values())
    assert call('UndoLastOperation') == (True,)
    settle()
    expect_same(original)
    assert all(w['maximized'] == 3 for w in inspect()['windows'][:2])
    print('PASS: arrange maximized active/background windows and grouped undo', flush=True)
    rules = [
        {'when': {'target': 'same-app', 'layout': 'grid'},
         'then': {'target': 'same-app', 'layout': 'cascade'}},
        {'then': {'target': 'same-app', 'layout': 'grid'}},
    ]
    conditional(rules)
    settle()
    grid = rects()
    call('Focus', '(i)', (ids[2],), True)
    settle()
    grid_stack = inspect()['stacking']
    conditional(rules)
    settle()
    assert all(r['width'] == 1344 for r in rects().values())
    call('FailUndo', '(ib)', (ids[1], True), True)
    assert call('UndoLastOperation') == (True,)
    settle()
    partial = inspect()
    assert partial['pendingUndo'] == [ids[1]], partial
    assert partial['history'] == 2
    for window_id in [ids[0], ids[2]]:
        assert rects()[window_id] == grid[window_id]
    assert call('UndoLastOperation') == (False,)
    assert inspect()['history'] == 2
    call('FailUndo', '(ib)', (ids[1], False), True)
    assert call('UndoLastOperation') == (True,)
    settle()
    expect_same(grid)
    assert inspect()['stacking'] == grid_stack, inspect()
    assert inspect()['history'] == 1
    print('PASS: grid/cascade after focus change; failed undo retried with original stacking', flush=True)
    # One conditional call moves/resizes using the destination work area.
    call('Focus', '(i)', (ids[0],), True)
    settle()
    before_monitors = rects()
    history_before = inspect()['history']
    assert conditional([
        {'when': {'target': 'active', 'monitor': 0},
         'then': {'target': 'active', 'monitor': 1, 'x': 'center', 'y': 'center',
                  'width': '50%', 'height': '70%'}},
    ]) == (True,)
    settle()
    assert inspect()['windows'][0]['monitor'] == 1
    target_x, target_y, target_w, target_h = call('GetWorkArea')
    placed = rects()[ids[0]]
    assert placed == {'x': target_x + (target_w - target_w//2)//2,
                      'y': target_y + (target_h - target_h*70//100)//2,
                      'width': target_w//2, 'height': target_h*70//100}, placed
    assert inspect()['history'] == history_before + 1
    assert call('UndoLastOperation') == (True,)
    settle()
    expect_same(before_monitors)
    assert inspect()['windows'][0]['monitor'] == 0
    assert inspect()['history'] == history_before
    print('PASS: monitor condition, destination percentages/centering and one-call undo', flush=True)

    # A same-app peer already on the destination is not added to this operation.
    call('Focus', '(i)', (ids[1],), True)
    settle()
    call('MoveToMonitor', '(i)', (1,))
    settle()
    peer_rect = rects()[ids[1]]
    call('Focus', '(i)', (ids[0],), True)
    settle()
    assert conditional([
        {'when': {'target': 'same-app', 'monitor': 0},
         'then': {'target': 'same-app', 'monitor': 1, 'layout': 'columns'}},
    ]) == (True,)
    settle()
    assert all(w['monitor'] == 1 for w in inspect()['windows'])
    assert rects()[ids[1]] == peer_rect
    for window_id in [ids[0], ids[2]]:
        assert rects()[window_id]['width'] == (target_w - 12)//2
    call('UndoLastOperation')
    settle()
    assert [w['monitor'] for w in inspect()['windows']] == [0, 1, 0]
    assert rects()[ids[1]] == peer_rect
    call('UndoLastOperation')
    settle()
    expect_same(before_monitors)
    assert all(w['monitor'] == 0 for w in inspect()['windows'])
    assert inspect()['history'] == history_before
    print('PASS: source-group monitor transfer leaves destination peer unchanged', flush=True)

    original_stack = inspect()['stacking']
    assert conditional([{'then': {'target': 'same-app', 'monitor': 1, 'layout': 'cascade'}}]) == (True,)
    settle()
    assert all(w['monitor'] == 1 for w in inspect()['windows'])
    assert all(r['width'] == target_w*70//100 for r in rects().values())
    assert call('UndoLastOperation') == (True,)
    settle()
    expect_same(before_monitors)
    assert all(w['monitor'] == 0 for w in inspect()['windows'])
    assert inspect()['stacking'] == original_stack
    print('PASS: cascade monitor transfer and grouped monitor/geometry/stack undo', flush=True)

    conditional(rules)
    settle()
    call('Close', '(i)', (ids[1],), True)
    settle()
    assert call('UndoLastOperation') == (True,)
    settle()
    expect_same(grid)
    print('PASS: closed target skipped during grouped undo', flush=True)
    call('Focus', '(i)', (ids[0],), True)
    settle()
    assert call('MoveResizeSemantic', '(ssss)', ('center', 'center', '1000', '700')) == (True,)
    settle()
    previous = rects()
    assert call('MoveToMonitor', '(i)', (1,)) == (True,)
    settle()
    assert inspect()['windows'][0]['monitor'] == 1
    assert call('UndoLastOperation') == (True,)
    settle()
    assert inspect()['windows'][0]['monitor'] == 0
    expect_same(previous)
    print('PASS: legacy semantic placement and monitor move/undo', flush=True)
    # Reproduce the reported close sequence with another app between group
    # windows in the workspace's recent-use order, then close the group in turn.
    for layout in ['grid', 'columns', 'rows', 'cascade']:
        missing = 3 - len(inspect()['windows'])
        for _ in range(missing):
            bus.call_sync('org.example.AwlTest', '/org/example/AwlTest', 'org.gtk.Actions',
                          'Activate', GLib.Variant('(sava{sv})', ('new-window', [], {})),
                          None, Gio.DBusCallFlags.NONE, 5000, None)
        for _ in range(50):
            group = inspect()['windows']
            if len(group) == 3 and all(w['rect']['width'] > 0 for w in group):
                break
            time.sleep(.1)
        else:
            raise AssertionError('Could not create three close-test windows')
        group_ids = [w['id'] for w in group]
        for window in group:
            if window['monitor'] != 0:
                call('Focus', '(i)', (window['id'],), True)
                settle()
                call('MoveToMonitor', '(i)', (0,))
                settle()
        other_id = inspect()['otherWindows'][0]['id']
        for window_id in [group_ids[0], other_id, group_ids[1], other_id, group_ids[2]]:
            call('Focus', '(i)', (window_id,), True)
            settle()
        assert call('ArrangeSameApp', '(s)', (json.dumps({'layout': layout}),)) == (True,)
        settle()
        arranged = inspect()
        assert next(w['id'] for w in arranged['windows'] if w['focus']) == group_ids[2]
        for remaining in [3, 2, 1]:
            current = inspect()
            assert len(current['windows']) == remaining, current
            focused = [w for w in current['windows'] if w['focus']]
            assert len(focused) == 1, ('focus left group while windows remain', layout, current)
            call('Close', '(i)', (focused[0]['id'],), True)
            settle()
        current = inspect()
        assert not current['windows'] and current['otherWindows'][0]['focus'], current
        print('PASS: '+layout+' closes all group windows before switching to the other app', flush=True)
    print('INTEGRATION PASSED', flush=True)


def main():
    project = Path(__file__).resolve().parent.parent
    root = Path(tempfile.mkdtemp(prefix='awl-release-test-'))
    print(root, flush=True)
    packages = root / 'packages'
    subprocess.run(['bash', str(project / 'scripts/pack.sh'), str(packages)], check=True)
    archive = packages / f'{UUID}.shell-extension.zip'
    bridge = root / 'data/gnome-shell/extensions' / CONTROL_UUID
    bridge.mkdir(parents=True)
    shutil.copy(project / 'tests/wayland-control.js', bridge / 'extension.js')
    (bridge / 'metadata.json').write_text(json.dumps({
        'uuid': CONTROL_UUID, 'name': 'AWL test control', 'description': 'Disposable test control',
        'shell-version': ['50'],
    }))
    (root / 'gtk.py').write_text("""import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gio
app = Gtk.Application(application_id='org.example.AwlTest')
serial = 0
def new_window(app):
    global serial
    serial += 1
    win = Gtk.ApplicationWindow(application=app, title=f'AWL Test {serial}')
    win.set_default_size(800+(serial-1)*50, 600+(serial-1)*20)
    win.set_child(Gtk.Label(label=f'Test window {serial}'))
    win.present()
def activate(app):
    for i in range(3):
        new_window(app)
action = Gio.SimpleAction.new('new-window', None)
action.connect('activate', lambda *_: new_window(app))
app.add_action(action)
app.connect('activate', activate)
app.hold()
app.run(None)
""")
    (root / 'other-gtk.py').write_text((root / 'gtk.py').read_text()
        .replace('org.example.AwlTest', 'org.example.AwlOther')
        .replace('AWL Test', 'AWL Other').replace('range(3)', 'range(1)'))
    (root / 'session.sh').write_text('''#!/bin/bash
set -euo pipefail
gnome-extensions install "$AWL_TEST_ROOT/packages/active-window-layout@jidaikobo.shibata.shell-extension.zip"
gsettings set org.gnome.shell enabled-extensions \\
    "['active-window-layout@jidaikobo.shibata', 'awl-test-control@local.test']"
gsettings set org.gnome.shell disable-user-extensions false
gnome-shell --headless --wayland --no-x11 \\
    --virtual-monitor=1920x1080 --virtual-monitor=1600x900 \\
    --wayland-display=awl-test >"$AWL_TEST_ROOT/shell.log" 2>&1 &
shell_pid=$!
app_pid=''
other_pid=''
trap 'if [ -n "$other_pid" ]; then kill "$other_pid" 2>/dev/null || true; fi; if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || true; fi; kill "$shell_pid" 2>/dev/null || true' EXIT
for i in {1..100}; do
    if [ -S "$XDG_RUNTIME_DIR/awl-test" ]; then break; fi
    sleep .2
done
export WAYLAND_DISPLAY=awl-test
export GDK_BACKEND=wayland
/usr/bin/python3 "$AWL_TEST_ROOT/gtk.py" >"$AWL_TEST_ROOT/app.log" 2>&1 &
app_pid=$!
/usr/bin/python3 "$AWL_TEST_ROOT/other-gtk.py" >"$AWL_TEST_ROOT/other-app.log" 2>&1 &
other_pid=$!
/usr/bin/python3 "$AWL_TEST_SCRIPT" --check
''')
    env = os.environ.copy()
    for key in ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'SESSION_MANAGER']:
        env.pop(key, None)
    env.update(AWL_TEST_ROOT=str(root), AWL_TEST_SCRIPT=str(Path(__file__).resolve()),
               GSETTINGS_BACKEND='keyfile', GTK_A11Y='none', GIO_USE_VFS='local')
    for key, directory in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                           ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime')]:
        (root / directory).mkdir(exist_ok=True, mode=0o700)
        env[key] = str(root / directory)
    with (root / 'result.log').open('w') as log:
        process = subprocess.Popen(['dbus-run-session', '--', 'bash', str(root / 'session.sh')],
                                   env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            result = process.wait(timeout=90)
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    print((root / 'result.log').read_text())
    if result:
        raise SystemExit(result)
    # Ensure the tested production extension is byte-for-byte the release ZIP.
    installed = root / 'data/gnome-shell/extensions' / UUID
    with zipfile.ZipFile(archive) as contents:
        for name in contents.namelist():
            assert (installed / name).read_bytes() == contents.read(name), name
    print('PASS: installed production files are identical to the release ZIP', flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        check()
    else:
        main()
