# AivudaOS Electron Shell

This package provides a desktop shell for opening AivudaOS and AivudaOS-hosted app panels in a dedicated Electron window on Ubuntu and other Linux desktops.

It does not install or start AivudaOS itself. Start your AivudaOS services first, then launch the shell.

## Install

Global install:

```bash
npm install -g @aivuda/aivuda-shell
```

One-off run without installing globally:

```bash
npx @aivuda/aivuda-shell
```

If your npm setup uses a custom registry mirror for Electron downloads, keep using that same mirror during installation.

## Start

Open the default local AivudaOS URL:

```bash
aivuda-shell
```

Open a specific target URL:

```bash
aivuda-shell http://127.0.0.1/panelhub/ui/
```

You can also set the startup URL with an environment variable:

```bash
AIVUDA_SHELL_URL=http://127.0.0.1/foxglove_studio_embed/ui/ aivuda-shell
```

If both are provided, the command-line URL wins over `AIVUDA_SHELL_URL`.

## Add To App Menu

On Ubuntu or another Linux desktop, install a launcher into your app menu:

```bash
aivuda-shell-install-desktop
```

This creates a user-level `.desktop` entry under `~/.local/share/applications/` and uses the packaged `assets/aivuda_icon.png` icon.

Remove that launcher later with:

```bash
aivuda-shell-remove-desktop
```

## Keyboard Shortcuts

- `Ctrl+T`: open a new tab
- `Ctrl+W`: close the current tab
- `Ctrl+R`: reload the current tab
- `Ctrl+L`: show or hide the tab bar
- `Esc`: hide the tab bar

## Notes

- Default URL: `http://127.0.0.1:80`
- `https://` certificate errors are currently bypassed for local/self-signed deployments
- `Tools -> Show FPS/GPU Overlay` displays the in-page performance overlay
- `Tools -> Clear Browser Data` clears the persistent browser session data and saved shell state

Developer-oriented setup notes live in `README_dev.md`.
