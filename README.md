# Google Apps Script Gemini JSON Service

## Architecture overview
- `GeminiJsonService` exposes a single public entrypoint (`generateStructuredJson`) and encapsulates validation, retries, LLM invocation, response parsing, schema validation, logging, and idempotency caching.
- Runtime safety is enforced with a time guard to avoid overrunning Apps Script's 6-minute execution limit.
- Configuration is centralized in `CONFIG`; secrets are read from `PropertiesService` and never hardcoded.

## Deployment instructions
1. Create a new Google Apps Script project.
2. Add `Code.gs` content.
3. In **Project Settings → Script Properties**, set:
   - `GEMINI_API_KEY=<your_api_key>`
4. Run `runGeminiJsonJob` once to authorize script scopes.
5. Wire `GeminiJsonService.generateStructuredJson` into your trigger or web app handler.

## Configuration instructions
- Update `CONFIG.MODEL` to select model version.
- Tune `CONFIG.RETRY` for resilience and latency.
- Tune `CONFIG.LLM.MAX_OUTPUT_TOKENS` and per-request `maxOutputTokens` to control cost/usage.
- Adjust `CONFIG.EXECUTION.GUARD_BUFFER_MS` if your surrounding workflow needs extra cleanup time.
- Provide a strict JSON schema in each call to enforce output contract.

## Known limitations
- Schema validator supports core types (`object`, `array`, `string`, `number`, `boolean`) but not advanced JSON Schema keywords (`oneOf`, `pattern`, numeric bounds).
- Idempotency cache uses `CacheService` TTL and is not permanent storage.
- Long prompts/responses may still hit model or Apps Script limits; token and time guards reduce but do not eliminate this risk.
