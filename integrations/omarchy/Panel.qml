import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "io.github.matrixy.monkey-d-loopy"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  property var loops: []
  property string selectedLoopId: ""
  property string loadError: ""
  property string actionMessage: ""
  property string snapshotStdout: ""
  property string snapshotStderr: ""
  property string actionStdout: ""
  property string actionStderr: ""
  property bool loading: true
  property bool refreshQueued: false
  property bool cursorActive: false

  readonly property int loopIndex: Model.selectedIndex(loops, selectedLoopId)
  readonly property var selectedLoop: loopIndex >= 0 ? loops[loopIndex] : null
  readonly property var latestRun: selectedLoop ? selectedLoop.latestRun : null
  readonly property string selectedRunId: selectedLoop && selectedLoop.active
    ? selectedLoop.active.runId : (latestRun ? latestRun.runId : "")
  readonly property bool alarming: loadError !== "" || Model.countAttention(loops) > 0
  readonly property bool busy: actionProcess.running

  function alpha(color, opacity) { return Qt.rgba(color.r, color.g, color.b, opacity) }
  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)) }

  function open() {
    root.controller.show()
    refresh()
  }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? close() : open() }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }

  function syncSelection() {
    if (loops.length === 0) {
      selectedLoopId = ""
      return
    }
    for (var i = 0; i < loops.length; i++)
      if (loops[i].id === selectedLoopId) return
    selectedLoopId = loops[0].id
  }

  function selectLoop(index) {
    if (loops.length === 0) return
    var wrapped = ((index % loops.length) + loops.length) % loops.length
    selectedLoopId = loops[wrapped].id
    cursorActive = true
  }

  function refresh() {
    if (snapshotProcess.running) {
      refreshQueued = true
      return
    }
    refreshQueued = false
    snapshotStdout = ""
    snapshotStderr = ""
    if (loops.length === 0) loading = true
    snapshotProcess.running = true
  }

  function finishRefresh(exitCode) {
    var parsed = Model.parseSnapshot(snapshotStdout)
    if (exitCode === 0 && parsed.ok) {
      loops = parsed.loops
      loadError = ""
      syncSelection()
    } else {
      var detail = snapshotStderr.trim()
      loadError = exitCode === 127
        ? "loopyd is not installed or is not on PATH."
        : (detail !== "" ? detail : parsed.error)
    }
    loading = false
    if (refreshQueued) Qt.callLater(refresh)
  }

  function control(action) {
    if (!selectedLoop || actionProcess.running) return
    var argv = ["/usr/bin/env", "loopyd", "control", selectedLoop.id, action,
      "--actor", "omarchy-plugin", "--reason", "requested from Omarchy control panel"]
    if (["pause", "stop", "resume", "approve"].indexOf(action) >= 0) {
      if (selectedRunId === "") return
      argv.push("--run-id")
      argv.push(selectedRunId)
    }
    actionMessage = "Requesting " + action + "…"
    actionStdout = ""
    actionStderr = ""
    actionProcess.command = argv
    actionProcess.running = true
  }

  function finishAction(exitCode) {
    if (exitCode === 0) actionMessage = "Action accepted by loopyd."
    else actionMessage = actionStderr.trim() || "loopyd rejected the action."
    Qt.callLater(refresh)
  }

  function openControlCenter() {
    if (!dashboardProcess.running) dashboardProcess.running = true
  }

  function barText() { return Model.barLabel(loops, loading, loadError) }
  function tooltipText() {
    if (loadError !== "") return "Monkey D Loopy · unavailable"
    var active = Model.countActive(loops)
    var attention = Model.countAttention(loops)
    if (attention > 0) return "Monkey D Loopy · " + attention + " need attention"
    return "Monkey D Loopy · " + active + " active · " + loops.length + " installed"
  }

  onLoopsChanged: Qt.callLater(syncSelection)
  onOpenedChanged: if (opened) {
    cursorActive = false
    refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Timer {
    interval: 5000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: snapshotProcess
    running: false
    command: ["/usr/bin/env", "loopyd", "snapshot"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.snapshotStdout = text
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.snapshotStderr = text
    }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.finishRefresh(exitCode) })
    }
  }

  Process {
    id: actionProcess
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.actionStdout = text
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.actionStderr = text
    }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.finishAction(exitCode) })
    }
  }

  Process {
    id: dashboardProcess
    running: false
    command: ["/usr/bin/env", "loopyd", "ui", "--open"]
    onExited: function(exitCode) {
      if (exitCode !== 0) root.actionMessage = "Could not open the Control Center."
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.selectLoop(root.loopIndex + dy)
        if (dx !== 0)
          panelFlick.contentY = root.clamp(panelFlick.contentY + dx * Style.space(56), 0,
            Math.max(0, panelFlick.contentHeight - panelFlick.height))
      }
      onActivateRequested: root.refresh()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") root.refresh()
        else if (text === "s" || text === "S") root.control("step")
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: content
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: root.selectedLoop ? root.selectedLoop.id : "Monkey D Loopy"
            meta: root.loading && root.loops.length === 0
              ? "Loading local operator"
              : Model.statusLabel(root.selectedLoop)
            detail: Model.runMetrics(root.selectedLoop)
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: "L"
                color: root.alarming ? root.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
                font.bold: true
              }
            }
          }

          BorderSurface {
            visible: root.loadError !== "" || root.actionMessage !== ""
            width: parent.width
            implicitHeight: messageText.implicitHeight + Style.space(20)
            color: root.alpha(root.loadError !== "" ? root.urgent : root.foreground, 0.08)
            borderSpec: Border.flat(root.alpha(root.loadError !== "" ? root.urgent : root.foreground, 0.25), 1)
            radius: Style.cornerRadius
            Text {
              id: messageText
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)
              text: root.loadError !== "" ? root.loadError : root.actionMessage
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          PanelSectionHeader {
            width: parent.width
            text: "LOOPS"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            visible: !root.loading && root.loadError === "" && root.loops.length === 0
            width: parent.width
            textFormat: Text.PlainText
            text: "No loops are installed in the local operator."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          Repeater {
            model: root.loops
            Button {
              required property var modelData
              required property int index
              width: content.width
              text: modelData.id + "   " + modelData.status
              selected: index === root.loopIndex
              hasCursor: root.cursorActive && index === root.loopIndex
              bordered: true
              leftAlign: true
              foreground: Model.hasAttention(modelData) ? root.urgent : root.foreground
              fontFamily: root.fontFamily
              onClicked: root.selectLoop(index)
              onHovered: function(isHovered) {
                if (isHovered) root.selectLoop(index)
              }
            }
          }

          PanelSectionHeader {
            visible: !!root.selectedLoop
            width: parent.width
            text: "CONTROL"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Grid {
            visible: !!root.selectedLoop
            width: parent.width
            columns: 3
            spacing: Style.space(6)
            readonly property real cellWidth: (width - spacing * 2) / 3

            Button {
              width: parent.cellWidth
              text: "Run"
              bordered: true
              enabled: !root.busy && root.selectedLoop && !root.selectedLoop.active
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.control("run")
            }
            Button {
              width: parent.cellWidth
              text: "Step"
              bordered: true
              enabled: !root.busy && root.selectedLoop && !root.selectedLoop.active
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.control("step")
            }
            Button {
              width: parent.cellWidth
              text: "Pause"
              bordered: true
              enabled: !root.busy && root.selectedLoop && !!root.selectedLoop.active
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.control("pause")
            }
            Button {
              width: parent.cellWidth
              text: "Resume"
              bordered: true
              enabled: !root.busy && root.latestRun
                && ["paused", "stopped", "waiting"].indexOf(root.latestRun.status) >= 0
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.control("resume")
            }
            Button {
              width: parent.cellWidth
              text: "Approve"
              bordered: true
              enabled: !root.busy && root.latestRun && root.latestRun.pendingCap !== ""
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.control("approve")
            }
            Button {
              width: parent.cellWidth
              text: "Stop"
              bordered: true
              enabled: !root.busy && root.selectedLoop && !!root.selectedLoop.active
              foreground: root.urgent
              fontFamily: root.fontFamily
              onClicked: root.control("stop")
            }
          }

          Row {
            width: parent.width
            spacing: Style.space(6)
            Button {
              width: (parent.width - parent.spacing) / 2
              text: root.loading ? "Refreshing…" : "Refresh"
              bordered: true
              enabled: !root.loading
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.refresh()
            }
            Button {
              width: (parent.width - parent.spacing) / 2
              text: "Open Control Center"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.openControlCenter()
            }
          }
        }
      }
    }
  }
}
