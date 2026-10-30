# Python rules

Adds to `generic.md`. Match the project's formatter and linter configuration first.

## Code
- Type-hint new public functions. Prefer `pathlib` and context managers over manual cleanup.
- No bare `except:`. No mutable default arguments. No `print` for diagnostics; use the project's logger.
- Read settings from the environment or the project's settings module, never from literals.
- Parameterised queries only. Never build SQL with string formatting.

## Tests
- pytest. One behaviour per test, arrange/act/assert, fixtures over setup copies.
- Name the requirement id in the test name or docstring (`REQ-1`).

## If the project uses Django or DRF
- Every view or viewset sets permission classes explicitly. Validate input in serializers, not in views.
- Avoid N+1 queries: `select_related` and `prefetch_related` where a loop touches relations.
- Wrap multi-write operations in `transaction.atomic`.
- Migrations: expand then contract, reversible, a default for existing rows. Do not edit a merged migration.
- Never log model instances that hold PHI/PII.
