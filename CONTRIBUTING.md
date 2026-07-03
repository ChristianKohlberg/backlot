# Contributing

Thanks for looking at backlot. A few ground rules keep this project what it is:

- **Read [docs/architecture.md](docs/architecture.md) first.** It is short and it is
  the product. PRs that fight the anti-scope (decision 0001) will be declined kindly:
  no compute ownership, no build-system knowledge, no CI features, no agent features.
- **Decisions are recorded, not implied.** Anything that changes the model gets a new
  entry in [docs/decisions/](docs/decisions/) superseding the old one — never an edit
  in place.
- **Policy lives in the engine; transport lives in drivers.** A driver PR that adds
  policy (pooling, hygiene, classification) is a design bug — see
  [docs/driver-spec.md](docs/driver-spec.md).
- **`examples/hello-web` is the contract.** Engine properties are proven as
  integration tests against it, on macOS *and* Linux. If your change can't be
  demonstrated there (or in a new equally-tiny example), that's a signal.
- Node ≥ 22.5, `pnpm install`, `pnpm typecheck && pnpm test` before pushing.
- Agent-authored contributions are welcome and expected — this tool exists for
  agents. The same review bar applies to everyone.
