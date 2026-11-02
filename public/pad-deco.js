// Ono-Sendai decoration: no pad data, no logic. If this file is missing the pad works the same.
import { h } from "/assets/common.js";

const KANA = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789";
const rnd = (a, b) => a + Math.random() * (b - a);
const glyph = () => KANA[Math.floor(Math.random() * KANA.length)];
const cube = () => h("div", { class: "cube" }, h("i"), h("i"), h("i"), h("i"), h("i"), h("i"));

const deco = h("div", { class: "deco", "aria-hidden": "true" });
document.body.prepend(deco);

// Katakana rain: few columns (negligible cost even on the Duet), rebuilt when the screen rotates.
function buildRain() {
  deco.querySelectorAll(".col").forEach((c) => c.remove());
  const n = Math.min(14, Math.floor(innerWidth / 80));
  for (let i = 0; i < n; i++) {
    const col = h("div", { class: "col" }, Array.from({ length: 30 }, glyph).join("\n"));
    col.style.left = `${((i + rnd(0, 0.6)) / n) * 100}%`;
    col.style.fontSize = `${rnd(13, 19).toFixed(0)}px`;
    col.style.opacity = rnd(0.12, 0.28).toFixed(2);
    col.style.animationDuration = `${rnd(9, 21).toFixed(1)}s`;
    col.style.animationDelay = `-${rnd(0, 20).toFixed(1)}s`;
    deco.append(col);
  }
}
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildRain, 250);
});
buildRain();

// Wireframe constructs in the distance (behind the board).
for (const [left, top] of [["5%", "62%"], ["78%", "68%"]]) {
  const far = h("div", { class: "far" }, cube());
  far.style.left = left;
  far.style.top = top;
  deco.append(far);
}

document.body.append(
  ...["tl", "tr", "bl", "br"].map((p) => h("div", { class: `corner ${p}`, "aria-hidden": "true" })),
  h("div", { class: "noise", "aria-hidden": "true" }),
);

// HUD
const clock = h("span", { class: "clock" });
const tick = () => {
  clock.textContent = new Date().toTimeString().slice(0, 8);
};
tick();
setInterval(tick, 1000);
document.querySelector(".app")?.prepend(
  h("header", { class: "hud" },
    h("span", { class: "brand" }, "ONO-SENDAI ", h("b", {}, "CYBERSPACE 7")),
    h("span", { class: "sp" }),
    clock,
    h("span", { class: "sp" }),
    h("span", { class: "geo" }, "NODE ", h("em", {}, location.hostname), " · CHIBA 35.607N 140.106E"),
    h("div", { class: "cube-wrap" }, cube()),
  ),
);

// Katakana tag on every key; the board is rebuilt on every page/config change.
function tagTiles(grid) {
  grid.querySelectorAll(".tile:not([data-deco])").forEach((t, i) => {
    t.dataset.deco = "1";
    t.querySelector(".front")?.append(h("span", { class: "tag" }, `ｱｸｾｽ-${String(i + 1).padStart(2, "0")}`));
  });
}
const grid = document.getElementById("grid");
if (grid) {
  new MutationObserver(() => tagTiles(grid)).observe(grid, { childList: true });
  tagTiles(grid);
}

// Boot on power-up; a tap skips it.
const boot = h("div", { class: "boot", "aria-hidden": "true" },
  h("p", {}, "ONO-SENDAI CYBERSPACE 7"),
  h("p", {}, "> JACKING IN …"),
  h("p", {}, "> ICE ........ BYPASSED"),
  h("p", {}, "> SPRAWL LINK ESTABLISHED"),
  h("p", {}, "THE SKY ABOVE THE PORT WAS THE COLOR OF TELEVISION, TUNED TO A DEAD CHANNEL."),
);
const endBoot = () => boot.remove();
boot.addEventListener("animationend", (e) => e.animationName === "bootout" && endBoot());
boot.addEventListener("click", endBoot); // click (not pointerdown): the release must not land on a key underneath
document.body.append(boot);
