# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in sql-shield, please report it responsibly.

**Email:** [davor@visionquest.ing](mailto:davor@visionquest.ing)

Please include:

1. Description of the vulnerability
2. Steps to reproduce
3. SQL input that triggers the issue
4. Expected vs actual behavior

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## What sql-shield protects against

- **SQL injection via LLM output** — blocks INSERT, UPDATE, DELETE, DROP, and 15+ other dangerous statements
- **Table/column exfiltration** — whitelist enforcement prevents access to unauthorized tables and sensitive columns
- **UNION injection** — blocks UNION queries that combine with unauthorized tables
- **Stacked queries** — blocks multiple statements separated by semicolons
- **Subquery injection** — blocks subqueries in FROM/JOIN that bypass table whitelist
- **Comment-based evasion** — strips SQL comments before validation
- **Full table scans** — enforces row limits (LIMIT)

## What sql-shield does NOT protect against

sql-shield is a validation layer, not a complete security solution. It does NOT:

- **Replace database permissions** — always use a read-only database user with minimal grants
- **Prevent all SQL injection** — regex-based parsing cannot catch every edge case; use it as defense-in-depth alongside parameterized queries
- **Validate SQL semantics** — it checks structure, not whether the query makes business sense
- **Handle authentication/authorization** — that's your application's responsibility

## Recommended security setup

1. **Database user**: Use a read-only user with SELECT-only grants on specific tables
2. **sql-shield validation**: Validate all LLM-generated SQL before execution
3. **Parameterized queries**: Use bind variables (sql-shield helps with this)
4. **Row limits**: Always enforce LIMIT (sql-shield does this automatically)
5. **Audit logging**: Log all queries for compliance and debugging

