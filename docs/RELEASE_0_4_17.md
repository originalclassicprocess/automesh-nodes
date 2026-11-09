# Automesh Nodes 0.4.17

First versioned release built and attested in the clean public repository.
Separate Windows x64, Linux Personal x64/glibc and Server/cPanel packages.
No change to message encryption, authorization, queues or transport behavior.

Windows retains the guided PC / PC + phone setup. Linux retains its terminal
HTTPS setup; a Windows-style Linux wizard and a Mac package are not supplied.
Build verification is not an independent security audit or Windows Authenticode
signature. Keep encrypted state/key backups separately from installers.

Before running a package, verify its GitHub attestation against this repository,
the release.yml workflow, refs/heads/main and the release's exact source commit.
Use a supported Node/OS and read the platform setup documentation.
