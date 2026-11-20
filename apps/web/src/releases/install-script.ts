import {
  CHECKSUMS_FILE_NAME,
  DOWNLOAD_TARGETS,
  releaseAssetsUrl,
} from './download-targets';

export const INSTALL_COMMAND_PATH = '/install.sh';

export const installCommandFor = (origin: string): string =>
  `curl -fsSL ${origin}${INSTALL_COMMAND_PATH} | sh`;

export const renderInstallScript = (
  repository: string,
  tagName: string,
): string => `#!/bin/sh
set -eu

BASE_URL="${releaseAssetsUrl(repository, tagName)}"
APP_NAME="Nesvo.app"
TARGET_DIR="/Applications"

fail() {
  printf 'nesvo: %s\\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\\n' "$1"
}

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS. Download Nesvo for other systems from https://nesvo.dev."

case "$(uname -m)" in
  arm64) ASSET="${DOWNLOAD_TARGETS.mac.fileName}" ;;
  x86_64)
    if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
      ASSET="${DOWNLOAD_TARGETS.mac.fileName}"
    else
      ASSET="${DOWNLOAD_TARGETS['mac-intel'].fileName}"
    fi
    ;;
  *) fail "unsupported processor: $(uname -m)." ;;
esac

for tool in curl shasum hdiutil ditto xattr awk; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required."
done

[ -w "$TARGET_DIR" ] || fail "$TARGET_DIR is not writable for this user. Download the disk image from https://nesvo.dev and drag Nesvo to Applications."

if pgrep -x Nesvo >/dev/null 2>&1; then
  fail "Nesvo is running. Quit it and run this command again."
fi

WORK_DIR="$(mktemp -d -t nesvo-install)"
MOUNT_DIR="$WORK_DIR/volume"

cleanup() {
  if [ -d "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

say "Downloading $ASSET"
curl -fL --progress-bar -o "$WORK_DIR/$ASSET" "$BASE_URL/$ASSET" || fail "the download failed. Is a release published yet?"
curl -fsSL -o "$WORK_DIR/${CHECKSUMS_FILE_NAME}" "$BASE_URL/${CHECKSUMS_FILE_NAME}" || fail "the release checksums could not be downloaded."

EXPECTED="$(awk -v name="$ASSET" '$2 == name || $2 == "*" name { print $1 }' "$WORK_DIR/${CHECKSUMS_FILE_NAME}")"
[ -n "$EXPECTED" ] || fail "the release checksums do not list $ASSET."
ACTUAL="$(shasum -a 256 "$WORK_DIR/$ASSET" | awk '{ print $1 }')"
[ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch for $ASSET. Nothing was installed."
say "Checksum verified: $ACTUAL"

mkdir -p "$MOUNT_DIR"
hdiutil attach "$WORK_DIR/$ASSET" -nobrowse -readonly -noautoopen -mountpoint "$MOUNT_DIR" -quiet || fail "the disk image could not be opened."
[ -d "$MOUNT_DIR/$APP_NAME" ] || fail "the disk image does not contain $APP_NAME."

if [ -d "$TARGET_DIR/$APP_NAME" ]; then
  say "Replacing $TARGET_DIR/$APP_NAME"
  rm -rf "$TARGET_DIR/$APP_NAME"
fi
ditto "$MOUNT_DIR/$APP_NAME" "$TARGET_DIR/$APP_NAME"
if ! xattr -drs com.apple.quarantine "$TARGET_DIR/$APP_NAME" 2>/dev/null; then
  ATTRIBUTES="$(xattr -rs "$TARGET_DIR/$APP_NAME")" || fail "could not check quarantine on the installed app."
  case "$ATTRIBUTES" in
    *com.apple.quarantine*) fail "could not clear quarantine. Use System Settings > Privacy & Security > Open Anyway." ;;
  esac
fi

say ""
say "Nesvo is installed in $TARGET_DIR."
say "Open Nesvo from Applications."
say ""
say "Nesvo does not update itself. Run this command again for a new version."
`;
