# Node editions

Windows Personal, Linux Personal and Server/cPanel are separate adapters of
the shared runtime, not interchangeable installer names.

| Edition | Build / setup |
| --- | --- |
| Windows x64 | `npm run build:windows`, GUI welcome, per-user trust and network actions |
| Linux x64/glibc | `npm run build:linux`, terminal HTTPS setup, CLI/service/web panel |
| Server/cPanel | `adapters/server` / `adapters/passenger`, operator-managed hosting and TLS |
| macOS | No installer or supported setup workflow yet |

Source version is 0.4.16. Previous private distributions: Windows 0.4.16,
Linux/server 0.4.12. New public Actions packages are candidates; no old private
binary or release tag is recreated. [Platform acceptance](PLATFORM_STATUS.md).
