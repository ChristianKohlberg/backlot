# 0026. A stack may advertise several logins — `ctx.logins` stays the primary, `allLogins` carries the set

- Status: Accepted
- Date: 2026-07
- Context: a consumer stack seeds seven role logins (admin, branch manager, field
  operative, auditor, partner, read-only, agency), each composing a different
  permission set, data scope and identity restriction. `auth.logins` admitted exactly
  one `{user, password}` and the schema is `additionalProperties: false` at both
  levels, so there was no way to say so — not as a list, not as an extra key, not as a
  sibling. The other six existed only in that repo's seed documentation, which the
  agents reading `ctx` never see. The practical result: everything got driven as the
  admin login, which is the one account that can never expose a scoping bug.
- Relates to: [0014](0014-cli-json-api-mcp-later.md) (the ctx blob is the agent API),
  [0016](0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md) (role
  logins belong to the `dev` baseline)

## Decision

`auth.logins` accepts **either** a single login object (unchanged) **or** a list of
them. A login gains two optional fields: `role`, naming the `{{role}}` an `auth.token`
hook takes, and `description`, saying what the login is *for*.

The ctx blob reports both:

- `logins` — the **primary** login, always a single object, always manifest entry 0.
- `allLogins` — every declared login, in manifest order, present whenever any is
  declared.

A single-login stack therefore reports the same object in both places. That
redundancy is the feature: a consumer enumerating logins never has to ask which form
the manifest used.

## Rationale

**The compatible shape was the cheap one.** Making `logins` itself a list would have
been tidier and would have broken every consumer reading `ctx.logins.user` — including
this repo's own documentation and the skill it ships. Keeping the singular field
meaning *the primary login* costs one extra key and breaks nothing, so the upgrade is
a manifest edit in the stacks that want it and a no-op everywhere else.

**Order is the contract, not a set.** Something has to be primary, and inferring it
(the admin-looking one, the first with no `role`) would be a guess the manifest author
cannot see or override. Manifest position is visible, explicit, and already how the
author thinks about the list.

**`description` is the point, not decoration.** A bare roster of usernames moves the
question rather than answering it — a consumer still cannot tell which login proves a
scoping bug and which merely passes. The field carries the intent that otherwise lives
in a seed script the consumer never reads.

**Still not agent features (0001).** backlot does not create these logins, verify
them, mint sessions for them, or know what a "role" means. The seed makes them; the
manifest declares what exists; `ctx` reports it. This is the same passthrough
`logins` always was, widened.

## Consequences

An empty list is rejected: it claims logins are declared while declaring none, which
is a manifest bug rather than a way to say "no logins" — omitting the key is that.

The manifest is now version-coupled to the daemon that reads it. A stack that adopts
the list form fails validation on an older backlot with `the backlot manifest is
invalid`, which reads as a broken manifest rather than an old install. That is the
existing skew story (0024) reaching the manifest for the first time, and the reason
the single-object form must keep validating indefinitely.
