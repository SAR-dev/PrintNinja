import type { RenderEngineStatus } from "@/lib/agent/types";

/**
 * What to tell someone whose PC has no print browser. Pure data, so the
 * dialog stays a thin view and the per-distro advice is unit-testable.
 *
 * Windows renders through Edge (`msedge.exe`), Linux through any
 * Chromium-family browser found on PATH (see `find_edge` / `find_chromium`
 * in src-tauri/src/render/mod.rs).
 */

export const EDGE_DOWNLOAD_URL = "https://www.microsoft.com/edge/download";
export const CHROME_DOWNLOAD_URL = "https://www.google.com/chrome/";

export const WINDOWS_WINGET_COMMAND = "winget install --id Microsoft.Edge -e";

export type LinuxFamily =
  | "ubuntu"
  | "debian"
  | "fedora"
  | "arch"
  | "suse"
  | "alpine"
  | "generic";

export interface LinuxInstall {
  family: LinuxFamily;
  /** One copy-pasteable shell snippet. */
  command: string;
  /** Ubuntu's `chromium` is a Snap, which the app may not be able to drive. */
  avoidSnap: boolean;
}

const FAMILIES: ReadonlyArray<[LinuxFamily, readonly string[]]> = [
  // Ubuntu before Debian: Ubuntu-based distros list both in ID_LIKE.
  ["ubuntu", ["ubuntu", "linuxmint", "pop", "elementary", "zorin"]],
  ["debian", ["debian", "raspbian", "kali"]],
  ["fedora", ["fedora", "rhel", "centos", "rocky", "almalinux"]],
  ["arch", ["arch", "manjaro", "endeavouros"]],
  [
    "suse",
    ["opensuse", "opensuse-leap", "opensuse-tumbleweed", "suse", "sles"],
  ],
  ["alpine", ["alpine"]],
];

const COMMANDS: Record<LinuxFamily, string> = {
  // Chromium in Ubuntu's archive is a Snap shim; Google's .deb is a normal
  // package, and installing it with apt pulls in its dependencies.
  ubuntu:
    "wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb\nsudo apt install ./google-chrome-stable_current_amd64.deb",
  debian: "sudo apt update\nsudo apt install chromium",
  fedora: "sudo dnf install chromium",
  arch: "sudo pacman -S chromium",
  suse: "sudo zypper install chromium",
  alpine: "sudo apk add chromium",
  generic:
    "# Install any one of: chromium, google-chrome-stable, microsoft-edge-stable\n# with your distribution's package manager.",
};

/** The install snippet for this distribution (`ID` first, then `ID_LIKE`). */
export function linuxInstall(distro: readonly string[]): LinuxInstall {
  for (const id of distro) {
    for (const [family, ids] of FAMILIES) {
      if (ids.includes(id)) {
        return {
          family,
          command: COMMANDS[family],
          avoidSnap: family === "ubuntu",
        };
      }
    }
  }
  return { family: "generic", command: COMMANDS.generic, avoidSnap: false };
}

/** Run the app against a browser that is not on PATH (AppImage example). */
export function linuxOverrideCommand(appimage: boolean): string {
  const bin = appimage ? "./PrintNinja.AppImage" : "printninja";
  return `PRINTNINJA_CHROMIUM_BIN=/path/to/chrome ${bin}`;
}

/** True when the dialog has something to say for this status. */
export function needsBrowserHelp(s: RenderEngineStatus | null): boolean {
  return (
    !!s && !s.available && (s.platform === "windows" || s.platform === "linux")
  );
}
