# Platform status — 8 November 2026

| Platform | Published package | Setup and recovery | Evidence / remaining work |
| --- | --- | --- | --- |
| Windows x64 | 0.4.16 installer | New full-window PC / PC + phone welcome, guided readiness/actions, retained queue/trust and reconnect maintenance | Automated checks and user PC/iPad connection trial; sustained overnight/resume/network-change acceptance still needed |
| Linux x64/glibc Personal | 0.4.12 archive | Existing terminal HTTPS setup, CLI/service controls and web panel | Shared core/Linux CI checks and candidate package build; new Windows-style onboarding/recovery has not been ported; clean-user VM acceptance remains |
| Server/cPanel | 0.4.12 separate archive | Operator setup behind hosting TLS frontend | Separate adapter, not a home desktop wizard or a renamed Linux archive |
| macOS | No packaged node release | No Mac installer, launcher or first-run wizard yet | Shared-core tests run on macOS; this does not validate a supported Mac node installation |

Private CI can build a candidate labelled with the current source version
(including Linux 0.4.16). That is not publication, an installed-node update,
or a claim of matching platform UX. No existing immutable release is replaced.

The browser/PWA messenger is a separate product and can run in a compatible Mac
browser. Browser support does not imply a native Mac home-node package.

Port the workflow, not Windows implementation details: Linux/macOS need their
own lifecycle manager, key storage, certificate trust and permission handling.
Do not copy Windows DPAPI, certificate-store or firewall steps onto other OSes.
