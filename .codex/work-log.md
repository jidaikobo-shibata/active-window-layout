## 2026-05-05

- Did: Added GNOME Shell 50 to `metadata.json` and documented the compatibility update in `CHANGELOG.md`.
- Why: Ubuntu 26.04 LTS uses GNOME Shell 50.x, while the extension metadata only allowed GNOME Shell 45 and 46.
- Incomplete: Runtime behavior on an actual Ubuntu 26.04 / GNOME Shell 50.1 session has not been verified from this workspace.
- Next: Reload the GNOME session on Ubuntu 26.04 and confirm the extension state with `gnome-extensions info active-window-layout@jidaikobo.shibata`.

## 2026-06-26

- Did: Added the repository `url` to `metadata.json` and clarified that the D-Bus API moves/resizes the active window within the Work Area.
- Why: Prepare the extension metadata for publication on extensions.gnome.org with a clear support/reporting URL and description.
- Incomplete: Release ZIP has been created at `/tmp/active-window-layout@jidaikobo.shibata.shell-extension.zip`, but it has not been uploaded yet.
- Next: Upload the ZIP to extensions.gnome.org and respond to any review feedback.
- Follow-up: Ran `shexli` against the ZIP; result was clean with 0 findings, 0 errors, and 0 warnings.
- Follow-up: Added `AGENTS.md` with the repeatable extensions.gnome.org packaging and validation process.
- Follow-up: Uploaded package entered review; expected public URL is `https://extensions.gnome.org/extension/10292/active-window-layout/`.

## 2026-07-03

- Did: Updated the public D-Bus interface name, bus name, object path, and README examples to use the `org.gnome.Shell.Extensions.jidaikobo.shibata.ActiveWindowLayout` namespace.
- Why: Address GNOME Extensions review feedback requiring extension D-Bus interfaces to start with `org.gnome.Shell.Extensions`, while preserving uniqueness with the author namespace.
- Incomplete: Local external callers such as xremap key bindings still need to be updated outside this repository.
- Next: Update local xremap configuration and rebuild the extensions.gnome.org ZIP after the remaining review feedback is handled.
