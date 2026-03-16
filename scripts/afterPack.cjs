// electron-builder afterPack hook
// Strips macOS extended attributes (resource forks) from the packaged app
// before codesigning starts. Without this, codesign fails with:
// "resource fork, Finder information, or similar detritus not allowed"

const { execSync } = require("child_process");

exports.default = async function (context) {
  if (process.platform !== "darwin") return;

  const appOutDir = context.appOutDir;

  // dot_clean removes ._ resource fork files that cause codesign to fail
  console.log(`  • running dot_clean on ${appOutDir}`);
  try {
    execSync(`dot_clean "${appOutDir}"`, { stdio: "inherit" });
  } catch (e) {
    console.log(`  • dot_clean warning (non-fatal): ${e.message}`);
  }

  // Strip all extended attributes recursively
  console.log(`  • stripping extended attributes from ${appOutDir}`);
  execSync(`xattr -cr "${appOutDir}"`, { stdio: "inherit" });

  // Also strip from individual Electron Helper binaries (names with spaces/parens)
  try {
    execSync(
      `find "${appOutDir}" -name "*.app" -exec xattr -cr {} \\;`,
      { stdio: "inherit" }
    );
  } catch (e) {
    // non-fatal
  }
};
