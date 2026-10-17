import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import Network
import UniformTypeIdentifiers
@preconcurrency import ScreenCaptureKit

// US ANSI virtual keycodes (kVK_*). glyphs[i] -> codes[i].
enum Keys {
  static let glyphs = Array("abcdefghijklmnopqrstuvwxyz1234567890 -=[]\\;',./`")
  static let codes: [CGKeyCode] = [
    0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04, 0x22, 0x26, 0x28, 0x25, 0x2E, 0x2D, 0x1F,
    0x23, 0x0C, 0x0F, 0x01, 0x11, 0x20, 0x09, 0x0D, 0x07, 0x10, 0x06,
    0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19, 0x1D,
    0x31, 0x1B, 0x18, 0x21, 0x1E, 0x2A, 0x29, 0x27, 0x2B, 0x2C, 0x2F, 0x32,
  ]
  static let shifted: [Character: Character] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
    "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";",
    "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
  ]

  static func resolve(_ name: String) -> (CGKeyCode, Bool)? {
    switch name {
    case "escape": return (0x35, false) // kVK_Escape
    case "enter": return (0x24, false) // kVK_Return
    case "tab": return (0x30, false) // kVK_Tab
    case "left": return (0x7B, false) // kVK_LeftArrow
    case "right": return (0x7C, false) // kVK_RightArrow
    case "down": return (0x7D, false) // kVK_DownArrow
    case "up": return (0x7E, false) // kVK_UpArrow
    case "f1": return (0x7A, false) // kVK_F1
    case "slash": return (0x2C, false) // kVK_ANSI_Slash
    default: break
    }
    guard name.count == 1, let ch = name.first else { return nil }
    if let i = glyphs.firstIndex(of: ch) { return (codes[i], false) }
    let lower = Character(ch.lowercased())
    if lower != ch, let i = glyphs.firstIndex(of: lower) { return (codes[i], true) }
    if let base = shifted[ch], let i = glyphs.firstIndex(of: base) { return (codes[i], true) }
    return nil
  }
}

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

struct Win: Sendable {
  var id: UInt32
  var app, bundleId, title: String
  var pid: Int
  var x, y, w, h: Double
  var area: Double { w * h }
  var json: [String: Any] {
    ["id": Int(id), "app": app, "bundleId": bundleId, "pid": pid, "title": title, "x": x, "y": y, "w": w, "h": h]
  }
}

struct Shot: Sendable {
  var path: String
  var w, h: Int
  var windowId: UInt32
  var x, y, fw, fh: Double
  var json: [String: Any] {
    ["path": path, "w": w, "h": h, "windowId": Int(windowId), "frame": ["x": x, "y": y, "w": fw, "h": fh]]
  }
}

func health() -> [String: Any] {
  ["ok": true, "screen": CGPreflightScreenCaptureAccess(), "ax": AXIsProcessTrusted()]
}

func shareable() async throws -> SCShareableContent {
  try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
}

// Off-screen windows (another Space) are still capturable and reachable by pid.
func usable(_ s: SCWindow) -> Bool { s.windowLayer == 0 && s.frame.width > 100 && s.frame.height > 100 }

// Non-zero: deliver input straight to this process instead of the global HID
// stream, so a window on another Space can be driven without moving the cursor.
var eventTargetPid: pid_t = 0

func send(_ ev: CGEvent?) {
  guard let ev else { return }
  if eventTargetPid != 0 { ev.postToPid(eventTargetPid) } else { ev.post(tap: .cghidEventTap) }
}

func mapWin(_ s: SCWindow) -> Win {
  Win(
    id: s.windowID,
    app: s.owningApplication?.applicationName ?? "",
    bundleId: s.owningApplication?.bundleIdentifier ?? "",
    title: s.title ?? "",
    pid: Int(s.owningApplication?.processID ?? 0),
    x: s.frame.origin.x, y: s.frame.origin.y,
    w: s.frame.size.width, h: s.frame.size.height)
}

func matches(_ w: Win, _ app: String) -> Bool {
  w.app.range(of: app, options: .caseInsensitive) != nil
    || w.bundleId.range(of: app, options: .caseInsensitive) != nil
}

func pick(_ wins: [Win], app: String, window: UInt32?) throws -> Win {
  let hit = wins.filter { matches($0, app) }
  if let window {
    guard let w = hit.first(where: { $0.id == window }) else { throw HelperError("window \(window) not matched") }
    return w
  }
  guard let w = hit.max(by: { $0.area < $1.area }) else { throw HelperError("no window matching \(app)") }
  return w
}

// Quartz global space (primary display top-left, y down) — same for SCWindow.frame and CGEvent.
func point(_ w: Win, _ x: Double, _ y: Double) -> CGPoint { CGPoint(x: w.x + x, y: w.y + y) }

func backingScale(_ w: Win) -> CGFloat {
  let primaryH = Double((NSScreen.screens.first ?? NSScreen.main)?.frame.height ?? CGFloat(w.h))
  let center = CGPoint(x: w.x + w.w / 2, y: primaryH - (w.y + w.h / 2))
  return NSScreen.screens.first { $0.frame.contains(center) }?.backingScaleFactor
    ?? NSScreen.main?.backingScaleFactor ?? 2
}

func writePNG(_ image: CGImage, to path: String) throws {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
    throw HelperError("cannot write \(path)")
  }
  CGImageDestinationAddImage(dest, image, nil)
  if !CGImageDestinationFinalize(dest) { throw HelperError("png finalize failed") }
}

func capture(app: String, window: UInt32?, out: String, native: Bool) async throws -> Shot {
  guard out.hasPrefix("/"), out.lowercased().hasSuffix(".png") else { throw HelperError("out must be an absolute .png path") }
  let content = try await shareable()
  let win = try pick(content.windows.filter(usable).map(mapWin), app: app, window: window)
  guard let sc = content.windows.first(where: { $0.windowID == win.id }) else { throw HelperError("window gone") }
  let scale = native ? backingScale(win) : 1
  let cfg = SCStreamConfiguration()
  cfg.width = max(1, Int((win.w * scale).rounded()))
  cfg.height = max(1, Int((win.h * scale).rounded()))
  cfg.showsCursor = false
  cfg.ignoreShadowsSingleWindow = true
  cfg.captureResolution = .best
  let filter = SCContentFilter(desktopIndependentWindow: sc)
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
  try writePNG(image, to: out)
  return Shot(path: out, w: image.width, h: image.height, windowId: win.id, x: win.x, y: win.y, fw: win.w, fh: win.h)
}

func postMouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton) {
  let ev = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: p, mouseButton: button)
  if type == .leftMouseDown || type == .rightMouseDown { ev?.setIntegerValueField(.mouseEventClickState, value: 1) }
  send(ev)
}

func postKey(_ code: CGKeyCode, shift: Bool, down: Bool) {
  let src = CGEventSource(stateID: .hidSystemState)
  if shift && down { send(CGEvent(keyboardEventSource: src, virtualKey: 0x38, keyDown: true)) } // kVK_Shift
  let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
  if shift { ev?.flags = .maskShift }
  send(ev)
  if shift && !down { send(CGEvent(keyboardEventSource: src, virtualKey: 0x38, keyDown: false)) }
}

func postText(_ text: String) {
  let src = CGEventSource(stateID: .hidSystemState)
  for ch in text {
    let units = Array(String(ch).utf16)
    units.withUnsafeBufferPointer { buf in
      guard let base = buf.baseAddress else { return }
      for down in [true, false] {
        let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
        ev?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
        send(ev)
      }
    }
  }
}

func num(_ d: [String: Any], _ k: String) -> Double? { (d[k] as? NSNumber)?.doubleValue }

func input(app: String, actions: [[String: Any]]) async throws {
  let needsAX = actions.contains { ["move", "click", "key", "text"].contains($0["type"] as? String ?? "") }
  if needsAX && !AXIsProcessTrusted() { throw HelperError("accessibility not trusted") }
  let wins = try await shareable().windows.filter(usable).map(mapWin)
  let win = try pick(wins, app: app, window: nil)
  let onScreen = try await shareable().windows.first { $0.windowID == win.id }?.isOnScreen ?? false
  eventTargetPid = onScreen ? 0 : pid_t(win.pid)
  defer { eventTargetPid = 0 }
  for a in actions {
    switch a["type"] as? String ?? "" {
    case "move":
      guard let x = num(a, "x"), let y = num(a, "y") else { throw HelperError("move needs x,y") }
      postMouse(.mouseMoved, point(win, x, y), .left)
    case "click":
      guard let x = num(a, "x"), let y = num(a, "y") else { throw HelperError("click needs x,y") }
      let right = (a["button"] as? String) == "right"
      let p = point(win, x, y)
      // Games sample input once per frame: a press shorter than a few frames,
      // or one not preceded by a hover at the same point, is dropped.
      postMouse(.mouseMoved, p, .left)
      try await Task.sleep(nanoseconds: 60_000_000)
      postMouse(right ? .rightMouseDown : .leftMouseDown, p, right ? .right : .left)
      try await Task.sleep(nanoseconds: 80_000_000)
      postMouse(right ? .rightMouseUp : .leftMouseUp, p, right ? .right : .left)
    case "key":
      guard let name = a["key"] as? String, let (code, shift) = Keys.resolve(name) else { throw HelperError("bad key") }
      postKey(code, shift: shift, down: true)
      try await Task.sleep(nanoseconds: 60_000_000)
      postKey(code, shift: shift, down: false)
    case "text":
      guard let text = a["text"] as? String else { throw HelperError("text needs text") }
      postText(text)
    case "wait":
      try await Task.sleep(nanoseconds: UInt64(max(0, num(a, "ms") ?? 0) * 1_000_000))
    case "activate":
      let ok = NSRunningApplication(processIdentifier: pid_t(win.pid))?.activate(options: .activateAllWindows) ?? false
      if !ok { throw HelperError("activate failed") }
    default:
      throw HelperError("unknown action")
    }
  }
}

func pct(_ raw: Substring) -> String {
  let plus = raw.replacingOccurrences(of: "+", with: " ")
  return plus.removingPercentEncoding ?? plus
}

func parseQuery(_ raw: String) -> [String: String] {
  var out: [String: String] = [:]
  guard !raw.isEmpty else { return out }
  for pair in raw.split(separator: "&") {
    let bits = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
    out[pct(bits[0])] = bits.count > 1 ? pct(bits[1]) : ""
  }
  return out
}

@MainActor
final class Conn {
  let conn: NWConnection
  var buf = Data()
  var done = false
  init(_ conn: NWConnection) { self.conn = conn }

  func start() {
    Server.shared.live[ObjectIdentifier(self)] = self
    conn.stateUpdateHandler = { [weak self] state in
      if case .ready = state { Task { @MainActor in self?.recv() } }
      if case .failed = state { Task { @MainActor in self?.finish() } }
    }
    conn.start(queue: .main)
  }

  func recv() {
    guard !done else { return }
    conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      Task { @MainActor in
        guard let self, !self.done else { return }
        if let data { self.buf.append(data) }
        if self.buf.count > 1_048_576 { self.reply(400, "Bad Request", ["error": "too large"]); return }
        if let req = self.parse() { await self.handle(req); return }
        if error != nil || isComplete { self.reply(400, "Bad Request", ["error": "incomplete"]); return }
        self.recv()
      }
    }
  }

  struct Req { var method, path: String; var query: [String: String]; var body: Data }

  func parse() -> Req? {
    guard let sep = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    guard let head = String(data: buf[..<sep.lowerBound], encoding: .utf8) else { return nil }
    let lines = head.split(separator: "\r\n", omittingEmptySubsequences: false)
    let parts = lines.first?.split(separator: " ") ?? []
    guard parts.count >= 2 else { return nil }
    var length = 0
    for line in lines.dropFirst() {
      let kv = line.split(separator: ":", maxSplits: 1)
      if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
        length = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
      }
    }
    let bodyStart = sep.upperBound
    guard buf.distance(from: bodyStart, to: buf.endIndex) >= length else { return nil }
    let target = String(parts[1])
    let bits = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let query = bits.count > 1 ? parseQuery(String(bits[1])) : [:]
    return Req(method: String(parts[0]), path: String(bits[0]), query: query, body: Data(buf[bodyStart..<(buf.index(bodyStart, offsetBy: length))]))
  }

  func handle(_ req: Req) async {
    do {
      switch (req.method, req.path) {
      case ("GET", "/health"):
        reply(200, "OK", health())
      case ("GET", "/request-permissions"):
        _ = CGRequestScreenCaptureAccess()
        let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(prompt)
        reply(200, "OK", health())
      case ("GET", "/windows"):
        let wins = try await shareable().windows.filter(usable).map(mapWin)
        reply(200, "OK", wins.map(\.json))
      case ("GET", "/capture"):
        guard let app = req.query["app"], !app.isEmpty else { throw HelperError("missing app") }
        guard let out = req.query["out"] else { throw HelperError("missing out") }
        let scale = req.query["scale"] ?? "native"
        guard scale == "native" || scale == "1" else { throw HelperError("scale must be native or 1") }
        let id = req.query["window"].flatMap { UInt32($0) }
        if req.query["window"] != nil && id == nil { throw HelperError("bad window id") }
        reply(200, "OK", try await capture(app: app, window: id, out: out, native: scale != "1").json)
      case ("POST", "/input"):
        guard let obj = try JSONSerialization.jsonObject(with: req.body) as? [String: Any],
              let app = obj["app"] as? String,
              let actions = obj["actions"] as? [[String: Any]] else { throw HelperError("bad json") }
        try await input(app: app, actions: actions)
        reply(200, "OK", ["ok": true])
      default:
        reply(404, "Not Found", ["error": "not found"])
      }
    } catch {
      reply(500, "Error", ["error": (error as? HelperError)?.description ?? (error as NSError).localizedDescription])
    }
  }

  func reply(_ status: Int, _ reason: String, _ obj: Any) {
    guard !done else { return }
    done = true
    let body = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"encode\"}".utf8)
    var raw = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
    raw.append(body)
    let c = conn
    c.send(content: raw, completion: .contentProcessed { _ in c.cancel() })
    finish()
  }

  func finish() {
    done = true
    Server.shared.live.removeValue(forKey: ObjectIdentifier(self))
  }
}

@MainActor
final class Server {
  static let shared = Server()
  var listener: NWListener?
  var live: [ObjectIdentifier: Conn] = [:]

  func start() throws {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: 47800)!)
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { conn in Task { @MainActor in Conn(conn).start() } }
    listener.stateUpdateHandler = { state in
      if case .failed(let error) = state { fputs("UILabHelper: \(error)\n", stderr) }
    }
    listener.start(queue: .main)
    self.listener = listener
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    do { try Server.shared.start() }
    catch {
      fputs("UILabHelper: \(error)\n", stderr)
      NSApp.terminate(nil)
    }
  }
}

let keeper = AppDelegate()

@main
enum Entry {
  static func main() {
    if Keys.glyphs.count != Keys.codes.count {
      fputs("UILabHelper: keymap \(Keys.glyphs.count) != \(Keys.codes.count)\n", stderr)
      exit(1)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.delegate = keeper
    app.run()
  }
}
