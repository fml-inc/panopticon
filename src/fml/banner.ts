import pc from "picocolors";

const LOGO_LINES = [
  " ▄██▀   ██▄██▄██  ██",
  " ██     ██ ██ ██  ██",
  "█████   ██    ██  ██",
  " ██     ██    ██  ████",
  " ▀▀     ▀▀    ▀▀  ▀▀▀▀",
];

export function printBanner(): void {
  console.log("");
  for (let i = 0; i < LOGO_LINES.length; i++) {
    const color = i < 3 ? pc.blue : pc.cyan;
    console.log(`  ${color(LOGO_LINES[i])}`);
  }
  console.log("");
}
