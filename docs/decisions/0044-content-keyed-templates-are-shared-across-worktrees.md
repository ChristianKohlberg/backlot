# 0044. A content-keyed template is shared by every worktree of the same stack name

- Status: Accepted
- Date: 2026-10
- Amends: [0037](0037-cleanup-by-reference-and-pool-doctor.md) — what
  retention keeps; [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md)
  — what `--pristine` drops
- Context: templates were keyed per stack id — manifest name plus worktree
  path — so the same content was baked once per worktree. On the founding
  monorepo's box (2026-10-08): 73 template databases, 5.1 GB, for 24 distinct
  (datastore, preset, key); later the same day, after a retention sweep, 35
  markers naming 2.9 GB for 12 distinct keys (1.6 GB if each were kept once).
  Every new worktree of a pool paid ~70 s of bakes on its first `up` for
  content another worktree had already baked.

## Decision

**What is shared.** A template is shared by every worktree of one manifest
name on this daemon when its key is content-derived: an `@rebake-template`
rule names the datastore, so the key is the `create:` command plus the
content of the files the rule's `when:` matches, by their path relative to
the worktree (vetbill-1i49). Nothing in that key is the worktree path; two
worktrees with the same key bake from the same command and the same declared
inputs. A datastore without such a rule keys on the command string alone —
identical on every branch — and stays per worktree: sharing it would spread
one branch's schema to every other. The safety argument is the one the
template key already rests on inside one worktree: the rule's files are the
declared inputs of the bake. Where the baked result depends on the worktree
beyond them (a seed that writes an absolute path into the data, a script the
rule does not cover), `share_templates: false` keeps the datastore per
worktree. Sharing is therefore the default, opt-out per datastore.

**Where.** Shared templates live in `templates/<name>@shared/` (a manifest
name cannot contain `@`, a stack id is `<name>-<8 chars>`), with the same file
names (`<ds>-<preset>@<key>.baked|.db`). A server template's database is
`backlot_tpl_<name>_shared_<preset>_<hash>` — it names no worktree. The
template lock is keyed by the dir, so bakes of one shared key are single-flight
across worktrees (one bakes, the others wait, then restore) and restores from
it run side by side under the shared lock, as before within one stack.
`pool doctor` knows the dir as a stack of this state root, so its namespaces
are owned, never foreign.

**`--pristine`** distrusts the template. On a shared datastore it no longer
drops the template other worktrees use: it drops this worktree's private
template and bakes a new one, `<ds>-<preset>@<key>.own.baked` in the
worktree's own dir (database `backlot_tpl_<stack>_own_…`). While it exists it
outranks the shared one for that worktree (`--reset-data` restores from it);
retention keeps it only while a row references it, after which the worktree
returns to the shared template.

**Retention.** Per templates dir and per datastore and preset, the newest
`templatesKeep` stay — for `<name>@shared` while any worktree of the name can
be bound — plus every template a row references, plus (new) every template a
live worktree last restored from (`worktrees/<stack>/templates.json`,
written at each restore): with templates shared, "the newest" no longer says
which one a worktree on another branch uses, and an `up` after `destroy`
must stay a restore (0039). Private templates and per-worktree duplicates of
a shared one are never "current". A marker whose database another marker also
names is removed without dropping the database; a bake never reuses a
database name another marker holds (it appends a nonce).

**Migration.** Before a shared template is baked, a per-worktree template of
the same project with the same file name — same datastore, preset and key —
is adopted: its marker is copied into the shared dir (naming the existing
database, keeping its mtime) and no bake runs. The original stays and becomes
a duplicate retention and `pool doctor` collect once nothing references it;
the database stays with the shared marker. The adopted database keeps its old
name, which names a worktree — the one exception to the naming rule, chosen
over a rename the manifest has no command for. Per-worktree templates no
worktree asks for again go as before (superseded, or with their worktree).

## Consequences

- A new worktree of a pool restores on its first `up` whenever another
  worktree already baked its key: on the synthetic revamp-like stack
  (30 s bakes) the second worktree's first `up` went from 36.5 s (32.1 s
  data) to 14.8 s (2.0 s data); four worktrees hold 2 templates instead of 8.
- One template per distinct content key instead of one per worktree: the
  box's 35 markers for 12 keys converge on at most 12 as worktrees `up`.
- The templates of a name are only as safe as its `@rebake-template` rules
  are complete — as before within a worktree, now across worktrees. A rule
  that misses an input now spreads a stale template to every worktree with
  that key instead of one; `--pristine` repairs the worktree that notices,
  and fixing the rule repairs all.
- `--pristine` on a shared datastore costs a bake that other worktrees do
  not share.
