# Platform verification

P0 separates automated native evidence from the owner's acceptance of the completed product.

| Platform    | P0 evidence                                                                                                                        | Remaining acceptance               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Windows x64 | Local development launch, build, host integrations, Electron smoke, native package and child shutdown passed; clean CI also passed | Damian's P0 acceptance             |
| macOS       | Native runner: clean installation, checks, build, desktop execution, package execution and child shutdown passed                   | Owner access and visual acceptance |
| Linux       | Native runner with Xvfb: clean installation, checks, build, desktop execution, package execution and child shutdown passed         | Owner access and visual acceptance |

Verified toolchain: Bun 1.4.0, standalone Node 24.20.0, Electron 45.2.3 with embedded Node 24.22.2.
The platform workflow checks the foundation on separate Windows, macOS and Linux runners and retains unpacked artifacts.
Runner execution is not a claim that Damian has personally tested the application on that OS.

Evidence for implementation commit d715552, recorded November 7, 2026:

- [Foundation checks: passed](https://github.com/dkveil/nesvo/actions/runs/42381004036).
- [Native checks on all three platforms: passed](https://github.com/dkveil/nesvo/actions/runs/42381038496).
- Each native job ran both the build and unpacked package through the same desktop scenario.
- Local Windows also passed with the development renderer served by Vite.

P8 remains responsible for complete product flows in native packages on each platform: sessions, Stop, history and review.
P0 does not certify provider installation, signing, distribution or the future agent workflow.
