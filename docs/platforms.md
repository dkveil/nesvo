# Platform verification

P0 separates toolchain availability from native acceptance of the completed product.

| Platform    | P0 evidence                                                                                                                | Remaining acceptance                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Windows x64 | Local build, two host integrations, actual Electron smoke, unpacked native package and child shutdown passed on 2026-11-07 | Damian's P0 acceptance                                  |
| macOS       | Manual GitHub Actions job prepared                                                                                         | Native job execution and owner access/visual acceptance |
| Linux       | Manual GitHub Actions job prepared, Xvfb desktop path                                                                      | Native job execution and owner access/visual acceptance |

Verified local toolchain: Bun 1.4.0, standalone Node 24.20.0, Electron 45.2.3 with embedded Node 24.22.2.
The screenshot and command evidence are linked from the P0 issue in Linear.
The platform workflow checks the foundation on separate Windows, macOS and Linux runners and retains unpacked artifacts.
Runner execution is not a claim that Damian has personally tested the application on that OS.

P8 remains responsible for complete product flows in native packages on each platform: sessions, Stop, history and review.
P0 does not certify provider installation, signing, distribution or the future agent workflow.
