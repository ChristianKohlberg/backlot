# 0048 — Runly manifest names and separate setup guidance

Accept runly.yml and runly.yaml, preferring runly.yml when both exist in the
same directory. Continue upward discovery from the caller's directory.
Retire backlot.yml and stack.yaml discovery; their presence alone does not
identify a stack. The command alias and BACKLOT_* configuration are unchanged.

The plugin ships two independently discoverable skills: runly for operating
an existing stack and runly-setup for creating and validating manifests.
Keep both aligned with the installed CLI and current schema; bump the plugin
version whenever either changes.
