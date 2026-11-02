// Mouse click step → JXA (JavaScript for Automation) that posts CoreGraphics events.
// A double/triple click needs the click-state field set on each down/up pair, otherwise macOS
// sees N separate single clicks; plain AppleScript cannot do that.

export type MouseButton = "left" | "right" | "middle";
export const MOUSE_BUTTONS: MouseButton[] = ["left", "right", "middle"];

export interface ClickArgs {
  button: MouseButton;
  count: number; // 1 = click, 2 = double, 3 = triple
  at: "cursor" | "point";
  x: number;
  y: number;
}

// CGEventType values: left 1/2, right 3/4, other 25/26. CGMouseButton: 0 left, 1 right, 2 center.
const EVENTS: Record<MouseButton, { down: number; up: number; button: number }> = {
  left: { down: 1, up: 2, button: 0 },
  right: { down: 3, up: 4, button: 1 },
  middle: { down: 25, up: 26, button: 2 },
};

// All values are validated numbers/enums by config.ts, so nothing user-typed reaches the script.
export function clickScript(a: ClickArgs): string {
  const ev = EVENTS[a.button];
  const point = a.at === "point" ? `{ x: ${a.x}, y: ${a.y} }` : "$.CGEventGetLocation($.CGEventCreate($()))";
  return `ObjC.import("CoreGraphics");
ObjC.import("unistd");
const p = ${point};
for (let i = 1; i <= ${a.count}; i++) {
  for (const type of [${ev.down}, ${ev.up}]) {
    const e = $.CGEventCreateMouseEvent($(), type, p, ${ev.button});
    $.CGEventSetIntegerValueField(e, 1, i); // kCGMouseEventClickState
    $.CGEventPost(0, e); // kCGHIDEventTap
    $.usleep(20000);
  }
}
void 0; // osascript prints the last expression; keep stdout empty`;
}
