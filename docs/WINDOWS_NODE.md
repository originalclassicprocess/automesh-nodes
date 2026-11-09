# Windows home node · preview

Windows release 0.4.16. Install over an existing node to retain queues, identity
and certificate trust. The packaged app origin is `https://automesh.online`;
other origins require explicit approval. See [startup/recovery](WINDOWS_HOME_RECOVERY.md).

The Windows x64 package bundles the pinned Node.js runtime and a launcher;
the user does not need npm. Keep the PC awake and signed in for user autostart.

Open the launcher. First run offers **PC** or **PC + phone** and guides each
required action in one window. Healthy completed setups open Overview directly.
Automatic network selection follows Windows Private interfaces; manual selection
is available. Loopback is for this PC, private LAN addresses for home devices.
Explicitly trust only your own node's certificate on connecting devices and
inspect the LAN test result. Firewall permission is a separate explicit action;
do not blindly bypass OS protection. The PC must stay awake for delivery.
Use a pairing invitation for profiles and the ordinary signal QR for a signaling
address. Profile invitations are short-lived secrets, not public share links.

The local control interface stays loopback-only. Keys/configuration use DPAPI
CurrentUser, so keep the same Windows account and retain backups. An app seed
must never be entered into the node launcher. Up to eight profiles may be paired;
disconnect a selected profile to revoke it and free a slot. Confirm deletion:
its queued messages/files are removed, but client accounts/chat history are not.

Current limitations: Windows GUI is still being localized, no Authenticode
publisher signature, no automatic public incoming endpoint/NAT/TURN or background
phone node. An encrypted envelope stored on the node is not yet delivered/read.
