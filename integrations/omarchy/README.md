# Monkey D Loopy for Omarchy

An Omarchy Quattro bar widget for monitoring and controlling the local Monkey D Loopy operator.

## MVP capabilities

- Show installed, active, and attention-needed loops in the bar.
- Inspect the latest run status, iteration, integrity, token usage, and USD usage.
- Run, step, pause, resume, approve, and stop through the authenticated `loopyd` API.
- Open the full Monkey D Loopy Control Center.

The widget never reads the operator token or writes journals. It invokes `loopyd snapshot` and
`loopyd control`, which authenticate to the running loopback operator and preserve its locking,
audit, and runtime safety rules.

## Requirements

- Omarchy Quattro
- Node.js 22 or newer
- `@loopyc/operator` installed globally and available as `loopyd`
- A running local operator with at least one installed standalone artifact

```sh
npm install --global @loopyc/operator
loopyd install ./out/my-loop/standalone
loopyd up --background
```

## Development install

Until this integration is published from a dedicated plugin repository, copy this directory into
Omarchy's user plugin directory:

```sh
PLUGIN_ID="io.github.matrixy.monkey-d-loopy"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"
mkdir -p "$PLUGIN_DIR"
cp integrations/omarchy/{manifest.json,BarWidget.qml,Panel.qml,Model.js} "$PLUGIN_DIR/"
omarchy plugin validate "$PLUGIN_DIR"
qmllint -I "$OMARCHY_PATH/shell" "$PLUGIN_DIR/BarWidget.qml" "$PLUGIN_DIR/Panel.qml"
omarchy plugin enable "$PLUGIN_ID"
```

Saved QML changes reload automatically. If discovery needs a nudge:

```sh
omarchy-shell shell rescanPlugins
```

## Controls

- Left-click the bar item to open or close the panel.
- Right-click to refresh immediately.
- Use the panel buttons for runtime actions.
- Press `r` to refresh or `s` to step the selected loop.

Actions use the actor `omarchy-plugin` and the audit reason `requested from Omarchy control panel`.
The MVP intentionally leaves uncertain-effect recovery and guarded evolution to the full Control
Center, where their additional context can be reviewed safely.

## Publishing note

The Omarchy marketplace requires `manifest.json` at the root of a public GitHub repository. After
the MVP is exercised on an Omarchy machine, this directory should become the root of a dedicated
plugin repository before marketplace submission.
