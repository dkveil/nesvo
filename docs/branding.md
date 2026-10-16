# nesvo branding and compatibility

The project owner chose **nesvo** on October 16, 2026.

- Product and app display name: **nesvo**.
- GitHub repository: [dkveil/nesvo](https://github.com/dkveil/nesvo).
- npm workspace name: `nesvo` (private application package).
- Native terminal client: `nesvo`; host: `nesvo-host`.
- The mobile UI currently uses Polish labels; repository documentation and code comments use English. A navigation label such as “Sesje” means “Sessions” and is not a separate product name.

The rename preserves compatibility identifiers deliberately:

- The EAS project ID, owner and slug retain their current values. Renaming the product does not create a new cloud project.
- Existing native bundle/application IDs and the URL scheme remain unchanged in this iteration. Changing them is an installation/deep-link migration, not a cosmetic rename.
- SecureStore keys, default legacy host data directories and existing host environment variables remain readable so users do not lose pairing or configuration.
- Pairing and encrypted transport formats do not change because of the product name.

Future identifier migrations must read existing data and preserve documented upgrade behavior. Do not replace legacy strings globally without checking their role.
