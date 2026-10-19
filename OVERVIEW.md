# Auto labels

Adds a label such as `codex · gpt-6.1-sol · max` to each workspace, using its sessions' provider, model, and effort. Existing workspaces are synced on startup, and labels update when those settings change.

Labels belong to workspaces in Paseo. Different main-session configurations get separate labels; identical configurations share one. Subagents are excluded by default and can be included in settings. Background and archived workspaces are excluded.

Requires Paseo 0.11.4 or later and a local loopback listener or local socket on the daemon machine. Use one installation per daemon. No model account or API key is needed. A custom Paseo home can be set under Settings → Plugins → Auto labels.

Pausing keeps the current labels. **Remove generated labels** pauses syncing and removes assignments added by this plugin from active workspaces. Manual labels are preserved. Unused label definitions stay in Paseo's label manager for reuse.

The plugin reads session configuration metadata and workspace label assignments. It connects to its own daemon with Paseo's existing local credential and stores an ownership record on that host so it can replace its own labels after a reload. It does not read conversations or call model providers. Values reflect what Paseo reports, including `model unknown` or `effort unknown` when no value is available; they do not verify which model an external gateway ultimately runs.

If assigned labels are hidden, enable Labels in Paseo's sidebar display options.
