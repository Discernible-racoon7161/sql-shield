# Contributing to sql-shield

Thanks for your interest in contributing!

## How to contribute

1. **Fork** the repo and create a branch from `main`
2. **Write tests** for any new functionality
3. **Run tests** before submitting: `npm test`
4. **Open a PR** with a clear description of what you changed and why

## Development setup

```bash
git clone https://github.com/davoroh/sql-shield.git
cd sql-shield
npm install
npm test
```

### Integration tests

Integration tests require a running PostgreSQL instance:

```bash
# Set up the test schema
psql -f test/fixtures/setup.sql

# Run integration tests
npm run test:integration
```

## Guidelines

- **Zero dependencies** — core validate/fixup/bind must not add npm dependencies
- **ES modules** — use `import`/`export`, not `require`
- **Node.js built-in test runner** — no test frameworks needed
- **Security first** — if in doubt, block the query rather than allow it

## Reporting security issues

See [SECURITY.md](SECURITY.md) for responsible disclosure policy.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
