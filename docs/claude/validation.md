# Claude / Codex Validation Module

## Roles

Claude:
- implementation and architecture
- test-case definition
- minimum essential tests
- fixes after findings

Codex:
- use **Astra**
- execute relevant tests/checks
- review changed code
- inspect regression/security/error-handling risks
- return concise PASS or FAIL

## Loop

Claude implements
→ Codex Astra validates
→ PASS: finish
→ FAIL: Claude fixes
→ Codex Astra validates again

Allow at most 3 automatic re-validations after the first validation.

## Codex Limit Fallback

If Codex cannot run because usage/quota is exhausted:
1. do not block,
2. Claude runs the same relevant tests/checks directly,
3. Claude reviews failures/changes itself,
4. tell the user in Korean that fallback validation was used,
5. complete only when fallback checks pass.

Codex unavailability is never PASS.

Always inspect actual scripts before running commands.
Never invent missing test/lint/build scripts.
