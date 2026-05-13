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

## Default URL

The default URL is:

```text
http://127.0.0.1:80
```

If the target page cannot be loaded, the app shows a local offline page with a reload button and the failed target URL.
