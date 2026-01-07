# Active Window Layout

**Active Window Layout** is a GNOME Shell extension that provides
**Work Area–based window layout control via D-Bus**.

This extension exposes a small, stable D-Bus API that allows external tools (such as key remappers or scripts) to move and resize the **currently focused window** in a way that respects GNOME/Mutter constraints.

This extension does not provide a graphical user interface. It is intended to be used as a backend service for external tools such as key remappers or scripts.

It is designed to provide a stable and predictable interface under Wayland.

## Motivation

GNOME Shell does not provide a stable external API for window manipulation.
Directly controlling windows from scripts or key remappers often leads to:

- Unpredictable behavior under Wayland
- Broken positioning when panels or docks are present
- Inconsistent results across monitors
- Mutter-specific quirks (e.g. move/resize ordering)

## Design Principles

- **Active window only**
  The service always operates on the currently focused window.

- **Work Area–based**
  All geometry is calculated relative to the Work Area
  (excluding panels, docks, etc.).

- **Mutter-safe**
  Internally handles:
  - unmaximizing
  - untiling
  - move → resize ordering

- **External control**
  Intended to be called from:
  - `gdbus`
  - key remappers (e.g. xremap)
  - shell scripts

## D-Bus Service

### Service Name

```

org.jidaikobo.shibata.ActiveWindowLayout

```

### Object Path

```

/org/jidaikobo/shibata/ActiveWindowLayout

```

### Interface

```

org.jidaikobo.shibata.ActiveWindowLayout

```

## Provided Methods

### `GetWorkArea() → (x, y, width, height)`

Returns the Work Area of the monitor that currently contains the active window.

### `MoveInWorkArea(x, y) → ok`

Moves the active window to `(x, y)` relative to the Work Area origin.

### `ResizeInWorkArea(width, height) → ok`

Resizes the active window while keeping its current position.

### `MoveResizeInWorkArea(x, y, width, height) → ok`

Moves and resizes the active window in a Work Area–relative manner.

### `MoveToMonitor(monitor) → ok`

Moves the active window to the specified monitor index.

## Usage Examples

### Move window to top-left of Work Area

```bash
gdbus call --session \
  --dest org.jidaikobo.shibata.ActiveWindowLayout \
  --object-path /org/jidaikobo/shibata/ActiveWindowLayout \
  --method org.jidaikobo.shibata.ActiveWindowLayout.MoveInWorkArea \
  0 0
```

### Resize window to 1200×600 within Work Area

```bash
gdbus call --session \
  --dest org.jidaikobo.shibata.ActiveWindowLayout \
  --object-path /org/jidaikobo/shibata/ActiveWindowLayout \
  --method org.jidaikobo.shibata.ActiveWindowLayout.ResizeInWorkArea \
  1200 600
```

### Move and resize window

```bash
gdbus call --session \
  --dest org.jidaikobo.shibata.ActiveWindowLayout \
  --object-path /org/jidaikobo/shibata/ActiveWindowLayout \
  --method org.jidaikobo.shibata.ActiveWindowLayout.MoveResizeInWorkArea \
  100 50 1000 700
```

## Installation

```
~/.local/share/gnome-shell/extensions/
└── active-window-layout@jidaikobo.shibata/
    ├── extension.js
    └── metadata.json
```

Enable the extension using GNOME Extensions, or run:

```bash
gnome-extensions enable active-window-layout@jidaikobo.shibata
```

## Intended Use Cases

* Keyboard-driven window layout
* External automation tools
* Consistent window placement across monitors
* Personal window manager–like workflows on GNOME

## Non-Goals

* Managing arbitrary windows by ID
* Replacing GNOME Shell’s window manager
* Providing a graphical UI

This extension is intentionally small, focused, and stable.

## License

MIT License

## Author

jidaikobo-shibata