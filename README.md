# AivudaOS Electron Shell

`aivuda_electron_shell` is a lightweight Electron desktop shell for opening AivudaOS and AivudaOS-hosted app panels in a dedicated Chromium window.

It does not install, start, or supervise AivudaOS, PanelHub, Foxglove Studio Embed, Caddy, or any backend services. Start those services through the normal AivudaOS workflow first.

## Install

```bash
npm install
# ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## Run

Open the default local AivudaOS entry:

```bash
npm start
```

Open PanelHub:

```bash
npm start -- http://127.0.0.1/panelhub/ui/
```

Open Foxglove Studio Embed:

```bash
npm start -- http://127.0.0.1/foxglove_studio_embed/ui/
```

You can also set the target with an environment variable:

```bash
AIVUDA_SHELL_URL=http://127.0.0.1/panelhub/ui/ npm start
```

If both are provided, the command-line URL wins over `AIVUDA_SHELL_URL`.

## HTTPS Certificates

For `https://` pages, the shell currently bypasses certificate validation errors and only logs a warning in the Electron process. This is intended for local/self-signed AivudaOS-style deployments where opening the page matters more than strict TLS verification.

## Tabs and Tools

- `Ctrl+T`: open a new tab with the default AivudaOS URL.
- `Ctrl+W`: close the current tab.
- `Ctrl+R`: reload the current tab.
- `Ctrl+L`: show the tab/address controls and focus the address bar.
- `Esc`: hide the tab/address controls.
- Use the address bar to navigate the active tab.
- Links opened with `target="_blank"` or `window.open()` are routed into a new shell tab.
- The shell restores the previous tab list, active tab, and top-bar expanded/collapsed state on the next launch.
- The `Tools` menu can show, hide, or toggle a draggable FPS/GPU overlay inside the active page.
- `Tools -> Clear Browser Data` clears the persistent browser session data and the saved shell state.

The tab/address controls are hidden by default. Use the small button in the top-right corner, the `View` menu, or `Ctrl+L` to expand them.

The FPS/GPU overlay is injected into the active webview page. It estimates FPS with `requestAnimationFrame`; GPU details are collapsed by default and can be expanded from the compact overlay.

## Default URL

The default URL is:

```text
http://127.0.0.1:80
```

If the target page cannot be loaded, the app shows a local offline page with a reload button and the failed target URL.
