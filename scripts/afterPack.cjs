// electron-builder afterPack hook
// Strips macOS extended attributes (resource forks) from the packaged app
// before codesigning starts. Without this, codesign fails with:
// "resource fork, Finder information, or similar detritus not allowed"

const { execSync } = require("child_process");

exports.default = async function (context) {
  if (process.platform !== "darwin") return;

  const appOutDir = context.appOutDir;
  console.log(`  • stripping extended attributes from ${appOutDir}`);
  execSync(`xattr -cr "${appOutDir}"`, { stdio: "inherit" });
};
