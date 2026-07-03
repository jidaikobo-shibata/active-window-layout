## 0.2.1

- Changed `extension.js` indentation to 4 spaces for GNOME Shell extension review consistency.
- Added `version: 3` metadata for the next extensions.gnome.org package.

## 0.2.0

- BREAKING: Changed the D-Bus interface name, bus name, and object path to the `org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout` namespace for GNOME Extensions review compliance.
- Existing external callers must update `--dest`, `--object-path`, and `--method`.
- Added `version: 2` metadata for the next extensions.gnome.org package.
- Updated README examples for the new D-Bus name.
- Fixed indentation in `extension.js`.
- Added GNOME Shell 50 compatibility metadata for Ubuntu 26.04 LTS.

## 0.1.0
- Initial release
- Work Area–based window layout via D-Bus
- Semantic positioning API
