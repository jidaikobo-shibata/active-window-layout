## 2026-05-05

- Did: Added GNOME Shell 50 to `metadata.json` and documented the compatibility update in `CHANGELOG.md`.
- Why: Ubuntu 26.04 LTS uses GNOME Shell 50.x, while the extension metadata only allowed GNOME Shell 45 and 46.
- Incomplete: Runtime behavior on an actual Ubuntu 26.04 / GNOME Shell 50.1 session has not been verified from this workspace.
- Next: Reload the GNOME session on Ubuntu 26.04 and confirm the extension state with `gnome-extensions info active-window-layout@jidaikobo.shibata`.
