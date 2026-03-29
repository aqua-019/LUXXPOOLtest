# 9layerfiles/

Development reference files used during the v0.7.0 SecurityEngine integration.
These patches have already been applied to the codebase.

| File | Purpose | Applied To |
|------|---------|------------|
| `files` | Integration patch guide for wiring 9-layer SecurityEngine into `src/index.js` | `src/index.js` |
| `files2` | SecurityEngine implementation reference/spec | `src/pool/securityEngine.js` |
| `files3` | SQL migration for security tables (replaces v0.3.x schema) | `migrations/006_security_engine.js` |

These files are retained for reference only and are not imported or used at runtime.
