// Starter pages for the apps in lib/context.ts APP_PRESETS: a few well-known default shortcuts each.
// Only plain `keys` steps (editable in the editor like any other key). Shortcuts that depend on the
// keyboard layout ([ ] ` ;) are avoided on purpose. Keys are the app's defaults: users may have rebound them.
export const TEMPLATES = {
  discord: { icon: "💬", color: "violet", keys: [
    ["Mute", "🎙️", "red", "cmd+shift+m"], ["Deafen", "🎧", "amber", "cmd+shift+d"], ["Switcher", "🔎", "blue", "cmd+k"],
  ] },
  zoom: { icon: "🎥", color: "blue", keys: [
    ["Mute", "🎙️", "red", "cmd+shift+a"], ["Video", "📹", "blue", "cmd+shift+v"], ["Share", "🖥️", "green", "cmd+shift+s"],
    ["Chat", "💬", "violet", "cmd+shift+h"], ["People", "👥", "teal", "cmd+u"], ["Leave", "🚪", "red", "cmd+w"],
  ] },
  slack: { icon: "💼", color: "violet", keys: [
    ["Switcher", "🔎", "blue", "cmd+k"], ["Threads", "🧵", "teal", "cmd+shift+t"], ["DMs", "✉️", "green", "cmd+shift+k"],
    ["Unreads", "🔔", "amber", "cmd+shift+a"], ["Mentions", "@", "pink", "cmd+shift+m"],
  ] },
  safari: { icon: "🧭", color: "blue", keys: [
    ["New tab", "➕", "green", "cmd+t"], ["Close tab", "✖️", "red", "cmd+w"], ["Reopen", "↩️", "amber", "cmd+shift+t"],
    ["Reload", "🔄", "teal", "cmd+r"], ["Back", "◀️", "slate", "cmd+left"], ["Forward", "▶️", "slate", "cmd+right"],
    ["Address", "🔗", "blue", "cmd+l"], ["Dev tools", "🛠️", "violet", "cmd+alt+i"],
  ] },
  chrome: { icon: "🌐", color: "green", keys: [
    ["New tab", "➕", "green", "cmd+t"], ["Close tab", "✖️", "red", "cmd+w"], ["Reopen", "↩️", "amber", "cmd+shift+t"],
    ["Reload", "🔄", "teal", "cmd+r"], ["Back", "◀️", "slate", "cmd+left"], ["Forward", "▶️", "slate", "cmd+right"],
    ["Address", "🔗", "blue", "cmd+l"], ["Dev tools", "🛠️", "violet", "cmd+alt+i"],
  ] },
  terminal: { icon: "⌨️", color: "green", keys: [
    ["New tab", "➕", "green", "cmd+t"], ["Close tab", "✖️", "red", "cmd+w"], ["Clear", "🧹", "teal", "cmd+k"], ["Ctrl-C", "⛔", "amber", "ctrl+c"],
  ] },
  xcode: { icon: "🔨", color: "blue", keys: [
    ["Build", "🔨", "blue", "cmd+b"], ["Run", "▶️", "green", "cmd+r"], ["Stop", "⏹️", "red", "cmd+."],
    ["Test", "🧪", "violet", "cmd+u"], ["Clean", "🧹", "amber", "cmd+shift+k"], ["Open quickly", "🔎", "teal", "cmd+shift+o"],
  ] },
  vscode: { icon: "🧩", color: "blue", keys: [
    ["Palette", "⌘", "violet", "cmd+shift+p"], ["Open file", "📂", "blue", "cmd+p"], ["Sidebar", "🗂️", "teal", "cmd+b"],
    ["Panel", "🪟", "green", "cmd+j"], ["Save", "💾", "amber", "cmd+s"], ["Search", "🔎", "pink", "cmd+shift+f"],
  ] },
  finder: { icon: "📁", color: "teal", keys: [
    ["New window", "🪟", "blue", "cmd+n"], ["New folder", "📁", "green", "cmd+shift+n"], ["Go to", "🧭", "violet", "cmd+shift+g"],
    ["Get info", "ℹ️", "teal", "cmd+i"], ["Hidden", "👁️", "amber", "cmd+shift+."],
  ] },
};
