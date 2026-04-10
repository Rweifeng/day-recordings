const { spawnSync } = require("child_process");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const outputDir = `release-${timestamp()}`;
const args = [
  "electron-builder",
  "--win",
  "nsis",
  "--publish",
  "never",
  "--config.directories.output=" + outputDir,
  "--config.artifactName=day-recordings-${version}-${arch}-nsis.${ext}",
];

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

console.log(`Build output directory: ${outputDir}`);
const result = spawnSync("npx", args, { stdio: "inherit", shell: true, env });
process.exit(result.status || 0);
